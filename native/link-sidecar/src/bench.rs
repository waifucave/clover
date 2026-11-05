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

/// `ping`: one 64-byte echo every `--interval-ms` for `--duration-s` on one connection, sent
/// without waiting for replies, while nat/migrate.sh changes the client's address or blacks the
/// link out. Records when replies arrive, so the longest gap shows how long the link was gone,
/// and whether replies came back at all. With `--rebind-trigger <file>`, the client calls
/// `network_changed()` (quinn: rebind to a new socket; iroh: `network_change()`) as soon as that
/// file appears, the way clover-core would on the OS's network-change event.
pub async fn ping(a: &Args) -> Result<()> {
    use std::sync::atomic::AtomicU64;
    let info: Value = serde_json::from_str(&std::fs::read_to_string(a.get_or("info-file", "server.json"))?)?;
    let kind: Kind = info["transport"].as_str().unwrap_or("quinn").parse()?;
    let label = a.get_or("label", "");
    let interval = Duration::from_millis(a.num("interval-ms", 50));
    let duration = Duration::from_secs(a.num("duration-s", 12));
    let grace = Duration::from_secs(a.num("grace-s", 10));
    let trigger = a.get("rebind-trigger");
    let res: Result<Value> = async {
        let target: SocketAddr = a.get("connect").context("--connect ip:port")?.parse()?;
        let ep = Arc::new(Endpoint::bind(kind, UdpSocket::bind("0.0.0.0:0")?, Cc::Cubic).await?);
        let conn = tokio::time::timeout(
            Duration::from_secs(15),
            ep.connect(info["identity"].as_str().unwrap_or_default(), &[target]),
        )
        .await
        .context("connect timeout")??;
        let path_before = conn.path_json();
        let (mut send, mut recv) = conn.open_bi(10).await?;
        send.write_all(b"E").await?;
        let start = Instant::now();
        let rebind_at = Arc::new(std::sync::Mutex::new(None::<(f64, Option<String>)>));
        if let Some(path) = trigger.clone() {
            let ep = ep.clone();
            let rebind_at = rebind_at.clone();
            tokio::spawn(async move {
                while start.elapsed() < duration + grace {
                    if std::path::Path::new(&path).exists() {
                        let at = start.elapsed().as_secs_f64();
                        let err = ep.network_changed().await.err().map(|e| format!("{e:#}"));
                        *rebind_at.lock().unwrap() = Some((at, err));
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
        }
        let sent = Arc::new(AtomicU64::new(0));
        let writer = {
            let sent = sent.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(interval);
                while start.elapsed() < duration {
                    tick.tick().await;
                    let seq = sent.load(Ordering::Relaxed);
                    let mut frame = [0u8; FRAME];
                    frame[..8].copy_from_slice(&seq.to_be_bytes());
                    frame[8..16].copy_from_slice(&(start.elapsed().as_micros() as u64).to_be_bytes());
                    if send.write_all(&frame).await.is_err() {
                        return send;
                    }
                    sent.store(seq + 1, Ordering::Relaxed);
                }
                send
            })
        };
        let mut arrivals: Vec<(f64, f64)> = Vec::new(); // (arrival s, rtt ms)
        let mut read_error = None;
        let deadline = duration + grace;
        let mut back = [0u8; FRAME];
        loop {
            let left = deadline.saturating_sub(start.elapsed());
            if left.is_zero() {
                break;
            }
            match tokio::time::timeout(left, recv.read_exact(&mut back)).await {
                Ok(Ok(())) => {
                    let sent_us = u64::from_be_bytes(back[8..16].try_into().unwrap());
                    let now_s = start.elapsed().as_secs_f64();
                    arrivals.push((now_s, now_s * 1000.0 - sent_us as f64 / 1000.0));
                    if writer.is_finished() && arrivals.len() as u64 >= sent.load(Ordering::Relaxed) {
                        break; // every frame the writer sent has come back
                    }
                }
                Ok(Err(e)) => {
                    read_error = Some(format!("{e:#}"));
                    break;
                }
                Err(_) => break,
            }
        }
        let end_s = start.elapsed().as_secs_f64();
        writer.abort();
        let rebind = rebind_at.lock().unwrap().clone();
        let mut body = ping_json(kind, &label, sent.load(Ordering::Relaxed), &arrivals, end_s, read_error);
        body["rebindAtS"] = json!(rebind.as_ref().map(|r| (r.0 * 100.0).round() / 100.0));
        body["rebindError"] = json!(rebind.and_then(|r| r.1));
        body["pathBefore"] = path_before;
        body["pathAfter"] = conn.path_json();
        Ok(body)
    }
    .await;
    match res {
        Ok(body) => emit("ping", body),
        Err(e) => emit("ping", json!({ "ok": false, "transport": kind.name(), "label": label, "error": format!("{e:#}") })),
    }
    Ok(())
}

fn ping_json(kind: Kind, label: &str, sent: u64, arrivals: &[(f64, f64)], end_s: f64, error: Option<String>) -> Value {
    let received = arrivals.len() as u64;
    let recovered = error.is_none() && sent > 0 && received == sent;
    // The longest wait between replies, counting the silence after the last one if replies
    // stopped before the end.
    let mut max_gap = 0.0f64;
    let mut gap_at = 0.0f64;
    for w in arrivals.windows(2) {
        let g = (w[1].0 - w[0].0) * 1000.0;
        if g > max_gap {
            max_gap = g;
            gap_at = w[0].0;
        }
    }
    let last = arrivals.last().map(|x| x.0).unwrap_or(0.0);
    if !recovered && (end_s - last) * 1000.0 > max_gap {
        max_gap = (end_s - last) * 1000.0;
        gap_at = last;
    }
    let rtts: Vec<f64> = arrivals.iter().map(|x| x.1).collect();
    json!({
        "ok": recovered,
        "transport": kind.name(),
        "label": label,
        "sent": sent,
        "received": received,
        "recovered": recovered,
        "connectionLost": error.is_some(),
        "lastReplyAtS": (last * 100.0).round() / 100.0,
        "maxGapMs": (max_gap * 10.0).round() / 10.0,
        "maxGapAtS": (gap_at * 100.0).round() / 100.0,
        "rtt": summary(&rtts),
        "error": error,
    })
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
