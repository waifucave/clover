// Types `env` and `exports` from "cloudflare:workers" for this Worker.
import type { Env as AccountsEnv } from "./index";

declare global {
  namespace Cloudflare {
    interface Env extends AccountsEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "KeysDO";
    }
  }
}

export {};
