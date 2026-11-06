// Runs the account service's Worker on wrangler's local runtime (workerd), for end-to-end tests that talk to it over
// real sockets: this service's own (e2e.test.ts) and the core's sign-in tests (lane H), against a sign-in stack such
// as lane M's stub.
//
// Input:  ACCOUNTS_E2E (environment, JSON): { authUrl, anonKey, signingJwks, tokenTtl?, devMint? }, made by the test
//         in memory for this run. Nothing is written to disk but wrangler's own local state folder.
// Output: one JSON line {"url": "..."} once listening. When stdin closes, the server stops.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const config = JSON.parse(process.env.ACCOUNTS_E2E ?? "{}");
const root = fileURLToPath(new URL("../..", import.meta.url));

function worker(origin) {
  return {
    configPath: "./wrangler.jsonc",
    vars: {
      ISSUER: origin,
      AUTH_URL: config.authUrl ?? "",
      AUTH_ANON_KEY: config.anonKey ?? "",
      TOKEN_TTL: String(config.tokenTtl ?? 300),
      DEV_MINT: config.devMint ? "1" : "",
      EPHEMERAL_KEYS: "",
    },
    secrets: { SIGNING_JWKS: config.signingJwks },
  };
}

const server = createTestHarness({ root, workers: [worker("http://127.0.0.1")] });
let { url } = await server.listen();
// The issuer is the address it is reachable at.
await server.update({ root, workers: [worker(url.origin)] });
({ url } = await server.listen());
process.stdout.write(`${JSON.stringify({ url: url.origin })}\n`);

for await (const _ of createInterface({ input: process.stdin })) {
  // Commands may come later; for now stdin only says when to stop.
}
await server.close();
