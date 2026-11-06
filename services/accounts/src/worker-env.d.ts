// Types `env` and `exports` from "cloudflare:workers" (and the test helpers) for this Worker.
import type { Env as AccountsEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends AccountsEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "AccountDO" | "KeysDO";
    }
  }
}

export {};
