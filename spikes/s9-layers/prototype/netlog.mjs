/** Decode netlog and join resolver BEGIN/END by source id. No raw artifacts needed for review.
 * @param {any} log */
export function extractNetlog(log) {
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([k,v]) => [v,k]));
  const phases = new Map(Object.entries(log.constants.logEventPhase || {}).map(([k,v])=>[v,k]));
  const events = log.events.filter((/** @type {any} */ e) => /HOST_RESOLVER|DNS|NETWORK_ACCESS|CONNECTION_ALLOWLIST|PRECONNECT/.test(names.get(e.type)||''))
    .map((/** @type {any} */ e)=>({...e,event:names.get(e.type),phaseName:phases.get(e.phase)}));
  return {events, speculative:events.filter((/** @type {any} */ e)=>e.params?.is_speculative), errors:events.filter((/** @type {any} */ e)=>e.params?.net_error < 0)};
}
