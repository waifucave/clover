// Types `env` and `exports` from "cloudflare:workers" for this Worker.
import type { Env as RelayEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "RoomDO" | "MailboxDO";
    }
  }
}

export {};
