//! The bench protocol, shared with spikes/s1-transport/bun/src/iroh-napi.ts. The first byte of
//! every bidirectional stream picks the handler:
//!
//! * `E` echoes 64-byte frames until the client finishes (small RPCs on one long-lived stream)
//! * `R` answers one RPC and finishes (one stream per RPC)
//! * `S` sinks a bulk transfer and acks its byte count as a big-endian u64

use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::link::{Cc, Conn, Endpoint, Kind, RecvS, SendS};
use crate::{emit, ms, summary, Args};

const FRAME: usize = 64;

pub struct Sizes {
    pub rpc: usize,
    pub rpc_streams: usize,
    pub bulk_mb: f64,
    pub shots: usize,
    pub load_mb: f64,
    pub chunk: usize,
    pub load_gap_ms: u64,
}

impl Sizes {
    pub fn from_args(a: &Args) -> Sizes {
        let quick = a.flag("quick");
        Sizes {
            rpc: a.num("rpc", if quick { 200 } else { 2000 }),
            rpc_streams: a.num("rpc-streams", if quick { 50 } else { 300 }),
            bulk_mb: a.num("bulk-mb", if quick { 8.0 } else { 64.0 }),
            shots: a.num("shots", if quick { 5 } else { 20 }),
            load_mb: a.num("load-mb", if quick { 8.0 } else { 64.0 }),
            chunk: a.num("chunk", 64 * 1024),
            load_gap_ms: a.num("load-gap-ms", 5),
        }
    }

    fn json(&self) -> Value {
        json!({ "rpc": self.rpc, "rpcStreams": self.rpc_streams, "bulkMB": self.bulk_mb, "shots": self.shots,
                "loadMB": self.load_mb, "chunk": self.chunk, "loadGapMs": self.load_gap_ms })
    }
}

// ---------- server ----------

pub async fn serve_conn(conn: Conn) {
    loop {
        let (send, recv) = match conn.accept_bi().await {
            Ok(x) => x,
            Err(_) => return,
        };
        tokio::spawn(async move {
            let _ = handle_stream(send, recv).await;
        });
    }
}

async fn handle_stream(mut send: SendS, mut recv: RecvS) -> Result<()> {
    let mut op = [0u8; 1];
    recv.read_exact(&mut op).await?;
    match op[0] {
        b'E' => {
            let mut f = [0u8; FRAME];
            while recv.read_exact(&mut f).await.is_ok() {
                send.write_all(&f).await?;
            }
            send.finish()?;
        }
        b'R' => {
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = recv.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
            }
            send.write_all(&req).await?;
            send.finish()?;
        }
        b'S' => {
            let mut buf = vec![0u8; 256 * 1024];
            let mut total = 0u64;
            loop {
                let n = recv.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                total += n as u64;
            }
            send.write_all(&total.to_be_bytes()).await?;
            send.finish()?;
        }
        other => bail!("unknown op {other}"),
    }
    Ok(())
}

// ---------- client ----------

pub async fn rpc_on_one_stream(conn: &Conn, n: usize, prio: i32, gap: Duration, stop: Option<Arc<AtomicBool>>) -> Result<Vec<f64>> {
    let (mut send, mut recv) = conn.open_bi(prio).await?;
    send.write_all(b"E").await?;
    let frame = [7u8; FRAME];
    let mut back = [0u8; FRAME];
    let mut samples = Vec::with_capacity(n.min(100_000));
    for _ in 0..n {
        if stop.as_ref().is_some_and(|s| s.load(Ordering::Relaxed)) {
            break;
        }
        let t = Instant::now();
        send.write_all(&frame).await?;
        recv.read_exact(&mut back).await?;
        samples.push(ms(t.elapsed()));
        if !gap.is_zero() {
            tokio::time::sleep(gap).await;
        }
    }
    send.finish()?;
    Ok(samples)
}

async fn rpc_per_stream(conn: &Conn, n: usize) -> Result<Vec<f64>> {
    let mut req = vec![b'R'];
    req.extend_from_slice(&[9u8; FRAME]);
    let mut samples = Vec::with_capacity(n);
    let mut buf = [0u8; 4096];
    for _ in 0..n {
        let t = Instant::now();
        let (mut send, mut recv) = conn.open_bi(0).await?;
        send.write_all(&req).await?;
        send.finish()?;
        let mut got = 0;
        loop {
            let k = recv.read(&mut buf).await?;
            if k == 0 {
                break;
            }
            got += k;
        }
        if got != FRAME {
            bail!("rpc reply {got} bytes");
        }
        samples.push(ms(t.elapsed()));
    }
    Ok(samples)
}

pub async fn sink(conn: &Conn, bytes: u64, chunk: usize, prio: i32) -> Result<f64> {
    let (mut send, mut recv) = conn.open_bi(prio).await?;
    let buf = vec![1u8; chunk];
    let t = Instant::now();
    send.write_all(b"S").await?;
    let mut sent = 0u64;
    while sent < bytes {
        let n = (bytes - sent).min(chunk as u64) as usize;
        send.write_all(&buf[..n]).await?;
        sent += n as u64;
    }
    send.finish()?;
    let mut ack = [0u8; 8];
    recv.read_exact(&mut ack).await?;
    let elapsed = ms(t.elapsed());
    let got = u64::from_be_bytes(ack);
    if got != bytes {
        bail!("sink ack {got} != {bytes}");
    }
    Ok(elapsed)
}

fn mbps(bytes: f64, ms: f64) -> f64 {
    (bytes / 1e6 / (ms / 1000.0) * 10.0).round() / 10.0
}

pub async fn run_client(conn: &Conn, sizes: &Sizes) -> Result<Value> {
    let mut out = serde_json::Map::new();
    out.insert("rpcStream".into(), summary(&rpc_on_one_stream(conn, sizes.rpc, 0, Duration::ZERO, None).await?));
    out.insert("rpcPerStream".into(), summary(&rpc_per_stream(conn, sizes.rpc_streams).await?));

    let bulk_bytes = (sizes.bulk_mb * 1e6) as u64;
    let bulk_ms = sink(conn, bulk_bytes, sizes.chunk, 0).await?;
    out.insert("bulk".into(), json!({ "mb": sizes.bulk_mb, "ms": bulk_ms, "MBps": mbps(bulk_bytes as f64, bulk_ms) }));

    let mut shots = Vec::new();
    for _ in 0..sizes.shots {
        shots.push(sink(conn, 1_000_000, sizes.chunk, 0).await?);
    }
    out.insert("screenshot1MB".into(), summary(&shots));

    // Small-message delay while a bulk transfer runs on the same connection (spec §8.3 item 4).
    for (label, rpc_prio, bulk_prio) in [("prioritised", 10, 0), ("equal", 0, 0)] {
        let done = Arc::new(AtomicBool::new(false));
        let load_bytes = (sizes.load_mb * 1e6) as u64;
        let bulk = {
            let conn = conn.clone();
            let done = done.clone();
            let chunk = sizes.chunk;
            tokio::spawn(async move {
                let r = sink(&conn, load_bytes, chunk, bulk_prio).await;
                done.store(true, Ordering::Relaxed);
                r
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let samples =
            rpc_on_one_stream(conn, usize::MAX, rpc_prio, Duration::from_millis(sizes.load_gap_ms), Some(done.clone())).await?;
        let bulk_ms = bulk.await??;
        let mut s = summary(&samples);
        s["bulkMBps"] = json!(mbps(load_bytes as f64, bulk_ms));
        out.insert(format!("rpcUnderLoad_{label}"), s);
    }
    out.insert("path".into(), conn.path_json());
    out.insert("stats".into(), conn.stats_json());
    Ok(Value::Object(out))
}

// ---------- commands ----------

/// `local-bench`: client and server in one process over loopback, relay off.
pub async fn local(a: &Args) -> Result<()> {
    let kind: Kind = a.get_or("transport", "quinn").parse()?;
    let cc: Cc = a.get_or("cc", "cubic").parse()?;
    let sizes = Sizes::from_args(a);
    let check = format!("native-{}", kind.name());
    let res: Result<Value> = async {
        let t = Instant::now();
        let server = Endpoint::bind(kind, UdpSocket::bind("127.0.0.1:0")?, cc).await?;
        let bind_ms = ms(t.elapsed());
        let client = Endpoint::bind(kind, UdpSocket::bind("127.0.0.1:0")?, cc).await?;
        let server = Arc::new(server);
        {
            let server = server.clone();
            tokio::spawn(async move {
                while let Ok(Some(conn)) = server.accept().await {
                    tokio::spawn(serve_conn(conn));
                }
            });
        }
        let id = server.identity();
        let addrs = server.local_addrs();
        let mut connect = Vec::new();
        let mut first = None;
        for _ in 0..10 {
            let t = Instant::now();
            let c = tokio::time::timeout(Duration::from_secs(10), client.connect(&id, &addrs)).await.context("connect timeout")??;
            connect.push(ms(t.elapsed()));
            if first.is_none() {
                first = Some(c);
            } else {
                c.close();
            }
        }
        let conn = first.unwrap();
        let mut body = run_client(&conn, &sizes).await?;
        body["bindMs"] = json!(bind_ms);
        body["connectFirstMs"] = json!(connect[0]);
        body["connect"] = summary(&connect[1..]);
        conn.close();
        client.close().await;
        Ok(body)
    }
    .await;
    match res {
        Ok(mut body) => {
            body["ok"] = json!(true);
            body["mode"] = json!("in-process loopback, relay off");
            body["cc"] = json!(cc.name());
            body["sizes"] = sizes.json();
            emit(&check, body);
            Ok(())
        }
        Err(e) => {
            emit(&check, json!({ "ok": false, "cc": cc.name(), "error": format!("{e:#}") }));
            Err(e)
        }
    }
}

/// `serve`: a bench server for runs across network namespaces. Writes an info file with the
/// identity a client needs, then serves until killed.
pub async fn serve(a: &Args) -> Result<()> {
    let kind: Kind = a.get_or("transport", "quinn").parse()?;
    let cc: Cc = a.get_or("cc", "cubic").parse()?;
    let bind: SocketAddr = a.get_or("bind", "0.0.0.0:47000").parse()?;
    let ep = Endpoint::bind(kind, UdpSocket::bind(bind)?, cc).await?;
    let info = json!({ "transport": kind.name(), "identity": ep.identity(), "addrs": ep.local_addrs() });
    let path = a.get_or("info-file", "server.json");
    std::fs::write(format!("{path}.tmp"), info.to_string())?;
    std::fs::rename(format!("{path}.tmp"), &path)?;
    eprintln!("serving {} on {:?}", kind.name(), ep.local_addrs());
    while let Some(conn) = ep.accept().await? {
        tokio::spawn(serve_conn(conn));
    }
    Ok(())
}

/// `bench`: the client half of `serve`.
pub async fn client(a: &Args) -> Result<()> {
    let sizes = Sizes::from_args(a);
    let cc: Cc = a.get_or("cc", "cubic").parse()?;
    let profile = a.get_or("profile", "unknown");
    let info: Value = serde_json::from_str(&std::fs::read_to_string(a.get_or("info-file", "server.json"))?)?;
    let kind: Kind = info["transport"].as_str().unwrap_or("quinn").parse()?;
    let check = format!("native-{}-remote", kind.name());
    let res: Result<Value> = async {
        let target: SocketAddr = a.get("connect").context("--connect ip:port")?.parse()?;
        let ep = Endpoint::bind(kind, UdpSocket::bind(a.get_or("bind", "0.0.0.0:0"))?, cc).await?;
        let t = Instant::now();
        let conn = tokio::time::timeout(
            Duration::from_secs(15),
            ep.connect(info["identity"].as_str().unwrap_or_default(), &[target]),
        )
        .await
        .context("connect timeout")??;
        let connect_ms = ms(t.elapsed());
        let mut body = run_client(&conn, &sizes).await?;
        body["connectMs"] = json!(connect_ms);
        conn.close();
        ep.close().await;
        Ok(body)
    }
    .await;
    match res {
        Ok(mut body) => {
            body["ok"] = json!(true);
            body["profile"] = json!(profile);
            body["cc"] = json!(cc.name());
            body["sizes"] = sizes.json();
            emit(&check, body);
            Ok(())
        }
        Err(e) => {
            emit(&check, json!({ "ok": false, "profile": profile, "cc": cc.name(), "error": format!("{e:#}") }));
            Err(e)
        }
    }
}
