//! `punch`: one peer of a NAT-traversal attempt in nat/matrix.sh. Each side learns its public
//! address with STUN on the port it will use, publishes `{identity, candidates, mapping,
//! relayUrl}` to a rendezvous folder (the waifucave handshake's job), reads the other side's,
//! and then dials and accepts at once.
//!
//! Relay-free by default. With `--relay-url` (iroh only) the endpoint also uses the lab's relay,
//! and `--policy` decides when a dial includes the peer's relay:
//!
//! * `direct`: never; the relay is only the endpoint's home relay (and QAD, if its port is given)
//! * `race`: from the first packet, next to the direct addresses
//! * `headstart`: direct first, then the relay after `--headstart-ms` without a connection
//! * `auto`: `headstart` when both sides' mappings are endpoint-independent (two STUN servers
//!   saw the same address), `race` otherwise (report, edit 6 option (c))
//!
//! `--redial-ms N` dials the direct candidates a second time N ms after the first; with
//! `--initial-rtt-ms` the first Initial is resent after 3x that instead of 999 ms.

use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::link::{Conn, Endpoint, Kind, Opts};
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

/// The relay server's counters, as `relay-server --metrics-file` writes them every 50 ms.
fn relay_metrics(path: Option<&str>) -> Option<Value> {
    let text = std::fs::read_to_string(path?).ok()?;
    serde_json::from_str(&text).ok()
}

fn metrics_delta(before: &Option<Value>, after: &Option<Value>) -> Value {
    let (Some(Value::Object(b)), Some(Value::Object(a))) = (before, after) else { return Value::Null };
    let mut out = serde_json::Map::new();
    for (k, v) in a {
        if let (Some(x), Some(y)) = (v.as_u64(), b.get(k).and_then(Value::as_u64)) {
            if k != "t" {
                out.insert(k.clone(), json!(x.saturating_sub(y)));
            }
        }
    }
    Value::Object(out)
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

/// How a dial picked up the first connection.
#[derive(Clone, Copy)]
enum Via {
    Accepted,
    Direct,
    Redial,
    Relay,
    Race,
}

impl Via {
    fn name(self) -> &'static str {
        match self {
            Via::Accepted => "accepted",
            Via::Direct => "dialed",
            Via::Redial => "dialed-again",
            Via::Relay => "dialed-relay",
            Via::Race => "dialed-race",
        }
    }
}

async fn attempt(a: &Args, kind: Kind, name: &str, strategy: &str) -> Result<Value> {
    let other = if name == "a" { "b" } else { "a" };
    let port: u16 = a.num("port", 47000);
    // 0.0.0.0 in the netns lab; 127.0.0.1 for a smoke test on a desktop, where binding every
    // interface could raise the OS firewall's prompt.
    let bind_ip: std::net::IpAddr = a.get_or("bind-ip", "0.0.0.0").parse().context("--bind-ip")?;
    let stun_server: SocketAddr = a.get("stun").context("--stun ip:port")?.parse()?;
    let stun2: Option<SocketAddr> = a.get("stun2").map(|s| s.parse()).transpose().context("--stun2 ip:port")?;
    let dir = PathBuf::from(a.get("rendezvous").context("--rendezvous dir")?);
    let timeout = Duration::from_secs(a.num("timeout", 10));
    let opts = Opts::from_args(a)?;
    let policy = a.get_or("policy", "direct");
    let headstart = Duration::from_millis(a.num("headstart-ms", 500));
    let redial = Duration::from_millis(a.num("redial-ms", 0));
    let metrics_file = a.get("relay-metrics");
    if opts.relay.is_some() && kind != Kind::Iroh {
        bail!("only iroh has a relay");
    }
    if !matches!(policy.as_str(), "direct" | "race" | "headstart" | "auto") {
        bail!("--policy direct|race|headstart|auto, not {policy}");
    }
    let metrics_at_start = relay_metrics(metrics_file.as_deref());
    let t0 = Instant::now();

    // 1. The socket, its public address as the STUN server sees it, and whether that address
    //    depends on the destination (a second STUN server at another address).
    let sock = UdpSocket::bind((bind_ip, port))?;
    let reflexive = stun::query(&sock, stun_server, 3, Duration::from_millis(700));
    let reflexive2 = stun2.map(|s| stun::query(&sock, s, 3, Duration::from_millis(700)));
    let stun_ms = ms(t0.elapsed());
    let mapping = match (&reflexive, &reflexive2) {
        (Ok(r1), Some(Ok(r2))) if r1 == r2 => "independent",
        (Ok(_), Some(Ok(_))) => "dependent",
        _ => "unknown",
    };
    let local_ip = {
        let probe = UdpSocket::bind((bind_ip, 0))?;
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
    let ep = Arc::new(Endpoint::bind(kind, sock, &opts).await?);
    let bind_ms = ms(t0.elapsed());
    // With a relay, start dialling only once the endpoint is online with its first net report,
    // as a long-running daemon would be; the relay's counters then separate start-up from dial.
    let settled = ep.settle(Duration::from_secs(6)).await;
    let metrics_at_settled = relay_metrics(metrics_file.as_deref());

    // 2. Exchange records through the rendezvous folder.
    let me = json!({ "identity": ep.identity(), "candidates": candidates, "mapping": mapping, "relayUrl": ep.relay_url() });
    write_atomic(&dir.join(format!("{name}.json")), &me.to_string())?;
    let peer: Value = serde_json::from_str(&wait_for_file(&dir.join(format!("{other}.json")), Duration::from_secs(30)).await?)?;
    let peer_id = peer["identity"].as_str().unwrap_or_default().to_string();
    let peer_cands: Vec<SocketAddr> =
        peer["candidates"].as_array().into_iter().flatten().filter_map(|v| v.as_str()?.parse().ok()).collect();
    let peer_mapping = peer["mapping"].as_str().unwrap_or("unknown").to_string();
    let peer_relay = peer["relayUrl"].as_str().map(str::to_string);
    let t_ready = Instant::now();
    let metrics_at_ready = relay_metrics(metrics_file.as_deref());

    // Option (c): race the relay unless both mappings are endpoint-independent.
    let effective = match policy.as_str() {
        "auto" if mapping == "independent" && peer_mapping == "independent" => "headstart",
        "auto" => "race",
        p => p,
    }
    .to_string();
    if effective != "direct" && peer_relay.is_none() {
        bail!("policy {effective} needs the peer's relay URL");
    }

    // 3. Connect: accept always; dial per strategy and policy; quinn also punches from its socket.
    let (tx, mut rx) = mpsc::channel::<(Conn, Via)>(8);
    let connected = Arc::new(AtomicBool::new(false));
    let dials = Arc::new(Mutex::new(Vec::<Value>::new()));
    {
        let ep = ep.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Ok(Some(c)) = ep.accept().await {
                tokio::spawn(bench::serve_conn(c.clone()));
                let _ = tx.send((c, Via::Accepted)).await;
            }
        });
    }
    let dialing = strategy == "both" || name == "a";
    let spawn_dial = |via: Via, after: Duration, with_relay: bool| {
        let ep = ep.clone();
        let tx = tx.clone();
        let peer_id = peer_id.clone();
        let peer_cands = peer_cands.clone();
        let peer_relay = peer_relay.clone();
        let connected = connected.clone();
        let dials = dials.clone();
        tokio::spawn(async move {
            if !after.is_zero() {
                tokio::time::sleep(after).await;
                if connected.load(Ordering::Relaxed) {
                    return;
                }
            }
            let at_ms = ms(t_ready.elapsed());
            let relay = if with_relay { peer_relay.as_deref() } else { None };
            let res = ep.connect_via(&peer_id, &peer_cands, relay).await;
            let mut d = json!({ "via": via.name(), "startedMs": at_ms, "doneMs": ms(t_ready.elapsed()) });
            match res {
                Ok(c) => {
                    d["ok"] = json!(true);
                    tokio::spawn(bench::serve_conn(c.clone()));
                    let _ = tx.send((c, via)).await;
                }
                Err(e) => {
                    d["ok"] = json!(false);
                    d["error"] = json!(format!("{e:#}"));
                }
            }
            dials.lock().unwrap().push(d);
        });
    };
    if dialing {
        match effective.as_str() {
            "race" => spawn_dial(Via::Race, Duration::ZERO, true),
            _ => {
                spawn_dial(Via::Direct, Duration::ZERO, false);
                if !redial.is_zero() {
                    spawn_dial(Via::Redial, redial, false);
                }
                if effective == "headstart" {
                    spawn_dial(Via::Relay, headstart, true);
                }
            }
        }
    }
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
        "reflexive2": reflexive2.as_ref().map(|r| r.as_ref().map(|x| x.to_string()).unwrap_or_else(|e| format!("error: {e}"))),
        "mapping": mapping,
        "peerMapping": peer_mapping,
        "candidates": candidates,
        "peerCandidates": peer_cands,
        "stunMs": stun_ms,
        "bindMs": bind_ms,
        "punchesSent": punches_sent,
        "policy": policy,
        "effectivePolicy": effective,
        "headstartMs": if effective == "headstart" { json!(headstart.as_millis() as u64) } else { Value::Null },
        "redialMs": if redial.is_zero() { Value::Null } else { json!(redial.as_millis() as u64) },
        "tuning": opts.json(),
        "settled": settled,
    });
    let done_file = dir.join("a.done");
    let (conn, how) = match first {
        Ok(Some(x)) => x,
        _ => {
            if name == "a" {
                let _ = write_atomic(&done_file, "fail");
            }
            body["ok"] = json!(false);
            let tried = dials.lock().unwrap().clone();
            body["dials"] = json!(tried);
            body["error"] = json!(format!("no connection within {} s", timeout.as_secs()));
            body["relayStartup"] = metrics_delta(&metrics_at_start, &metrics_at_settled);
            body["relayWhileExchanging"] = metrics_delta(&metrics_at_settled, &metrics_at_ready);
            body["relayDuringDial"] = metrics_delta(&metrics_at_ready, &relay_metrics(metrics_file.as_deref()));
            ep.close().await;
            return Ok(body);
        }
    };
    let metrics_at_connect = relay_metrics(metrics_file.as_deref());
    body["connectMs"] = json!(connect_ms);
    body["totalMs"] = json!(total_ms);
    body["how"] = json!(how.name());
    body["pathAtConnect"] = conn.path_json();
    body["relayPathAtConnect"] = json!(conn.has_relay_path());

    // 4. Prove data flows, then wait for the other side.
    if name == "a" {
        let rpc = bench::rpc_on_one_stream(&conn, 20, 0, Duration::ZERO, None).await;
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
        body["pathAfterRpc"] = conn.path_json();
        body["relayPathAfterRpc"] = json!(conn.has_relay_path());
        body["relayAfterConnect"] = metrics_delta(&metrics_at_connect, &relay_metrics(metrics_file.as_deref()));
        // Does iroh remember the peer's relay? Close this connection and dial again with the
        // direct addresses only, as a direct-first policy would on the next connection.
        if a.flag("second-direct-dial") {
            conn.close();
            tokio::time::sleep(Duration::from_millis(200)).await;
            let before = relay_metrics(metrics_file.as_deref());
            let t = Instant::now();
            body["second"] = match tokio::time::timeout(timeout, ep.connect_via(&peer_id, &peer_cands, None)).await {
                Ok(Ok(c2)) => {
                    let connect_ms = ms(t.elapsed());
                    let at_connect = json!(c2.has_relay_path());
                    let _ = bench::rpc_on_one_stream(&c2, 5, 0, Duration::ZERO, None).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let v = json!({
                        "ok": true, "connectMs": connect_ms, "relayPathAtConnect": at_connect,
                        "relayPathAfterRpc": c2.has_relay_path(), "pathAfterRpc": c2.path_json(),
                        "relayDuring": metrics_delta(&before, &relay_metrics(metrics_file.as_deref())),
                    });
                    c2.close();
                    v
                }
                Ok(Err(e)) => json!({ "ok": false, "error": format!("{e:#}") }),
                Err(_) => json!({ "ok": false, "error": "timed out" }),
            };
        }
        let _ = write_atomic(&done_file, if body["ok"] == json!(true) { "ok" } else { "fail" });
    } else {
        let _ = wait_for_file(&done_file, timeout * 2 + Duration::from_secs(5)).await;
        body["ok"] = json!(true);
        body["pathAfterRpc"] = conn.path_json();
        body["relayPathAfterRpc"] = json!(conn.has_relay_path());
        body["relayAfterConnect"] = metrics_delta(&metrics_at_connect, &relay_metrics(metrics_file.as_deref()));
    }
    body["dials"] = json!(dials.lock().unwrap().clone());
    // Relay use while both endpoints started (home relay, QAD), while they swapped records, while
    // this pair dialled, and while it then exchanged 20 RPCs. Both peers run at once, so each
    // window covers both of them.
    body["relayStartup"] = metrics_delta(&metrics_at_start, &metrics_at_settled);
    body["relayWhileExchanging"] = metrics_delta(&metrics_at_settled, &metrics_at_ready);
    body["relayDuringDial"] = metrics_delta(&metrics_at_ready, &metrics_at_connect);
    conn.close();
    ep.close().await;
    Ok(body)
}
