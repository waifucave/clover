//! A minimal reproduction for an upstream report, cut down from `bench.rs`'s `ping`: iroh 1.4.1
//! with relays off, how long one open connection goes without replies after the client's address
//! changes. `serve` runs in one network namespace and `ping` in the other
//! (`spikes/s1-transport/nat/iroh-address-change.sh` sets both up and changes the address).
//!
//!   iroh_address_change serve <ip:port>                  prints its endpoint id, echoes streams
//!   iroh_address_change ping <ip:port> <id> <seconds>    a 64-byte echo every 50 ms on one stream
//!
//! `RUST_LOG` turns on iroh's logs.
use std::time::{Duration, Instant};

use anyhow::Result;
use iroh::endpoint::{presets, PortmapperConfig};
use iroh::{Endpoint, EndpointAddr, RelayMode, TransportAddr};

const ALPN: &[u8] = b"repro/echo";

async fn bind(addr: &str) -> Result<Endpoint> {
    let ep = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .portmapper_config(PortmapperConfig::Disabled)
        .clear_ip_transports()
        .bind_addr(addr.parse::<std::net::SocketAddr>()?)?
        .bind()
        .await?;
    Ok(ep)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            let ep = bind(&args[2]).await?;
            println!("{}", ep.id());
            while let Some(incoming) = ep.accept().await {
                tokio::spawn(async move {
                    let conn = incoming.accept()?.await?;
                    let (mut send, mut recv) = conn.accept_bi().await?;
                    tokio::io::copy(&mut recv, &mut send).await?;
                    send.finish()?;
                    // Keep the connection until the client closes it, so the last echoes arrive.
                    conn.closed().await;
                    anyhow::Ok(())
                });
            }
        }
        Some("ping") => {
            let secs: u64 = args[4].parse()?;
            let ep = bind("0.0.0.0:0").await?;
            let addr =
                EndpointAddr::from_parts(args[3].parse()?, [TransportAddr::Ip(args[2].parse()?)]);
            let conn = ep.connect(addr, ALPN).await?;
            let (mut send, mut recv) = conn.open_bi().await?;
            let start = Instant::now();
            let total = secs * 20;
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(50));
                for _ in 0..total {
                    tick.tick().await;
                    send.write_all(&[0u8; 64]).await?;
                }
                anyhow::Ok(())
            });
            // Replies, and every wait of over a second between two of them (from, to), in seconds.
            let (mut got, mut last, mut gaps) = (0, 0.0f64, Vec::new());
            let mut buf = [0u8; 64];
            while got < total {
                match tokio::time::timeout(Duration::from_secs(20), recv.read_exact(&mut buf)).await
                {
                    Ok(Ok(())) => got += 1,
                    _ => break,
                }
                let now = start.elapsed().as_secs_f64();
                if now - last > 1.0 {
                    gaps.push(format!(
                        "{:.2} s from {last:.2} s to {now:.2} s",
                        now - last
                    ));
                }
                last = now;
            }
            println!(
                "sent for {secs} s: {got}/{total} echoes back; gaps over 1 s: {}",
                if gaps.is_empty() {
                    "none".to_string()
                } else {
                    gaps.join(", ")
                }
            );
            conn.close(0u32.into(), b"done");
            ep.close().await;
        }
        _ => eprintln!(
            "usage: iroh_address_change serve <ip:port> | ping <ip:port> <endpoint id> <seconds>"
        ),
    }
    Ok(())
}
