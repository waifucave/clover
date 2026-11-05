//! `relay-server`: an iroh relay (iroh-relay 1.4.1's own server) for the netns lab, so the relay
//! questions of report edit 6 are measured rather than read from iroh's source. HTTPS for the
//! relay protocol and QUIC for address discovery (QAD), both on one self-signed certificate whose
//! SHA-256 the info file carries; the lab's endpoints pin it (`--relay-cert-sha256`).
//!
//! ```text
//! clover-link-sidecar relay-server --bind-ip 203.0.113.50 [--https-port 3443] [--http-port 3340]
//!     [--qad-port 7842 | --no-qad] --metrics-file m.json --info-file relay.json
//! ```
//!
//! Every 50 ms it rewrites `--metrics-file` with its counters: `sendPacketsRecv` and
//! `sendPacketsSent` count datagrams relayed between endpoints (a connection's packets going
//! over the relay), `accepts` relay clients, `qadConnections` QUIC address-discovery probes.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use iroh_relay::server::{CertConfig, QuicConfig, RelayConfig, Server, ServerConfig, TlsConfig};
use serde_json::json;

use crate::Args;

/// One self-signed certificate for the relay's address: (DER, PKCS#8 key DER).
fn self_signed(ip: IpAddr) -> Result<(Vec<u8>, Vec<u8>)> {
    let cert = rcgen::generate_simple_self_signed(vec![ip.to_string(), "localhost".to_string()])?;
    Ok((cert.cert.der().to_vec(), cert.signing_key.serialize_der()))
}

fn tls_config(cert: &(Vec<u8>, Vec<u8>), alpn: &[&[u8]]) -> Result<rustls::ServerConfig> {
    let der = rustls::pki_types::CertificateDer::from(cert.0.clone());
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.1.clone().into());
    let mut config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![der], key)?;
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    Ok(config)
}

pub async fn serve(a: &Args) -> Result<()> {
    let ip: IpAddr = a.get_or("bind-ip", "127.0.0.1").parse().context("--bind-ip")?;
    let https = SocketAddr::new(ip, a.num("https-port", 3443));
    let http = SocketAddr::new(ip, a.num("http-port", 3340));
    let qad = if a.flag("no-qad") { None } else { Some(SocketAddr::new(ip, a.num("qad-port", 7842))) };
    let metrics_file = a.get("metrics-file").context("--metrics-file")?;
    let cert = self_signed(ip)?;
    let cert_sha256 = crate::link::hex(ring::digest::digest(&ring::digest::SHA256, &cert.0).as_ref());

    let mut relay = RelayConfig::new(http);
    relay.tls = Some(TlsConfig::new(https, CertConfig::Manual { server_config: tls_config(&cert, &[])? }));
    relay.key_cache_capacity = Some(1024);
    let mut config = ServerConfig::default();
    config.relay = Some(relay);
    if let Some(addr) = qad {
        let mut q = QuicConfig::new(addr);
        // iroh-relay sets the QAD ALPN on this config itself.
        q.server_config = Some(tls_config(&cert, &[])?);
        config.quic = Some(q);
    }
    let server = Server::spawn(config).await.context("start the relay server")?;
    let url = format!("https://{}/", server.https_addr().context("no https address")?);
    let info = json!({
        "url": url,
        "qadPort": server.quic_addr().map(|a| a.port()),
        "http": server.http_addr(),
        "certSha256": cert_sha256,
    });
    if let Some(path) = a.get("info-file") {
        std::fs::write(format!("{path}.tmp"), info.to_string())?;
        std::fs::rename(format!("{path}.tmp"), &path)?;
    }
    eprintln!("relay at {url}, QAD {:?}", server.quic_addr());

    let start = Instant::now();
    let tmp = format!("{metrics_file}.tmp");
    loop {
        let m = &server.metrics().server;
        let snapshot = json!({
            "t": start.elapsed().as_millis() as u64,
            "sendPacketsRecv": m.send_packets_recv.get(),
            "sendPacketsSent": m.send_packets_sent.get(),
            "bytesRecv": m.bytes_recv.get(),
            "bytesSent": m.bytes_sent.get(),
            "otherPacketsRecv": m.other_packets_recv.get(),
            "accepts": m.accepts.get(),
            "uniqueClientKeys": m.unique_client_keys.get(),
            "qadIncoming": m.qad_incoming.get(),
            "qadConnections": m.qad_connections.get(),
            "httpConnections": m.http_connections.get(),
            "gotPing": m.got_ping.get(),
        });
        std::fs::write(&tmp, snapshot.to_string())?;
        std::fs::rename(&tmp, &metrics_file)?;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
