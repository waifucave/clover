//! One surface over the two QUIC stacks S1 compares: plain quinn 0.11 and iroh 1.4.1 (whose QUIC
//! is noq, n0's quinn fork). Both run relay-free here; addresses come from the caller, which is
//! the lab's stand-in for the waifucave handshake.

use std::net::{SocketAddr, UdpSocket};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

pub const ALPN: &[u8] = b"clover/s1/bench/1";

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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        bail!("odd hex length");
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into)).collect()
}

fn quinn_transport(cc: Cc) -> Result<Arc<quinn::TransportConfig>> {
    let mut tc = quinn::TransportConfig::default();
    // Same liveness as iroh's defaults (HEARTBEAT_INTERVAL 5 s), so neither side is favoured.
    tc.keep_alive_interval(Some(Duration::from_secs(5)));
    tc.max_idle_timeout(Some(Duration::from_secs(30).try_into()?));
    match cc {
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

fn iroh_transport(cc: Cc) -> iroh::endpoint::QuicTransportConfig {
    let b = iroh::endpoint::QuicTransportConfig::builder();
    let b = match cc {
        Cc::Cubic => b,
        Cc::Bbr => b.congestion_controller_factory(Arc::new(noq_proto::congestion::Bbr3Config::default())),
        Cc::NewReno => b.congestion_controller_factory(Arc::new(noq_proto::congestion::NewRenoConfig::default())),
    };
    b.build()
}

pub enum Endpoint {
    Quinn { ep: quinn::Endpoint, cert_sha256: Vec<u8>, cc: Cc },
    Iroh { ep: iroh::Endpoint },
}

impl Endpoint {
    /// Binds a quinn endpoint on an already-bound socket (so a STUN answer taken on that socket
    /// describes this endpoint's own NAT mapping), or an iroh endpoint on `bind`.
    pub async fn bind(kind: Kind, socket: UdpSocket, cc: Cc) -> Result<Endpoint> {
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
                server_config.transport_config(quinn_transport(cc)?);
                let runtime = quinn::default_runtime().ok_or_else(|| anyhow!("no async runtime"))?;
                let ep = quinn::Endpoint::new(quinn::EndpointConfig::default(), Some(server_config), socket, runtime)?;
                Ok(Endpoint::Quinn { ep, cert_sha256, cc })
            }
            Kind::Iroh => {
                // iroh binds its own sockets, so hand the port over: close ours, bind iroh on it.
                // The NAT mapping a STUN query made from this port outlives the socket.
                let addr = socket.local_addr()?;
                drop(socket);
                let ep = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .relay_mode(iroh::RelayMode::Disabled)
                    .alpns(vec![ALPN.to_vec()])
                    .transport_config(iroh_transport(cc))
                    .clear_ip_transports()
                    .bind_addr(addr)?
                    .bind()
                    .await
                    .context("bind iroh endpoint")?;
                Ok(Endpoint::Iroh { ep })
            }
        }
    }

    /// The identity a peer needs to dial us: iroh's endpoint id, or quinn's certificate hash.
    pub fn identity(&self) -> String {
        match self {
            Endpoint::Quinn { cert_sha256, .. } => hex(cert_sha256),
            Endpoint::Iroh { ep } => ep.id().to_string(),
        }
    }

    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        match self {
            Endpoint::Quinn { ep, .. } => ep.local_addr().into_iter().collect(),
            Endpoint::Iroh { ep } => ep.bound_sockets(),
        }
    }

    /// Dials a peer at every candidate address at once and returns the first connection.
    pub async fn connect(&self, identity: &str, addrs: &[SocketAddr]) -> Result<Conn> {
        if addrs.is_empty() {
            bail!("no candidate addresses");
        }
        match self {
            Endpoint::Quinn { ep, cc, .. } => {
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
                client_config.transport_config(quinn_transport(*cc)?);
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
            Endpoint::Iroh { ep } => {
                // iroh sends its Initial to every known path until one answers (remote_state.rs).
                let id = iroh::EndpointId::from_str(identity)?;
                let addr = iroh::EndpointAddr::from_parts(id, addrs.iter().map(|a| iroh::TransportAddr::Ip(*a)));
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
            Endpoint::Iroh { ep } => match ep.accept().await {
                None => Ok(None),
                Some(incoming) => {
                    let conn = incoming.accept()?.await?;
                    Ok(Some(Conn::Iroh(conn)))
                }
            },
        }
    }

    pub async fn close(&self) {
        match self {
            Endpoint::Quinn { ep, .. } => {
                ep.close(0u32.into(), b"done");
                ep.wait_idle().await;
            }
            Endpoint::Iroh { ep } => ep.close().await,
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

    pub fn stats_json(&self) -> Value {
        match self {
            Conn::Quinn(c) => {
                let s = c.stats();
                json!({ "udpTx": s.udp_tx.datagrams, "udpRx": s.udp_rx.datagrams, "lost": s.path.lost_packets, "cwnd": s.path.cwnd })
            }
            Conn::Iroh(c) => {
                let s = c.stats();
                json!({ "udpTx": s.udp_tx.datagrams, "udpRx": s.udp_rx.datagrams })
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
