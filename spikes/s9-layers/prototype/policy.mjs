export const SCHEME = 'clover-plugin';
export const SWITCHES = {
  'site-per-process': '',
  'disable-background-networking': '',
  'dns-prefetch-disable': '',
  'disable-features': 'PreconnectToSearch,Prerender2,SpeculationRulesPrefetch,SpeculationRulesPrerender,WebRtcHideLocalIpsWithMdns',
  'force-webrtc-ip-handling-policy': 'disable_non_proxied_udp'
};
// The WebRTC switches are candidates, NOT a claim that data channels are disabled.
export function pluginHost(id) {
  if (!/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/.test(id) || id.includes('--')) throw new Error('ambiguous plugin id');
  return id.replace('/', '--');
}
export function decision(url, initiatorOrigin, allowedHost) {
  const target = new URL(url);
  if (target.protocol === `${SCHEME}:`) return { cancel: false, reason: 'local fixture' };
  if (!initiatorOrigin || !initiatorOrigin.startsWith(`${SCHEME}://`)) return { cancel: true, reason: 'missing or unknown initiator' };
  return { cancel: !['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || target.hostname !== allowedHost, reason: 'declared host' };
}
export function csp(allowed, enabled) {
  if (!enabled) return "default-src * data: blob: 'unsafe-inline' 'unsafe-eval';";
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' ${allowed}; img-src 'self' ${allowed}; font-src 'self' ${allowed}; connect-src 'self' ${allowed} ${allowed.replace('http:', 'ws:')}; worker-src 'self' blob:; frame-src 'self' clover-plugin:; form-action 'none'; object-src 'none'; base-uri 'none'`;
}
