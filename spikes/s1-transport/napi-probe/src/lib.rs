//! Byte passing across napi, the four ways a link binding could do it. `@number0/iroh` 1.2.0
//! takes and returns `Vec<u8>`, which napi-rs maps to a JS `Array<number>`, element by element.

use napi::bindgen_prelude::{Buffer, Uint8Array};
use napi_derive::napi;

/// Like @number0/iroh's `SendStream.write`: an `Array<number>` in.
#[napi]
pub fn sink_vec(buf: Vec<u8>) -> u32 {
    buf.len() as u32
}

/// Like @number0/iroh's `RecvStream.read`: an `Array<number>` out.
#[napi]
pub fn source_vec(len: u32) -> Vec<u8> {
    vec![1u8; len as usize]
}

/// A typed array in, copied out of JS memory as a binding must before handing the bytes to
/// iroh's send (the copy makes the GB/s a throughput, not just a per-call cost).
#[napi]
pub fn sink_typed(buf: Uint8Array) -> u32 {
    let owned = buf.to_vec();
    std::hint::black_box(&owned);
    owned.len() as u32
}

/// A Buffer out: one allocation, handed to JS without a per-byte conversion.
#[napi]
pub fn source_buffer(len: u32) -> Buffer {
    vec![1u8; len as usize].into()
}

/// The async shape every iroh call has: work on a runtime thread, resolved on the JS thread.
/// The bytes are copied on the runtime thread, as a binding's send would.
#[napi]
pub async fn sink_typed_async(buf: Uint8Array) -> u32 {
    let owned = buf.to_vec();
    std::hint::black_box(&owned);
    owned.len() as u32
}

#[napi]
pub async fn source_buffer_async(len: u32) -> Buffer {
    vec![1u8; len as usize].into()
}

#[napi]
pub async fn sink_vec_async(buf: Vec<u8>) -> u32 {
    buf.len() as u32
}

#[napi]
pub async fn source_vec_async(len: u32) -> Vec<u8> {
    vec![1u8; len as usize]
}
