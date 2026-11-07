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

import { workerReady } from "../../../shared/testing/worker-ready.mjs";

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

const server = createTestHarness({ root, workers: [worker("http://127.0.0.1")] });
let { url } = await server.listen();
// The Worker builds webhook and socket URLs from HOOKS_ORIGIN, so give it the address it is reachable at.
await server.update({ root, workers: [worker(url.origin)] });
({ url } = await server.listen());
const origin = await workerReady(url, { label: "forwarder", limitMs: 90_000 });
process.stdout.write(`${JSON.stringify({ url: origin })}\n`);

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
