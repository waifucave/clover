// For the services' end-to-end harnesses (services/*/test/node/serve.mjs), which run a Worker on wrangler's local
// runtime (workerd) through `createTestHarness`: the harness has a port before the Worker answers on it, and after the
// `update()` each harness makes (to give the Worker its own origin) the runtime reloads. On a slow runner (Windows CI)
// the first requests then hang or are refused, so a harness hands out its URL only once the Worker itself answers.

/**
 * Checks the harness listens on 127.0.0.1 (never `localhost`, which Windows tries as ::1 first), then waits until the
 * Worker answers `GET /` with a JSON body (its own error response; wrangler's proxy answers otherwise), each try with
 * its own timeout so a request that hangs is tried again. Logs the wait to stderr, so a slow runner shows in CI logs.
 *
 * @param {URL} url what the harness's `listen()` resolved to
 * @param {{ label: string, limitMs?: number, tryMs?: number }} options
 * @returns {Promise<string>} the origin to hand out
 */
export async function workerReady(url, { label, limitMs = 75_000, tryMs = 5_000 }) {
  if (url.hostname !== "127.0.0.1") throw new Error(`the ${label} harness listens on ${url.hostname}, not 127.0.0.1`);
  const origin = url.origin;
  const started = Date.now();
  let last = "no answer";
  while (Date.now() - started < limitMs) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(tryMs) });
      const body = await response.text();
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        process.stderr.write(`${label} harness: the Worker answered at ${origin} after ${Date.now() - started} ms\n`);
        return origin;
      }
      last = `${response.status} ${body.slice(0, 80)}`;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the ${label} Worker didn't answer at ${origin} within ${limitMs} ms (last: ${last})`);
}
