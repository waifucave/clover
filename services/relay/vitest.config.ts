// The relay's tests run inside workerd through @cloudflare/vitest-plugin. Its key is made fresh for the run, in
// memory; nothing is written to disk and the Worker's outbound requests are refused.

import { randomBytes } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { RELAY_ORIGIN: "https://relay.test", RELAY_KEY: randomBytes(32).toString("base64url") },
        cf: false,
        outboundService: (request: Request) => new Response(`outbound request refused in tests: ${new URL(request.url).host}`, { status: 599 }),
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/node/**"], testTimeout: 20_000 },
});
