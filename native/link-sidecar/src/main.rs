//! clover-link-sidecar: the S1 transport spike's native half (lane H, M0).
//!
//! ```text
//! clover-link-sidecar local-bench --transport quinn|iroh [--cc cubic|bbr|newreno] [--quick]
//! clover-link-sidecar serve --transport quinn|iroh --bind 0.0.0.0:47000 --info-file f.json
//! clover-link-sidecar bench --info-file f.json --connect ip:port --profile name
//! clover-link-sidecar punch --transport quinn|iroh --name a|b --port P --stun ip:port --rendezvous dir
//! clover-link-sidecar stun-server --bind 0.0.0.0:3478
//! clover-link-sidecar stun-query --server stun.cloudflare.com:3478
//! clover-link-sidecar ipc
//! ```
//!
//! Every measuring command prints one `S1RESULT <json>` line (and a GitHub `::notice` annotation
//! when S1_ANNOTATE=1), the same format as the Bun checks in spikes/s1-transport/bun.

mod bench;
mod ipc;
mod link;
mod punch;
mod stun;

use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

pub struct Args(Vec<String>);

impl Args {
    pub fn get(&self, key: &str) -> Option<String> {
        let flag = format!("--{key}");
        self.0.iter().position(|a| *a == flag).and_then(|i| self.0.get(i + 1)).cloned()
    }
    pub fn get_or(&self, key: &str, fallback: &str) -> String {
        self.get(key).unwrap_or_else(|| fallback.to_string())
    }
    pub fn flag(&self, key: &str) -> bool {
        let flag = format!("--{key}");
        self.0.iter().any(|a| *a == flag)
    }
    pub fn num<T: FromStr>(&self, key: &str, fallback: T) -> T {
        self.get(key).and_then(|v| v.parse().ok()).unwrap_or(fallback)
    }
}

pub fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e6).round() / 1e3
}

pub fn summary(samples: &[f64]) -> Value {
    let mut s = samples.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| -> f64 {
        if s.is_empty() {
            return f64::NAN;
        }
        let i = ((p / 100.0 * s.len() as f64).ceil() as usize).clamp(1, s.len()) - 1;
        (s[i] * 1000.0).round() / 1000.0
    };
    let mean = if s.is_empty() { f64::NAN } else { s.iter().sum::<f64>() / s.len() as f64 };
    json!({ "n": s.len(), "p50": q(50.0), "p90": q(90.0), "p99": q(99.0), "max": q(100.0), "mean": (mean * 1000.0).round() / 1000.0 })
}

pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        o => o,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        a => a,
    };
    format!("{os}-{arch}")
}

pub fn emit(check: &str, body: Value) {
    let mut line = json!({ "check": check, "platform": platform(), "runtime": "native" });
    if let (Value::Object(o), Value::Object(b)) = (&mut line, body) {
        o.extend(b);
    }
    let text = line.to_string();
    println!("S1RESULT {text}");
    if std::env::var("S1_ANNOTATE").as_deref() == Ok("1") {
        println!("::notice title={check} {}::{text}", platform());
    }
}

fn usage() -> ! {
    eprintln!("usage: clover-link-sidecar <local-bench|serve|bench|punch|stun-server|stun-query|ipc> [options]");
    std::process::exit(2)
}

fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first().cloned() else { usage() };
    let args = Args(argv);
    match cmd.as_str() {
        "ipc" => ipc::run(),
        "stun-server" => stun::serve(args.get_or("bind", "0.0.0.0:3478").parse()?),
        "stun-query" => {
            let server = args.get_or("server", "stun.cloudflare.com:3478");
            let addr: SocketAddr = server.to_socket_addrs()?.find(|a| a.is_ipv4()).context("resolve STUN server")?;
            let sock = UdpSocket::bind("0.0.0.0:0")?;
            let t = std::time::Instant::now();
            let res = stun::query(&sock, addr, 3, Duration::from_millis(800));
            let body = match res {
                Ok(r) => json!({ "ok": true, "server": server, "reflexive": r.to_string(), "ms": ms(t.elapsed()) }),
                Err(e) => json!({ "ok": false, "server": server, "error": format!("{e:#}") }),
            };
            emit("stun-query", body);
            Ok(())
        }
        "local-bench" | "serve" | "bench" | "punch" => {
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            rt.block_on(async {
                match cmd.as_str() {
                    "local-bench" => bench::local(&args).await,
                    "serve" => bench::serve(&args).await,
                    "bench" => bench::client(&args).await,
                    _ => punch::run(&args).await,
                }
            })
        }
        _ => usage(),
    }
}
