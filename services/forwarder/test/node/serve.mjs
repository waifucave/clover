// Runs the forwarder Worker on wrangler's local runtime (workerd), for the forwarder plugin's end-to-end test
// (plugins/clover/plugins/forwarder/test/e2e.test.ts), which talks to it over real sockets from Bun.
//
// Input:  FORWARDER_E2E (environment, JSON): { jwks, issuer, tagKeys, accountIdKey, ticketSecret }, all made
//         by the test in memory for this run. Nothing is written to disk but wrangler's own local state folder.
// Output: one JSON line {"url": "..."} once listening, then one {"ok":...} line per command.
// Stdin:  JSON commands, one per line: {"op":"evict","tag":"...","webSockets":"hibernate"|"close"}, where tag
//         is an account's tag (its Durable Object is named by the id inside it). When stdin closes, the
//         server stops.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const config = JSON.parse(process.env.FORWARDER_E2E ?? "{}");
const root = fileURLToPath(new URL("../..", import.meta.url));

function worker(origin) {
  return {
    configPath: "./wrangler.jsonc",
    vars: { ACCOUNT_JWKS: config.jwks, ACCOUNT_ISSUER: config.issuer, HOOKS_ORIGIN: origin },
    secrets: { TAG_KEYS: config.tagKeys, ACCOUNT_ID_KEY: config.accountIdKey, TICKET_SECRET: config.ticketSecret },
  };
}

/** The Durable Object a tag names: the 11-byte account id after the tag's version byte (identity.ts). */
function objectOfTag(tag) {
  return Buffer.from(tag, "base64url").subarray(1, 12).toString("base64url");
}

/**
 * Waits until the Worker itself answers (its own JSON 404 for "/"), not just until the harness has a port: after the
 * update below the runtime reloads, and on a slow runner (Windows CI) the first connections otherwise fail and the
 * client backs off past the test's wait. Each try has its own timeout, so a request that hangs is tried again.
 */
async function workerAnswers(origin, limitMs = 90_000) {
  const started = Date.now();
  let last = "no answer";
  while (Date.now() - started < limitMs) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      if (response.status === 404 && body.includes("not_found")) {
        process.stderr.write(`forwarder harness: the Worker answered at ${origin} after ${Date.now() - started} ms\n`);
        return;
      }
      last = `${response.status} ${body.slice(0, 80)}`;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the forwarder Worker didn't answer at ${origin} within ${limitMs} ms (last: ${last})`);
}

const server = createTestHarness({ root, workers: [worker("http://127.0.0.1")] });
let { url } = await server.listen();
// The Worker builds webhook and socket URLs from HOOKS_ORIGIN, so give it the address it is reachable at.
await server.update({ root, workers: [worker(url.origin)] });
({ url } = await server.listen());
// wrangler's harness binds 127.0.0.1 (never localhost, which Windows tries as ::1 first); refuse anything else.
if (url.hostname !== "127.0.0.1") throw new Error(`the forwarder harness listens on ${url.hostname}, not 127.0.0.1`);
await workerAnswers(url.origin);
process.stdout.write(`${JSON.stringify({ url: url.origin })}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const command = JSON.parse(line);
    if (command.op === "evict") {
      await server.getWorker().evictDurableObject("ForwarderDO", { name: objectOfTag(command.tag), webSockets: command.webSockets ?? "hibernate" });
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ ok: false, error: "unknown op" })}\n`);
    }
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) })}\n`);
  }
}
await server.close();
