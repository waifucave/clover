//! One surface over the two QUIC stacks S1 compares: plain quinn 0.11 and iroh 1.4.1 (whose QUIC
//! is noq, n0's quinn fork). Both run relay-free unless a lab relay is given; addresses come from
//! the caller, which is the lab's stand-in for the waifucave handshake.

use std::net::{SocketAddr, UdpSocket};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use crate::Args;

pub const ALPN: &[u8] = b"clover/s1/bench/1";

/// What the labs vary on top of each stack's own defaults.
#[derive(Clone, Debug)]
pub struct Opts {
    pub cc: Cc,
    /// UDP segmentation offload, on by default in both stacks: one send hands the kernel up to
    /// 10 datagrams, and netem drops such a batch whole. The loss labs turn it off.
    pub gso: bool,
    /// The per-stream receive window in bytes. Both stacks default to 1,250,000.
    pub stream_window: Option<u64>,
    /// The first RTT estimate. Both default to 333 ms, so a lost first Initial is resent at 999 ms.
    pub initial_rtt: Option<Duration>,
    /// iroh only: the lab's relay. None is relays off.
    pub relay: Option<RelayOpts>,
}

#[derive(Clone, Debug)]
pub struct RelayOpts {
    pub url: String,
    /// The relay's QUIC address-discovery (QAD) port. None leaves QAD off for this relay, the one
    /// lever iroh 1.4.1 has to keep address discovery off a relay that is otherwise on.
    pub qad_port: Option<u16>,
    /// The lab relay's self-signed certificate, pinned by its SHA-256 (as `relay-server` reports
    /// it), so the endpoints verify the relay without a CA.
    pub cert_sha256: Vec<u8>,
}

impl Opts {
    pub fn new(cc: Cc) -> Opts {
        Opts { cc, gso: true, stream_window: None, initial_rtt: None, relay: None }
    }

    /// `--cc`, `--gso on|off`, `--stream-window <bytes>`, `--initial-rtt-ms <ms>`, and
    /// `--relay-url <url> --relay-cert-sha256 <hex> [--relay-qad-port <port>]`.
    pub fn from_args(a: &Args) -> Result<Opts> {
        let mut o = Opts::new(a.get_or("cc", "cubic").parse()?);
        o.gso = match a.get_or("gso", "on").as_str() {
            "on" => true,
            "off" => false,
            other => bail!("--gso on|off, not {other}"),
        };
        o.stream_window = a.get("stream-window").map(|v| v.parse()).transpose().context("--stream-window")?;
        o.initial_rtt = a
            .get("initial-rtt-ms")
            .map(|v| v.parse::<u64>().map(Duration::from_millis))
            .transpose()
            .context("--initial-rtt-ms")?;
        if let Some(url) = a.get("relay-url") {
            let qad_port = a.get("relay-qad-port").map(|p| p.parse()).transpose().context("--relay-qad-port")?;
            let cert_sha256 = unhex(&a.get("relay-cert-sha256").context("--relay-cert-sha256 with --relay-url")?)?;
            o.relay = Some(RelayOpts { url, qad_port, cert_sha256 });
        }
        Ok(o)
    }

    pub fn json(&self) -> Value {
        json!({
            "cc": self.cc.name(),
            "gso": self.gso,
            "streamWindow": self.stream_window,
            "initialRttMs": self.initial_rtt.map(|d| d.as_millis() as u64),
            "relay": self.relay.as_ref().map(|r| json!({ "url": r.url, "qadPort": r.qad_port })),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Quinn,
    Iroh,
}

impl FromStr for Kind {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "quinn" => Ok(Kind::Quinn),
            "iroh" => Ok(Kind::Iroh),
            _ => bail!("unknown transport {s}"),
        }
    }
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Quinn => "quinn",
            Kind::Iroh => "iroh",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cc {
    Cubic,
    Bbr,
    NewReno,
}

impl FromStr for Cc {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "cubic" => Ok(Cc::Cubic),
            "bbr" => Ok(Cc::Bbr),
            "newreno" => Ok(Cc::NewReno),
            _ => bail!("unknown congestion controller {s}"),
        }
    }
}

impl Cc {
    pub fn name(self) -> &'static str {
        match self {
            Cc::Cubic => "cubic",
            Cc::Bbr => "bbr",
            Cc::NewReno => "newreno",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// quinn TLS: a self-signed Ed25519 certificate per device, pinned by its SHA-256 on the dialling
// side. Clover's device keys are Ed25519 too (spec §8.1), so this is the shape a plain-QUIC link
// would take. The spike pins only the server; production would add client certificates.
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
struct PinnedServerCert {
    sha256: Vec<u8>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedServerCert {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let got = ring::digest::digest(&ring::digest::SHA256, end_entity.as_ref());
        if got.as_ref() == self.sha256.as_slice() {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate does not match the pinned device key".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 is not used by QUIC".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        bail!("odd hex length");
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into)).collect()
}

fn quinn_transport(o: &Opts) -> Result<Arc<quinn::TransportConfig>> {
    let mut tc = quinn::TransportConfig::default();
    // Same liveness as iroh's defaults (HEARTBEAT_INTERVAL 5 s), so neither side is favoured.
    tc.keep_alive_interval(Some(Duration::from_secs(5)));
    tc.max_idle_timeout(Some(Duration::from_secs(30).try_into()?));
    tc.enable_segmentation_offload(o.gso);
    if let Some(w) = o.stream_window {
        tc.stream_receive_window(quinn::VarInt::from_u64(w)?);
    }
    if let Some(rtt) = o.initial_rtt {
        tc.initial_rtt(rtt);
    }
    match o.cc {
        Cc::Cubic => {}
        Cc::Bbr => {
            tc.congestion_controller_factory(Arc::new(quinn::congestion::BbrConfig::default()));
        }
        Cc::NewReno => {
            tc.congestion_controller_factory(Arc::new(quinn::congestion::NewRenoConfig::default()));
        }
    }
    Ok(Arc::new(tc))
}

fn iroh_transport(o: &Opts) -> Result<iroh::endpoint::QuicTransportConfig> {
    let mut b = iroh::endpoint::QuicTransportConfig::builder().enable_segmentation_offload(o.gso);
    if let Some(w) = o.stream_window {
        b = b.stream_receive_window(iroh::endpoint::VarInt::from_u64(w)?);
    }
    if let Some(rtt) = o.initial_rtt {
        b = b.initial_rtt(rtt);
    }
    let b = match o.cc {
        Cc::Cubic => b,
        Cc::Bbr => b.congestion_controller_factory(Arc::new(noq_proto::congestion::Bbr3Config::default())),
        Cc::NewReno => b.congestion_controller_factory(Arc::new(noq_proto::congestion::NewRenoConfig::default())),
    };
    Ok(b.build())
}

pub enum Endpoint {
    Quinn { ep: quinn::Endpoint, cert_sha256: Vec<u8>, opts: Opts },
    Iroh { ep: iroh::Endpoint, relay_url: Option<String> },
}

impl Endpoint {
    /// Binds a quinn endpoint on an already-bound socket (so a STUN answer taken on that socket
    /// describes this endpoint's own NAT mapping), or an iroh endpoint on that socket's port.
    pub async fn bind(kind: Kind, socket: UdpSocket, opts: &Opts) -> Result<Endpoint> {
        match kind {
            Kind::Quinn => {
                let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)?;
                let cert = rcgen::CertificateParams::new(vec!["clover-device".to_string()])?.self_signed(&key)?;
                let cert_der = cert.der().clone();
                let cert_sha256 = ring::digest::digest(&ring::digest::SHA256, cert_der.as_ref()).as_ref().to_vec();
                let key_der = rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into());
                let provider = Arc::new(rustls::crypto::ring::default_provider());
                let mut server_crypto = rustls::ServerConfig::builder_with_provider(provider.clone())
                    .with_protocol_versions(&[&rustls::version::TLS13])?
                    .with_no_client_auth()
                    .with_single_cert(vec![cert_der], key_der)?;
                server_crypto.alpn_protocols = vec![ALPN.to_vec()];
                let mut server_config = quinn::ServerConfig::with_crypto(Arc::new(
                    quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)?,
                ));
                server_config.transport_config(quinn_transport(opts)?);
                let runtime = quinn::default_runtime().ok_or_else(|| anyhow!("no async runtime"))?;
                // tokio needs the socket non-blocking; a blocking one stalls quinn's driver in
                // recv until some packet arrives.
                socket.set_nonblocking(true)?;
                let ep = quinn::Endpoint::new(quinn::EndpointConfig::default(), Some(server_config), socket, runtime)?;
                Ok(Endpoint::Quinn { ep, cert_sha256, opts: opts.clone() })
            }
            Kind::Iroh => {
                // iroh binds its own sockets, so hand the port over: close ours, bind iroh on it.
                // The NAT mapping a STUN query made from this port outlives the socket on a NAT
                // that keeps mappings per inside address and port; the lab's NATs keep the port
                // itself, so the lab can't tell (report, lab limits).
                let addr = socket.local_addr()?;
                drop(socket);
                let builder = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .alpns(vec![ALPN.to_vec()])
                    .transport_config(iroh_transport(opts)?)
                    // iroh maps a port through UPnP, NAT-PMP or PCP by default, and its gateway
                    // probing can raise a firewall prompt on macOS. The labs keep it off.
                    .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
                let builder = match &opts.relay {
                    None => builder.relay_mode(iroh::RelayMode::Disabled),
                    Some(r) => {
                        let url: iroh::RelayUrl = r.url.parse().context("--relay-url")?;
                        let quic = r.qad_port.map(iroh_relay::RelayQuicConfig::new);
                        // The lab relay's certificate is self-signed: pin it, for both its HTTPS
                        // and its QUIC address discovery.
                        let pin = r.cert_sha256.clone();
                        let tls = iroh::tls::CaTlsConfig::custom_server_cert_verifier(Arc::new(move |provider| {
                            let verifier: Arc<dyn rustls::client::danger::ServerCertVerifier> =
                                Arc::new(PinnedServerCert { sha256: pin.clone(), provider });
                            Ok(verifier)
                        }));
                        builder
                            .relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from(iroh::RelayConfig::new(url, quic))))
                            .ca_tls_config(tls)
                    }
                };
                let ep = builder.clear_ip_transports().bind_addr(addr)?.bind().await.context("bind iroh endpoint")?;
                Ok(Endpoint::Iroh { ep, relay_url: opts.relay.as_ref().map(|r| r.url.clone()) })
            }
        }
    }

    /// The identity a peer needs to dial us: iroh's endpoint id, or quinn's certificate hash.
    pub fn identity(&self) -> String {
        match self {
            Endpoint::Quinn { cert_sha256, .. } => hex(cert_sha256),
            Endpoint::Iroh { ep, .. } => ep.id().to_string(),
        }
    }

    /// With a relay: waits (up to `max`) until the endpoint holds its home-relay connection and
    /// its first net report is in, the steady state of a long-running daemon, and returns what
    /// that report learned from the relay. Null without a relay.
    pub async fn settle(&self, max: Duration) -> Value {
        use iroh::Watcher;
        let Endpoint::Iroh { ep, relay_url: Some(_) } = self else { return Value::Null };
        let t = std::time::Instant::now();
        let online = tokio::time::timeout(max, ep.online()).await.is_ok();
        let online_ms = t.elapsed().as_secs_f64() * 1000.0;
        let mut report = ep.net_report().get();
        while report.is_none() && t.elapsed() < max {
            tokio::time::sleep(Duration::from_millis(50)).await;
            report = ep.net_report().get();
        }
        json!({
            "online": online,
            "onlineMs": (online_ms * 10.0).round() / 10.0,
            "reportMs": (t.elapsed().as_secs_f64() * 10000.0).round() / 10.0,
            "globalV4": report.as_ref().and_then(|r| r.global_v4).map(|a| a.to_string()),
            "mappingVariesByDest": report.as_ref().and_then(|r| r.mapping_varies_by_dest_ipv4),
            "captivePortal": report.as_ref().and_then(|r| r.captive_portal),
        })
    }

    /// The relay this endpoint uses, which a peer adds to its dial to race the relay path.
    pub fn relay_url(&self) -> Option<String> {
        match self {
            Endpoint::Quinn { .. } => None,
            Endpoint::Iroh { relay_url, .. } => relay_url.clone(),
        }
    }

    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        match self {
            Endpoint::Quinn { ep, .. } => ep.local_addr().into_iter().collect(),
            Endpoint::Iroh { ep, .. } => ep.bound_sockets(),
        }
    }

    /// Dials a peer at every candidate address at once and returns the first connection.
    pub async fn connect(&self, identity: &str, addrs: &[SocketAddr]) -> Result<Conn> {
        self.connect_via(identity, addrs, None).await
    }

    /// Like `connect`, and with iroh also through `relay_url` when given: the dial then sends its
    /// first packets over the relay as well as directly.
    pub async fn connect_via(&self, identity: &str, addrs: &[SocketAddr], relay_url: Option<&str>) -> Result<Conn> {
        if addrs.is_empty() && relay_url.is_none() {
            bail!("no candidate addresses");
        }
        match self {
            Endpoint::Quinn { ep, opts, .. } => {
                if addrs.is_empty() {
                    bail!("quinn has no relay");
                }
                let provider = Arc::new(rustls::crypto::ring::default_provider());
                let verifier = Arc::new(PinnedServerCert { sha256: unhex(identity)?, provider: provider.clone() });
                let mut crypto = rustls::ClientConfig::builder_with_provider(provider)
                    .with_protocol_versions(&[&rustls::version::TLS13])?
                    .dangerous()
                    .with_custom_certificate_verifier(verifier)
                    .with_no_client_auth();
                crypto.alpn_protocols = vec![ALPN.to_vec()];
                let mut client_config =
                    quinn::ClientConfig::new(Arc::new(quinn::crypto::rustls::QuicClientConfig::try_from(crypto)?));
                client_config.transport_config(quinn_transport(opts)?);
                // quinn dials one address per connection, so race one attempt per candidate.
                let mut set = tokio::task::JoinSet::new();
                for addr in addrs {
                    let connecting = ep.connect_with(client_config.clone(), *addr, "clover-device")?;
                    set.spawn(async move { connecting.await });
                }
                let mut last_err = None;
                while let Some(res) = set.join_next().await {
                    match res? {
                        Ok(conn) => {
                            set.abort_all();
                            return Ok(Conn::Quinn(conn));
                        }
                        Err(e) => last_err = Some(e),
                    }
                }
                Err(anyhow!("all quinn dials failed: {last_err:?}"))
            }
            Endpoint::Iroh { ep, .. } => {
                // iroh sends its Initial to every known path until one answers (remote_state.rs).
                let id = iroh::EndpointId::from_str(identity)?;
                let mut transports: Vec<iroh::TransportAddr> = addrs.iter().map(|a| iroh::TransportAddr::Ip(*a)).collect();
                if let Some(url) = relay_url {
                    transports.push(iroh::TransportAddr::Relay(url.parse().context("relay url")?));
                }
                let addr = iroh::EndpointAddr::from_parts(id, transports);
                let conn = ep.connect(addr, ALPN).await?;
                Ok(Conn::Iroh(conn))
            }
        }
    }

    pub async fn accept(&self) -> Result<Option<Conn>> {
        match self {
            Endpoint::Quinn { ep, .. } => match ep.accept().await {
                None => Ok(None),
                Some(incoming) => Ok(Some(Conn::Quinn(incoming.await?))),
            },
            Endpoint::Iroh { ep, .. } => match ep.accept().await {
                None => Ok(None),
                Some(incoming) => {
                    let conn = incoming.accept()?.await?;
                    Ok(Some(Conn::Iroh(conn)))
                }
            },
        }
    }

    /// What clover-core would call when the OS reports a network change: quinn moves to a fresh
    /// socket (active migration), iroh re-checks its interfaces and paths.
    pub async fn network_changed(&self) -> Result<()> {
        match self {
            Endpoint::Quinn { ep, .. } => {
                let socket = UdpSocket::bind("0.0.0.0:0")?;
                socket.set_nonblocking(true)?;
                ep.rebind(socket)?
            }
            Endpoint::Iroh { ep, .. } => ep.network_change().await,
        }
        Ok(())
    }

    pub async fn close(&self) {
        match self {
            Endpoint::Quinn { ep, .. } => {
                ep.close(0u32.into(), b"done");
                ep.wait_idle().await;
            }
            Endpoint::Iroh { ep, .. } => ep.close().await,
        }
    }
}

#[derive(Clone)]
pub enum Conn {
    Quinn(quinn::Connection),
    Iroh(iroh::endpoint::Connection),
}

pub enum SendS {
    Quinn(quinn::SendStream),
    Iroh(iroh::endpoint::SendStream),
}

pub enum RecvS {
    Quinn(quinn::RecvStream),
    Iroh(iroh::endpoint::RecvStream),
}

impl Conn {
    pub async fn open_bi(&self, priority: i32) -> Result<(SendS, RecvS)> {
        match self {
            Conn::Quinn(c) => {
                let (s, r) = c.open_bi().await?;
                s.set_priority(priority)?;
                Ok((SendS::Quinn(s), RecvS::Quinn(r)))
            }
            Conn::Iroh(c) => {
                let (s, r) = c.open_bi().await?;
                s.set_priority(priority)?;
                Ok((SendS::Iroh(s), RecvS::Iroh(r)))
            }
        }
    }

    pub async fn accept_bi(&self) -> Result<(SendS, RecvS)> {
        match self {
            Conn::Quinn(c) => {
                let (s, r) = c.accept_bi().await?;
                Ok((SendS::Quinn(s), RecvS::Quinn(r)))
            }
            Conn::Iroh(c) => {
                let (s, r) = c.accept_bi().await?;
                Ok((SendS::Iroh(s), RecvS::Iroh(r)))
            }
        }
    }

    pub fn close(&self) {
        match self {
            Conn::Quinn(c) => c.close(0u32.into(), b"done"),
            Conn::Iroh(c) => c.close(0u32.into(), b"done"),
        }
    }

    /// Where the connection's traffic goes now, and whether that path is direct.
    pub fn path_json(&self) -> Value {
        match self {
            Conn::Quinn(c) => json!({
                "remote": c.remote_address().to_string(),
                "direct": true,
                "rttMs": c.rtt().as_secs_f64() * 1000.0,
            }),
            Conn::Iroh(c) => {
                let paths = c.paths();
                let list: Vec<Value> = paths
                    .iter()
                    .map(|p| {
                        json!({
                            "remote": format!("{:?}", p.remote_addr()),
                            "selected": p.is_selected(),
                            "direct": p.is_ip(),
                            "relay": p.is_relay(),
                            "rttMs": p.rtt().as_secs_f64() * 1000.0,
                        })
                    })
                    .collect();
                json!({ "paths": list })
            }
        }
    }

    /// Whether any of the connection's paths goes through a relay.
    pub fn has_relay_path(&self) -> bool {
        match self {
            Conn::Quinn(_) => false,
            Conn::Iroh(c) => c.paths().iter().any(|p| p.is_relay()),
        }
    }

    pub fn stats_json(&self) -> Value {
        match self {
            Conn::Quinn(c) => {
                let s = c.stats();
                json!({ "udpTx": s.udp_tx.datagrams, "udpRx": s.udp_rx.datagrams, "lost": s.path.lost_packets, "cwnd": s.path.cwnd })
            }
            Conn::Iroh(c) => {
                let s = c.stats();
                // iroh is multipath: the congestion state is per path. Report the selected one's.
                let paths = c.paths();
                let selected = paths.iter().find(|p| p.is_selected()).map(|p| p.stats());
                json!({
                    "udpTx": s.udp_tx.datagrams,
                    "udpRx": s.udp_rx.datagrams,
                    "lost": selected.as_ref().map(|p| p.lost_packets),
                    "cwnd": selected.as_ref().map(|p| p.cwnd),
                })
            }
        }
    }
}

impl SendS {
    pub async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        match self {
            SendS::Quinn(s) => s.write_all(buf).await?,
            SendS::Iroh(s) => s.write_all(buf).await?,
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<()> {
        match self {
            SendS::Quinn(s) => s.finish()?,
            SendS::Iroh(s) => s.finish()?,
        }
        Ok(())
    }
}

impl RecvS {
    /// Returns 0 at the end of the stream.
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        let n = match self {
            RecvS::Quinn(r) => r.read(buf).await?,
            RecvS::Iroh(r) => r.read(buf).await?,
        };
        Ok(n.unwrap_or(0))
    }

    pub async fn read_exact(&mut self, buf: &mut [u8]) -> Result<()> {
        match self {
            RecvS::Quinn(r) => r.read_exact(buf).await?,
            RecvS::Iroh(r) => r.read_exact(buf).await?,
        }
        Ok(())
    }
}
