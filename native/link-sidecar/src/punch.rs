//! `punch`: one peer of a relay-free connection attempt, for the NAT matrix (S1 question 3).
//!
//! 1. Bind UDP on `--port`, and ask the STUN server for that socket's public address.
//! 2. Publish `{identity, candidates}` to `<rendezvous>/<name>.json` and wait for the other
//!    peer's file. The shared folder is the lab's stand-in for the waifucave handshake, which
//!    only exchanges addresses (spec §8.3).
//! 3. Connect. `--strategy both` (default): both peers dial each other at once while also
//!    accepting, and quinn additionally sprays 1-byte punch packets from its own socket.
//!    `--strategy one`: only peer `a` dials; `b` only accepts.
//! 4. Peer `a` runs 20 small RPCs on the first connection it has, then both report.

use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::link::{Cc, Conn, Endpoint, Kind};
use crate::{bench, emit, ms, stun, summary, Args};

fn write_atomic(path: &Path, body: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

async fn wait_for_file(path: &Path, within: Duration) -> Result<String> {
    let deadline = Instant::now() + within;
    loop {
        if let Ok(s) = std::fs::read_to_string(path) {
            return Ok(s);
        }
        if Instant::now() > deadline {
            bail!("timed out waiting for {}", path.display());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub async fn run(a: &Args) -> Result<()> {
    let kind: Kind = a.get_or("transport", "iroh").parse()?;
    let name = a.get_or("name", "a");
    let strategy = a.get_or("strategy", "both");
    let label = a.get_or("label", "");
    let mut out = json!({ "transport": kind.name(), "strategy": strategy, "name": name, "label": label });
    match attempt(a, kind, &name, &strategy).await {
        Ok(body) => {
            if let (Value::Object(o), Value::Object(b)) = (&mut out, body) {
                o.extend(b);
            }
        }
        Err(e) => {
            out["ok"] = json!(false);
            out["error"] = json!(format!("{e:#}"));
        }
    }
    emit("punch", out);
    Ok(())
}

async fn attempt(a: &Args, kind: Kind, name: &str, strategy: &str) -> Result<Value> {
    let other = if name == "a" { "b" } else { "a" };
    let port: u16 = a.num("port", 47000);
    let stun_server: SocketAddr = a.get("stun").context("--stun ip:port")?.parse()?;
    let dir = PathBuf::from(a.get("rendezvous").context("--rendezvous dir")?);
    let timeout = Duration::from_secs(a.num("timeout", 10));
    let t0 = Instant::now();

    // 1. The socket, and its public address as the STUN server sees it.
    let sock = UdpSocket::bind(("0.0.0.0", port))?;
    let reflexive = stun::query(&sock, stun_server, 3, Duration::from_millis(700));
    let stun_ms = ms(t0.elapsed());
    let local_ip = {
        let probe = UdpSocket::bind("0.0.0.0:0")?;
        probe.connect(stun_server)?;
        probe.local_addr()?.ip()
    };
    let mut candidates = vec![SocketAddr::new(local_ip, port)];
    if let Ok(r) = &reflexive {
        if !candidates.contains(r) {
            candidates.push(*r);
        }
    }
    let punch_sock = if kind == Kind::Quinn { Some(sock.try_clone()?) } else { None };
    let ep = Arc::new(Endpoint::bind(kind, sock, Cc::Cubic).await?);

    // 2. Exchange records through the rendezvous folder.
    let me = json!({ "identity": ep.identity(), "candidates": candidates });
    write_atomic(&dir.join(format!("{name}.json")), &me.to_string())?;
    let peer: Value = serde_json::from_str(&wait_for_file(&dir.join(format!("{other}.json")), Duration::from_secs(30)).await?)?;
    let peer_id = peer["identity"].as_str().unwrap_or_default().to_string();
    let peer_cands: Vec<SocketAddr> =
        peer["candidates"].as_array().into_iter().flatten().filter_map(|v| v.as_str()?.parse().ok()).collect();
    let t_ready = Instant::now();

    // 3. Connect: accept always; dial per strategy; quinn also punches from its own socket.
    let (tx, mut rx) = mpsc::channel::<(Conn, &'static str)>(4);
    {
        let ep = ep.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Ok(Some(c)) = ep.accept().await {
                tokio::spawn(bench::serve_conn(c.clone()));
                let _ = tx.send((c, "accepted")).await;
            }
        });
    }
    let dial_error = Arc::new(std::sync::Mutex::new(None::<String>));
    if strategy == "both" || name == "a" {
        let ep = ep.clone();
        let tx = tx.clone();
        let peer_id = peer_id.clone();
        let peer_cands = peer_cands.clone();
        let dial_error = dial_error.clone();
        tokio::spawn(async move {
            match ep.connect(&peer_id, &peer_cands).await {
                Ok(c) => {
                    tokio::spawn(bench::serve_conn(c.clone()));
                    let _ = tx.send((c, "dialed")).await;
                }
                Err(e) => *dial_error.lock().unwrap() = Some(format!("{e:#}")),
            }
        });
    }
    let connected = Arc::new(AtomicBool::new(false));
    let mut punches_sent = 0u32;
    let punch_task = punch_sock.map(|s| {
        let connected = connected.clone();
        let cands = peer_cands.clone();
        let rounds = (timeout.as_millis() / 100) as u32;
        std::thread::spawn(move || {
            let mut sent = 0u32;
            for _ in 0..rounds {
                if connected.load(Ordering::Relaxed) {
                    break;
                }
                for c in &cands {
                    // A lone zero byte is not a valid QUIC packet, so the peer's endpoint drops it;
                    // its only job is to open this side's NAT mapping toward the peer.
                    if s.send_to(&[0u8], c).is_ok() {
                        sent += 1;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            sent
        })
    });

    let first = tokio::time::timeout(timeout, rx.recv()).await;
    // Time it before joining the punch thread, which may still be in its 100 ms sleep.
    let connect_ms = ms(t_ready.elapsed());
    let total_ms = ms(t0.elapsed());
    connected.store(true, Ordering::Relaxed);
    if let Some(t) = punch_task {
        punches_sent = t.join().unwrap_or(0);
    }
    let mut body = json!({
        "reflexive": reflexive.as_ref().map(|r| r.to_string()).unwrap_or_else(|e| format!("error: {e}")),
        "candidates": candidates,
        "peerCandidates": peer_cands,
        "stunMs": stun_ms,
        "punchesSent": punches_sent,
    });
    let done_file = dir.join("a.done");
    let (conn, how) = match first {
        Ok(Some(x)) => x,
        _ => {
            if name == "a" {
                let _ = write_atomic(&done_file, "fail");
            }
            body["ok"] = json!(false);
            body["error"] = json!(format!(
                "no connection within {} s (dial: {})",
                timeout.as_secs(),
                dial_error.lock().unwrap().clone().unwrap_or_else(|| "not dialled or still pending".into())
            ));
            ep.close().await;
            return Ok(body);
        }
    };
    body["connectMs"] = json!(connect_ms);
    body["totalMs"] = json!(total_ms);
    body["how"] = json!(how);
    body["pathAtConnect"] = conn.path_json();

    // 4. Prove data flows, then wait for the other side.
    if name == "a" {
        let rpc = bench::rpc_on_one_stream(&conn, 20, 0, Duration::ZERO, None).await;
        let _ = write_atomic(&done_file, if rpc.is_ok() { "ok" } else { "fail" });
        match rpc {
            Ok(samples) => {
                body["ok"] = json!(true);
                body["rpc"] = summary(&samples);
            }
            Err(e) => {
                body["ok"] = json!(false);
                body["error"] = json!(format!("connected but RPC failed: {e:#}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    } else {
        let _ = wait_for_file(&done_file, timeout + Duration::from_secs(5)).await;
        body["ok"] = json!(true);
    }
    body["pathAfterRpc"] = conn.path_json();
    conn.close();
    ep.close().await;
    Ok(body)
}
