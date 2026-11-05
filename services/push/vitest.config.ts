// waifucave push's tests run inside workerd through @cloudflare/vitest-plugin. Every outbound request the
// Worker makes goes to the local fakes of APNs and Web Push (test/node/fakes.ts); nothing reaches a network.
// All keys are made fresh for the run, in memory.

import { generateKeyPairSync } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { createPushFakes } from "./test/node/fakes";

const es256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwks = JSON.stringify({ keys: [{ ...es256.publicKey.export({ format: "jwk" }), kid: "test-es256", alg: "ES256", use: "sig" }] });
const signingKeys = JSON.stringify({ es256: { ...es256.privateKey.export({ format: "jwk" }), kid: "test-es256" } });

const apns = { apnsKeyId: "TESTKEY001", apnsTeamId: "TESTTEAM01", apnsTopic: "com.waifucave.clover.ios.test" };
const fakes = createPushFakes(apns);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCOUNT_ISSUER: "https://accounts.test",
          ACCOUNT_JWKS: jwks,
          APNS_KEY_ID: apns.apnsKeyId,
          APNS_TEAM_ID: apns.apnsTeamId,
          APNS_TOPIC: apns.apnsTopic,
          VAPID_SUBJECT: "mailto:push@waifucave.test",
          MAX_TARGETS: "5",
          TEST_SIGNING_KEYS: signingKeys,
          ...fakes.bindings,
        },
        outboundService: (request: Request) => fakes.outbound(request),
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    testTimeout: 20_000,
  },
});
