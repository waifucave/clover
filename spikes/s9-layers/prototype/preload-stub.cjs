// Defence-in-depth variant: a plugin-document preload that removes the WebRTC
// constructor globals before any page script runs. It runs in the MAIN world of
// every frame of the webContents that loads it (context isolation is off for this
// variant only, which is the whole point being measured). It touches nothing else.
const NAMES = [
  'RTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport',
  'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver',
  'webkitRTCPeerConnection', 'webkitRTCDataChannel', 'webkitRTCIceTransport',
  'webkitRTCRtpSender', 'webkitRTCRtpReceiver', 'webkitRTCRtpTransceiver',
];
const g = /** @type {any} */ (globalThis);
for (const name of NAMES) {
  try { delete g[name]; } catch (_) { /* ignore */ }
  try { Object.defineProperty(g, name, { value: undefined, configurable: true, writable: false }); } catch (_) { /* ignore */ }
}