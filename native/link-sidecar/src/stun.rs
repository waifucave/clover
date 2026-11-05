//! A minimal RFC 5389 STUN binding client and responder. The responder is the lab's stand-in for
//! the public STUN servers spec §8.3 names (Cloudflare's and Google's); the client speaks to
//! those unchanged (`stun.cloudflare.com:3478`, `stun.l.google.com:19302`).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::Duration;

use anyhow::{bail, Result};

const MAGIC: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

fn txid() -> [u8; 12] {
    let mut t = [0u8; 12];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut t).expect("random");
    t
}

fn request(tx: &[u8; 12]) -> Vec<u8> {
    let mut m = Vec::with_capacity(20);
    m.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    m.extend_from_slice(&0u16.to_be_bytes());
    m.extend_from_slice(&MAGIC.to_be_bytes());
    m.extend_from_slice(tx);
    m
}

fn parse_response(buf: &[u8], tx: &[u8; 12]) -> Option<SocketAddr> {
    if buf.len() < 20 || u16::from_be_bytes([buf[0], buf[1]]) != BINDING_SUCCESS {
        return None;
    }
    if u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) != MAGIC || &buf[8..20] != tx {
        return None;
    }
    let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let attrs = buf.get(20..20 + len)?;
    let mut i = 0;
    let mut plain = None;
    while i + 4 <= attrs.len() {
        let t = u16::from_be_bytes([attrs[i], attrs[i + 1]]);
        let l = u16::from_be_bytes([attrs[i + 2], attrs[i + 3]]) as usize;
        let v = attrs.get(i + 4..i + 4 + l)?;
        if (t == ATTR_XOR_MAPPED_ADDRESS || t == ATTR_MAPPED_ADDRESS) && v.len() >= 8 {
            let xor = t == ATTR_XOR_MAPPED_ADDRESS;
            let mut port = u16::from_be_bytes([v[2], v[3]]);
            if xor {
                port ^= (MAGIC >> 16) as u16;
            }
            let ip = match v[1] {
                0x01 => {
                    let mut o = [v[4], v[5], v[6], v[7]];
                    if xor {
                        for (k, b) in o.iter_mut().zip(MAGIC.to_be_bytes()) {
                            *k ^= b;
                        }
                    }
                    IpAddr::V4(Ipv4Addr::from(o))
                }
                0x02 if v.len() >= 20 => {
                    let mut o = [0u8; 16];
                    o.copy_from_slice(&v[4..20]);
                    if xor {
                        let mut key = [0u8; 16];
                        key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                        key[4..].copy_from_slice(tx);
                        for (k, b) in o.iter_mut().zip(key) {
                            *k ^= b;
                        }
                    }
                    IpAddr::V6(Ipv6Addr::from(o))
                }
                _ => return None,
            };
            let addr = SocketAddr::new(ip, port);
            if xor {
                return Some(addr);
            }
            plain = Some(addr);
        }
        i += 4 + l.div_ceil(4) * 4;
    }
    plain
}

/// Asks `server` for this socket's public address. The socket stays usable afterwards, so the
/// answer describes the NAT mapping that later traffic from the same socket will use.
pub fn query(sock: &UdpSocket, server: SocketAddr, tries: u32, per_try: Duration) -> Result<SocketAddr> {
    let tx = txid();
    let req = request(&tx);
    let old = sock.read_timeout()?;
    sock.set_read_timeout(Some(per_try))?;
    let mut buf = [0u8; 1500];
    let mut result = None;
    'outer: for _ in 0..tries {
        sock.send_to(&req, server)?;
        let deadline = std::time::Instant::now() + per_try;
        while std::time::Instant::now() < deadline {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) if from == server => {
                    if let Some(a) = parse_response(&buf[..n], &tx) {
                        result = Some(a);
                        break 'outer;
                    }
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(e) => return Err(e.into()),
            }
        }
    }
    sock.set_read_timeout(old)?;
    match result {
        Some(a) => Ok(a),
        None => bail!("no STUN answer from {server}"),
    }
}

/// `stun-server --bind 0.0.0.0:3478`: answers binding requests with XOR-MAPPED-ADDRESS.
pub fn serve(bind: SocketAddr) -> Result<()> {
    let sock = UdpSocket::bind(bind)?;
    eprintln!("stun responder on {bind}");
    let mut buf = [0u8; 1500];
    loop {
        let (n, from) = sock.recv_from(&mut buf)?;
        if n < 20 || u16::from_be_bytes([buf[0], buf[1]]) != BINDING_REQUEST {
            continue;
        }
        if u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) != MAGIC {
            continue;
        }
        let mut tx = [0u8; 12];
        tx.copy_from_slice(&buf[8..20]);
        let mut attr = Vec::new();
        attr.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        match from.ip() {
            IpAddr::V4(ip) => {
                attr.extend_from_slice(&8u16.to_be_bytes());
                attr.extend_from_slice(&[0, 0x01]);
                attr.extend_from_slice(&(from.port() ^ (MAGIC >> 16) as u16).to_be_bytes());
                let o = ip.octets();
                let m = MAGIC.to_be_bytes();
                attr.extend_from_slice(&[o[0] ^ m[0], o[1] ^ m[1], o[2] ^ m[2], o[3] ^ m[3]]);
            }
            IpAddr::V6(ip) => {
                attr.extend_from_slice(&20u16.to_be_bytes());
                attr.extend_from_slice(&[0, 0x02]);
                attr.extend_from_slice(&(from.port() ^ (MAGIC >> 16) as u16).to_be_bytes());
                let mut key = [0u8; 16];
                key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                key[4..].copy_from_slice(&tx);
                for (b, k) in ip.octets().iter().zip(key) {
                    attr.push(b ^ k);
                }
            }
        }
        let mut resp = Vec::with_capacity(20 + attr.len());
        resp.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        resp.extend_from_slice(&(attr.len() as u16).to_be_bytes());
        resp.extend_from_slice(&MAGIC.to_be_bytes());
        resp.extend_from_slice(&tx);
        resp.extend_from_slice(&attr);
        let _ = sock.send_to(&resp, from);
    }
}
