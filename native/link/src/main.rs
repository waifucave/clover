//! `clover-link`: clover-core's link sidecar (spec §8.2; spike S1 chose iroh over a sidecar). One iroh endpoint per
//! device, keyed by the device's link key, which clover-core hands over on stdin, never in arguments, the environment
//! or a file. The core drives it over stdin and stdout; the link protocol itself (hello, lanes, requests, streams)
//! lives in the core (`packages/core/src/links/transport.ts`), and this process only carries connections and streams.
//!
//! Frames, both ways: a big-endian u32 length, then that many bytes. The first byte says what follows:
//! * `0`: a JSON control message (`{"op": …}` from the core, `{"ev": …}` to it);
//! * `1`: stream bytes, a big-endian u64 stream id and the data.
//!
//! What the owner decided for edit 6 (items 79-81): presence on n0's relays is accepted and QUIC address discovery is
//! on (iroh's default relays carry it); only a device without an account publishes to n0's address lookup, and then the
//! relay URL only (`PkarrPublisher`'s default filter); UPnP, NAT-PMP and PCP stay off (no firewall prompt, S1).
//! Connections on the link ALPN from keys the core hasn't allowed are closed at once (`allow`); the core checks again.
//!
//! Hooks the other lanes fill (the sidecar holds the device key): lane C's fence wraps how the core spawns it (it needs
//! only UDP, its stdin and stdout); lane M signs the binary and ships it beside the core.

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    net::SocketAddr,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use iroh::endpoint::{Connection, ConnectionError, ReadError, RecvStream, SendStream, VarInt};
use n0_future::StreamExt;
use serde_json::{json, Value};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, Mutex},
};

const T_JSON: u8 = 0;
const T_DATA: u8 = 1;
const MAX_FRAME: usize = 16 * 1024 * 1024 + 16;
const LINK_ALPN: &str = "clover/link/1";
const CLOSE_UNPAIRED: u32 = 2;
const RESET_CONN_LOST: u32 = 3;

enum Out {
    Json(Value),
    Data(u64, Vec<u8>),
}

enum StreamCmd {
    Write(Vec<u8>),
    Finish,
    Reset(u32),
}

struct Sidecar {
    ep: iroh::Endpoint,
    out: mpsc::UnboundedSender<Out>,
    conns: Mutex<HashMap<u64, Connection>>,
    /// Codes this side closed a connection with, for its `closed` event.
    local_close: Mutex<HashMap<u64, (u32, String)>>,
    streams: Mutex<HashMap<u64, mpsc::UnboundedSender<StreamCmd>>>,
    allow: Mutex<Option<HashSet<[u8; 32]>>>,
    next_conn: AtomicU64,
    /// Streams this side accepts get odd ids; the core picks even ones for those it opens.
    next_stream: AtomicU64,
}

fn emit(out: &mpsc::UnboundedSender<Out>, v: Value) {
    let _ = out.send(Out::Json(v));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex32(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        bail!("a key is 32 bytes of hex");
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).context("a key is hex")?;
    }
    Ok(out)
}

fn is_lan(addr: &SocketAddr) -> bool {
    match addr {
        SocketAddr::V4(a) => {
            let ip = a.ip();
            ip.is_private() || ip.is_loopback() || ip.is_link_local()
        }
        SocketAddr::V6(a) => {
            let ip = a.ip();
            ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// The path a connection's traffic takes now: `lan`, `direct` or `relay`, its round trip and its relay.
fn path_of(conn: &Connection) -> Value {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else { return json!({ "kind": "relay" }) };
    let rtt = (p.rtt().as_secs_f64() * 10_000.0).round() / 10.0;
    match p.remote_addr() {
        iroh::TransportAddr::Ip(addr) => json!({ "kind": if is_lan(addr) { "lan" } else { "direct" }, "rttMs": rtt }),
        iroh::TransportAddr::Relay(url) => json!({ "kind": "relay", "rttMs": rtt, "relay": url.to_string() }),
        _ => json!({ "kind": "direct", "rttMs": rtt }),
    }
}

impl Sidecar {
    async fn bind(init: &Value, out: mpsc::UnboundedSender<Out>) -> Result<Arc<Self>> {
        let seed = unhex32(init["seed"].as_str().ok_or_else(|| anyhow!("init needs the seed"))?)?;
        let secret = iroh::SecretKey::from_bytes(&seed);
        let alpns: Vec<Vec<u8>> = init["alpns"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.as_bytes().to_vec())).collect())
            .unwrap_or_else(|| vec![LINK_ALPN.as_bytes().to_vec()]);
        let mut builder = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(secret)
            .alpns(alpns)
            .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
        builder = match &init["relay"] {
            Value::String(s) if s == "disabled" => builder.relay_mode(iroh::RelayMode::Disabled),
            Value::String(s) if s == "default" || s.is_empty() => builder.relay_mode(iroh::RelayMode::Default),
            Value::String(url) => {
                let url: iroh::RelayUrl = url.parse().context("relay url")?;
                builder.relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from(iroh::RelayConfig::new(url, None))))
            }
            _ => builder.relay_mode(iroh::RelayMode::Default),
        };
        if init["n0Lookup"].as_bool() == Some(true) {
            // Only devices without an account (item 81): the relay URL only, the publisher's default filter.
            builder = builder
                .address_lookup(iroh::address_lookup::PkarrPublisher::n0_dns())
                .address_lookup(iroh::address_lookup::PkarrResolver::n0_dns())
                .address_lookup(iroh::address_lookup::DnsAddressLookup::n0_dns());
        }
        if let Some(bind) = init["bind"].as_str() {
            let addr: SocketAddr = bind.parse().context("bind address")?;
            builder = builder.clear_ip_transports().bind_addr(addr)?;
        }
        let ep = builder.bind().await.context("bind the iroh endpoint")?;
        Ok(Arc::new(Sidecar {
            ep,
            out,
            conns: Mutex::new(HashMap::new()),
            local_close: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            allow: Mutex::new(None),
            next_conn: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
        }))
    }

    fn ready(&self) -> Value {
        let addr = self.ep.addr();
        json!({
            "ev": "ready",
            "publicKey": hex(self.ep.id().as_bytes()),
            "relay": addr.relay_urls().next().map(|u| u.to_string()),
            "bound": self.ep.bound_sockets().iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        })
    }

    /// Registers a connection and starts its watchers: incoming streams, path changes and the close.
    async fn adopt(self: &Arc<Self>, conn: Connection) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().await.insert(id, conn.clone());
        let me = self.clone();
        let c = conn.clone();
        tokio::spawn(async move {
            while let Ok((send, recv)) = c.accept_bi().await {
                let sid = me.next_stream.fetch_add(2, Ordering::Relaxed);
                me.stream_tasks(sid, send, recv).await;
                emit(&me.out, json!({ "ev": "stream", "conn": id, "stream": sid }));
            }
        });
        let me = self.clone();
        let c = conn.clone();
        tokio::spawn(async move {
            let mut last = Value::Null;
            let mut paths = c.paths_stream();
            while paths.next().await.is_some() {
                let now = path_of(&c);
                if now["kind"] != last["kind"] || now["relay"] != last["relay"] {
                    emit(&me.out, json!({ "ev": "path", "conn": id, "path": now }));
                    last = now;
                }
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            let why = conn.closed().await;
            me.conns.lock().await.remove(&id);
            let mine = me.local_close.lock().await.remove(&id);
            let (code, reason, local) = match (mine, why) {
                (Some((code, reason)), _) => (code, reason, true),
                (None, ConnectionError::ApplicationClosed(c)) => {
                    (u32::try_from(c.error_code.into_inner()).unwrap_or(5), String::from_utf8_lossy(&c.reason).into_owned(), false)
                }
                (None, ConnectionError::LocallyClosed) => (0, "closed".into(), true),
                (None, other) => (5, other.to_string(), false),
            };
            emit(&me.out, json!({ "ev": "closed", "conn": id, "code": code, "reason": reason, "local": local }));
        });
        id
    }

    /// One stream: a task that owns its send half and takes the core's writes in order, and one that reads.
    async fn stream_tasks(self: &Arc<Self>, sid: u64, send: SendStream, recv: RecvStream) {
        let (tx, rx) = mpsc::unbounded_channel::<StreamCmd>();
        self.streams.lock().await.insert(sid, tx);
        self.adopt_opened(sid, send, recv, rx).await;
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.ep.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(accepting) = incoming.accept() else { return };
                let Ok(conn) = accepting.await else { return };
                let alpn = String::from_utf8_lossy(conn.alpn()).into_owned();
                let peer = *conn.remote_id().as_bytes();
                if alpn == LINK_ALPN {
                    if let Some(allow) = me.allow.lock().await.as_ref() {
                        if !allow.contains(&peer) {
                            conn.close(VarInt::from_u32(CLOSE_UNPAIRED), b"not a paired device");
                            return;
                        }
                    }
                }
                let path = path_of(&conn);
                let id = me.adopt(conn).await;
                emit(&me.out, json!({ "ev": "incoming", "conn": id, "peerKey": hex(&peer), "alpn": alpn, "path": path }));
            });
        }
    }

    async fn dial(self: Arc<Self>, m: Value) {
        let req = m["id"].clone();
        let result: Result<(u64, Value)> = async {
            let key = iroh::PublicKey::from_bytes(&unhex32(m["key"].as_str().unwrap_or_default())?)?;
            let alpn = m["alpn"].as_str().unwrap_or(LINK_ALPN).to_string();
            let direct_only = m["directOnly"].as_bool() == Some(true);
            let mut addrs: Vec<iroh::TransportAddr> = Vec::new();
            for list in ["lan", "direct"] {
                for a in m[list].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
                    if let Ok(sa) = SocketAddr::from_str(a) {
                        addrs.push(iroh::TransportAddr::Ip(sa));
                    }
                }
            }
            if !direct_only {
                if let Some(url) = m["relay"].as_str() {
                    addrs.push(iroh::TransportAddr::Relay(url.parse().context("relay url")?));
                }
            }
            let timeout = Duration::from_millis(m["timeoutMs"].as_u64().unwrap_or(10_000));
            let conn = tokio::time::timeout(timeout, self.ep.connect(iroh::EndpointAddr::from_parts(key, addrs), alpn.as_bytes()))
                .await
                .map_err(|_| anyhow!("no path answered in time"))??;
            let path = path_of(&conn);
            Ok((self.adopt(conn).await, path))
        }
        .await;
        match result {
            Ok((conn, path)) => emit(&self.out, json!({ "ev": "dialed", "id": req, "conn": conn, "path": path })),
            Err(e) => emit(&self.out, json!({ "ev": "dialFailed", "id": req, "error": e.to_string() })),
        }
    }

    async fn control(self: &Arc<Self>, m: Value) -> Result<bool> {
        match m["op"].as_str().unwrap_or_default() {
            "dial" => {
                tokio::spawn(self.clone().dial(m));
            }
            "open" => {
                let conn = self.conns.lock().await.get(&m["conn"].as_u64().unwrap_or(0)).cloned();
                let sid = m["stream"].as_u64().unwrap_or(0);
                let priority = m["priority"].as_i64().unwrap_or(0) as i32;
                match conn {
                    Some(c) => {
                        let me = self.clone();
                        // Registered before the open completes, so writes that follow queue in order.
                        let (tx, rx) = mpsc::unbounded_channel::<StreamCmd>();
                        self.streams.lock().await.insert(sid, tx);
                        tokio::spawn(async move {
                            match c.open_bi().await {
                                Ok((send, recv)) => {
                                    let _ = send.set_priority(priority);
                                    me.adopt_opened(sid, send, recv, rx).await;
                                }
                                Err(_) => {
                                    me.streams.lock().await.remove(&sid);
                                    emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                                }
                            }
                        });
                    }
                    None => emit(&self.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST })),
                }
            }
            "finish" | "reset" => {
                let sid = m["stream"].as_u64().unwrap_or(0);
                if let Some(tx) = self.streams.lock().await.get(&sid) {
                    let cmd = if m["op"] == "finish" { StreamCmd::Finish } else { StreamCmd::Reset(m["code"].as_u64().unwrap_or(1) as u32) };
                    let _ = tx.send(cmd);
                }
            }
            "close" => {
                let id = m["conn"].as_u64().unwrap_or(0);
                if let Some(c) = self.conns.lock().await.get(&id).cloned() {
                    let code = m["code"].as_u64().unwrap_or(0) as u32;
                    let reason = m["reason"].as_str().unwrap_or_default().to_string();
                    self.local_close.lock().await.insert(id, (code, reason.clone()));
                    c.close(VarInt::from_u32(code), reason.as_bytes());
                }
            }
            "allow" => {
                let mut set = HashSet::new();
                for k in m["keys"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
                    set.insert(unhex32(k)?);
                }
                *self.allow.lock().await = Some(set);
            }
            "networkChanged" => {
                let me = self.clone();
                tokio::spawn(async move { me.ep.network_change().await });
            }
            "netReport" => {
                use iroh::Watcher;
                let report = self.ep.net_report().get();
                let mapping = match report.as_ref().and_then(|r| r.mapping_varies_by_dest_ipv4) {
                    Some(false) => "same",
                    Some(true) => "varies",
                    None => "unknown",
                };
                let addr = self.ep.addr();
                emit(&self.out, json!({
                    "ev": "netReport", "id": m["id"].clone(), "mapping": mapping,
                    "globalV4": report.as_ref().and_then(|r| r.global_v4).map(|a| a.to_string()),
                    "relay": addr.relay_urls().next().map(|u| u.to_string()),
                    "direct": addr.ip_addrs().map(|a| a.to_string()).collect::<Vec<_>>(),
                }));
            }
            "shutdown" => return Ok(false),
            other => emit(&self.out, json!({ "ev": "error", "message": format!("unknown op {other}") })),
        }
        Ok(true)
    }

    async fn adopt_opened(self: &Arc<Self>, sid: u64, mut send: SendStream, mut recv: RecvStream, mut rx: mpsc::UnboundedReceiver<StreamCmd>) {
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                let failed = match cmd {
                    StreamCmd::Write(data) => send.write_all(&data).await.is_err(),
                    StreamCmd::Finish => {
                        let _ = send.finish();
                        false
                    }
                    StreamCmd::Reset(code) => {
                        let _ = send.reset(VarInt::from_u32(code));
                        break;
                    }
                };
                if failed {
                    emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                    break;
                }
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match recv.read_chunk(64 * 1024).await {
                    Ok(Some(chunk)) => {
                        let _ = me.out.send(Out::Data(sid, chunk.to_vec()));
                    }
                    Ok(None) => {
                        emit(&me.out, json!({ "ev": "fin", "stream": sid }));
                        break;
                    }
                    Err(ReadError::Reset(code)) => {
                        emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": u32::try_from(code.into_inner()).unwrap_or(RESET_CONN_LOST) }));
                        break;
                    }
                    Err(_) => {
                        emit(&me.out, json!({ "ev": "reset", "stream": sid, "code": RESET_CONN_LOST }));
                        break;
                    }
                }
            }
            me.streams.lock().await.remove(&sid);
        });
    }
}

async fn read_frame(input: &mut tokio::io::Stdin, buf: &mut Vec<u8>) -> Result<bool> {
    let mut len = [0u8; 4];
    if input.read_exact(&mut len).await.is_err() {
        return Ok(false);
    }
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > MAX_FRAME {
        bail!("a frame of {n} bytes");
    }
    buf.resize(n, 0);
    input.read_exact(buf).await?;
    Ok(true)
}

fn writer(mut rx: mpsc::UnboundedReceiver<Out>) {
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::with_capacity(1 << 20, stdout.lock());
    while let Some(first) = rx.blocking_recv() {
        let mut next = Some(first);
        while let Some(o) = next {
            let body = match o {
                Out::Json(v) => {
                    let mut b = vec![T_JSON];
                    b.extend_from_slice(v.to_string().as_bytes());
                    b
                }
                Out::Data(sid, data) => {
                    let mut b = Vec::with_capacity(9 + data.len());
                    b.push(T_DATA);
                    b.extend_from_slice(&sid.to_be_bytes());
                    b.extend_from_slice(&data);
                    b
                }
            };
            if w.write_all(&(body.len() as u32).to_be_bytes()).and_then(|_| w.write_all(&body)).is_err() {
                return;
            }
            next = rx.try_recv().ok();
        }
        if w.flush().is_err() {
            return;
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let (tx, rx) = mpsc::unbounded_channel::<Out>();
    let writer = std::thread::spawn(move || writer(rx));
    let mut input = tokio::io::stdin();
    let mut buf = Vec::new();
    // The first frame is `init`, with the seed: nothing binds before the key is here.
    if !read_frame(&mut input, &mut buf).await? || buf[0] != T_JSON {
        bail!("expected init on stdin");
    }
    let init: Value = serde_json::from_slice(&buf[1..])?;
    buf.iter_mut().for_each(|b| *b = 0);
    if init["op"] != "init" {
        bail!("expected init on stdin");
    }
    let sidecar = match Sidecar::bind(&init, tx.clone()).await {
        Ok(s) => s,
        Err(e) => {
            emit(&tx, json!({ "ev": "error", "message": e.to_string(), "fatal": true }));
            drop(tx);
            let _ = writer.join();
            std::process::exit(1);
        }
    };
    drop(init);
    emit(&tx, sidecar.ready());
    tokio::spawn(sidecar.clone().accept_loop());
    loop {
        match read_frame(&mut input, &mut buf).await {
            Ok(true) => {}
            _ => break,
        }
        match buf[0] {
            T_JSON => {
                let Ok(m) = serde_json::from_slice::<Value>(&buf[1..]) else { continue };
                match sidecar.control(m).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(e) => emit(&tx, json!({ "ev": "error", "message": e.to_string() })),
                }
            }
            T_DATA if buf.len() >= 9 => {
                let sid = u64::from_be_bytes(buf[1..9].try_into().unwrap());
                if let Some(s) = sidecar.streams.lock().await.get(&sid) {
                    let _ = s.send(StreamCmd::Write(buf[9..].to_vec()));
                }
            }
            _ => {}
        }
    }
    // The core went away or asked to stop: close every connection, tell the relays, and exit.
    let _ = tokio::time::timeout(Duration::from_secs(3), sidecar.ep.close()).await;
    emit(&tx, json!({ "ev": "stopped" }));
    drop(tx);
    // Tasks still hold senders; give the writer a moment to flush the last events, then go.
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(writer);
    std::process::exit(0);
}
