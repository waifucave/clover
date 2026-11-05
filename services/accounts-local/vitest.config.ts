// The local sign-in stand-in's tests run inside workerd through @cloudflare/vitest-plugin. Its keys are made in
// memory when the Durable Object first loads; nothing is written to disk and nothing leaves the runtime.

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ISSUER: "https://accounts.test" },
        cf: false,
        outboundService: (request: Request) => new Response(`outbound request refused in tests: ${new URL(request.url).host}`, { status: 599 }),
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
