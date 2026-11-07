// Runs the handshake Worker on wrangler's local runtime (workerd), with the account service's local profile beside it
// (services/accounts: keys in memory, and its mint without a sign-in), for end-to-end tests that talk to it over real
// sockets: the web companion plugin's (clover/companion-web) and a browser's.
//
// Input:  HANDSHAKE_E2E (environment, JSON): { ticketSecret, webOrigins? }, made by the test in memory for this run.
//         Nothing is written to disk but wrangler's own local state folder.
// Output: one JSON line {"url": "...", "accounts": "..."} once listening. When stdin closes, the servers stop.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { workerReady } from "../../../shared/testing/worker-ready.mjs";

const config = JSON.parse(process.env.HANDSHAKE_E2E ?? "{}");
const root = fileURLToPath(new URL("../..", import.meta.url));
const accountsRoot = fileURLToPath(new URL("../../../accounts", import.meta.url));

const accounts = createTestHarness({ root: accountsRoot, workers: [{ configPath: "./wrangler.jsonc" }] });
const { url: accountsUrl } = await accounts.listen();
await accounts.update({ root: accountsRoot, workers: [{ configPath: "./wrangler.jsonc", vars: { ISSUER: accountsUrl.origin } }] });
await workerReady(await accounts.listen().then((l) => l.url), { label: "accounts (beside the handshake)" });

function worker(origin) {
  return {
    configPath: "./wrangler.jsonc",
    vars: {
      HANDSHAKE_ORIGIN: origin,
      WEB_ORIGINS: config.webOrigins ?? "",
      ACCOUNT_ISSUER: accountsUrl.origin,
      ACCOUNT_JWKS_URL: `${accountsUrl.origin}/.well-known/jwks.json`,
    },
    secrets: { TICKET_SECRET: config.ticketSecret },
  };
}

const server = createTestHarness({ root, workers: [worker("http://127.0.0.1")] });
let { url } = await server.listen();
// Socket URLs are built from HANDSHAKE_ORIGIN, so give it the address it is reachable at.
await server.update({ root, workers: [worker(url.origin)] });
({ url } = await server.listen());
const origin = await workerReady(url, { label: "handshake" });
process.stdout.write(`${JSON.stringify({ url: origin, accounts: accountsUrl.origin })}\n`);

for await (const _ of createInterface({ input: process.stdin })) {
  // Commands may come later; for now stdin only says when to stop.
}
await server.close();
await accounts.close();
