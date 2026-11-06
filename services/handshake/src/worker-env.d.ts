// Types `env` and `exports` from "cloudflare:workers" (and the test helpers) for this Worker.
import type { Env as HandshakeEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends HandshakeEnv {
      /** Test-only: the private halves of the test account service's signing keys (vitest.config.ts). */
      TEST_SIGNING_KEYS?: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "HandshakeDO" | "RendezvousDO";
    }
  }
}

export {};
