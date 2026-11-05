//! `ipc`: the sidecar's local hop to clover-core, over its stdin and stdout. Frames are a
//! big-endian u32 length and that many bytes; the prototype echoes each frame, which is enough
//! to measure what the hop costs (spec §8.3: "adds microseconds"). A real sidecar would carry
//! link streams in these frames.

use std::io::{BufReader, BufWriter, Read, Write};

use anyhow::Result;

pub fn run() -> Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = BufReader::with_capacity(1 << 20, stdin.lock());
    let mut output = BufWriter::with_capacity(1 << 20, stdout.lock());
    let mut len = [0u8; 4];
    let mut buf = Vec::new();
    loop {
        if input.read_exact(&mut len).is_err() {
            break;
        }
        let n = u32::from_be_bytes(len) as usize;
        buf.resize(n, 0);
        input.read_exact(&mut buf)?;
        output.write_all(&len)?;
        output.write_all(&buf)?;
        // Flush once the input runs dry, so a burst coalesces but a lone RPC goes out at once.
        // (Only `buffer()`: `fill_buf()` would block on an empty buffer and stall the reply.)
        if input.buffer().is_empty() {
            output.flush()?;
        }
    }
    output.flush()?;
    Ok(())
}
