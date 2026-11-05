// The forwarder's tests run inside workerd (wrangler's local runtime) through @cloudflare/vitest-plugin.
// Every key here is made fresh for the run, in memory: the test account service's signing keys and the
// Worker's two secrets. Nothing is written to disk, and the Worker's outbound requests are refused.

import { generateKeyPairSync, randomBytes } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const es256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed25519 = generateKeyPairSync("ed25519");

const jwks = JSON.stringify({
  keys: [
    { ...es256.publicKey.export({ format: "jwk" }), kid: "test-es256", alg: "ES256", use: "sig" },
    { ...ed25519.publicKey.export({ format: "jwk" }), kid: "test-ed25519", alg: "EdDSA", use: "sig" },
  ],
});

const signingKeys = JSON.stringify({
  es256: { ...es256.privateKey.export({ format: "jwk" }), kid: "test-es256" },
  ed25519: { ...ed25519.privateKey.export({ format: "jwk" }), kid: "test-ed25519" },
});

const secret = () => randomBytes(32).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCOUNT_ISSUER: "https://accounts.test",
          ACCOUNT_JWKS: jwks,
          HOOKS_ORIGIN: "https://hooks.test",
          TAG_SECRET: secret(),
          TICKET_SECRET: secret(),
          // Small caps, so the tests can reach them.
          MAX_HELD: "8",
          MAX_HELD_BYTES: "65536",
          MAX_BODY_BYTES: "16384",
          MAX_HEADER_BYTES: "2048",
          MAX_DEVICES: "4",
          MAX_ROUTINES: "6",
          WINDOW_FRAMES: "3",
          TEST_SIGNING_KEYS: signingKeys,
        },
        // The forwarder makes no outbound requests; any attempt fails loudly instead of reaching a network.
        outboundService: (request: Request) =>
          new Response(`outbound request refused in tests: ${new URL(request.url).host}`, { status: 599 }),
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    testTimeout: 20_000,
  },
});
