export const SCHEME = 'clover-plugin';
/** @param {string} id */
export function pluginHost(id) {
  const parts = id.split('/');
  if (parts.length > 2 || parts.some(p => p.length < 2 || p.length > 40 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(p))) throw new Error('invalid plugin id');
  // Prefix before encoding: xn/child must never become an IDNA xn-- label.
  return `p-${parts.join('--')}`;
}
/** Exact origin registry; ports and schemes are part of fixture grants.
 * @param {string} url @param {string|undefined} initiatorOrigin
 * @param {Map<string,Set<string>>} registry */
export function decision(url, initiatorOrigin, registry) {
  const target = new URL(url);
  const grant = initiatorOrigin ? registry.get(initiatorOrigin) : undefined;
  return {cancel: !grant?.has(target.origin), reason: grant ? 'exact origin grant' : 'unknown or opaque initiator'};
}
/** @param {string[]} allowed @param {boolean} enabled @param {string[]} [frames] */
export function csp(allowed, enabled, frames = ["'self'"]) {
  if (!enabled) return "default-src 'self' * data: blob: 'unsafe-inline' 'unsafe-eval';";
  const network = allowed.join(' ');
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' ${network}; img-src 'self' ${network}; font-src 'self' ${network}; connect-src 'self' ${network} ${network.replaceAll('http:', 'ws:')}; worker-src 'self' blob:; frame-src ${frames.join(' ')}; form-action 'none'; object-src 'none'; base-uri 'none'`;
}
