// Types `env` and `exports` from "cloudflare:workers" (and the test helpers) for this Worker.
import type { Env as PushEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends PushEnv {
      /** Test-only: the private half of the test account service's signing key (vitest.config.ts). */
      TEST_SIGNING_KEYS?: string;
      /** Test-only: the fake push services' subscriptions, as browsers would hand them over (test/node/fakes.ts). */
      TEST_SUBSCRIPTIONS?: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "PushDO";
    }
  }
}

export {};
