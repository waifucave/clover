// The handshake's tests run inside workerd (wrangler's local runtime) through @cloudflare/vitest-plugin. Every key
// here is made fresh for the run, in memory: the test account service's signing keys and the ticket secret. Nothing
// is written to disk. The one outbound request the Worker may make, the account service's JWKS, is answered here.

import { generateKeyPairSync, randomBytes } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const es256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed25519 = generateKeyPairSync("ed25519");
const rotated = generateKeyPairSync("ed25519");

const publicJwk = (key: ReturnType<typeof generateKeyPairSync>["publicKey"], kid: string, alg: string) => ({ ...key.export({ format: "jwk" }), kid, alg, use: "sig" });

const jwks = JSON.stringify({ keys: [publicJwk(es256.publicKey, "test-es256", "ES256"), publicJwk(ed25519.publicKey, "test-ed25519", "EdDSA")] });
// What the JWKS URL serves: the same keys plus one added later, as a rotation would.
const servedJwks = JSON.stringify({
  keys: [publicJwk(es256.publicKey, "test-es256", "ES256"), publicJwk(ed25519.publicKey, "test-ed25519", "EdDSA"), publicJwk(rotated.publicKey, "test-rotated", "EdDSA")],
});

const signingKeys = JSON.stringify({
  es256: { ...es256.privateKey.export({ format: "jwk" }), kid: "test-es256" },
  ed25519: { ...ed25519.privateKey.export({ format: "jwk" }), kid: "test-ed25519" },
  rotated: { ...rotated.privateKey.export({ format: "jwk" }), kid: "test-rotated" },
});

let jwksFetches = 0;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCOUNT_ISSUER: "https://accounts.test",
          ACCOUNT_JWKS: jwks,
          HANDSHAKE_ORIGIN: "https://handshake.test",
          WEB_ORIGINS: "https://clover.test, http://127.0.0.1:8790",
          TICKET_SECRET: randomBytes(32).toString("base64url"),
          TEST_SIGNING_KEYS: signingKeys,
        },
        cf: false,
        // Only the JWKS URL answers; anything else fails loudly instead of reaching a network.
        outboundService: (request: Request) => {
          const url = new URL(request.url);
          if (url.host === "accounts.test" && url.pathname === "/.well-known/jwks.json") {
            jwksFetches++;
            return new Response(servedJwks, { headers: { "content-type": "application/json", "x-fetches": String(jwksFetches) } });
          }
          return new Response(`outbound request refused in tests: ${url.host}`, { status: 599 });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    testTimeout: 20_000,
  },
});
