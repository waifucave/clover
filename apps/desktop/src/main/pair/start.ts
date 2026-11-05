// How this app instance was started, and how it proves itself to the daemon. Pure apart from reading files in the
// daemon's home. Both are proposals to lane C (C-M1), which writes the files:
//
//   * `<home>/run/app-start.json` — `{ "by": "daemon" | "login", "safeMode": boolean, "at": <ms> }`, written by the
//     daemon just before it starts the app through the OS. It works with every OS's way of starting the app
//     (`open -g -a`, `systemctl --user start`, `schtasks /Run`), none of which passes arguments reliably. The app
//     reads it once, deletes it, and honours it for 60 s. A start with no file (or an old one) is the user's.
//     `--safe-mode` and `--clover-started-by=<who>` on the command line say the same, for the CLI and the tray.
//     After the hello, `pair.status`'s `safeMode` is the daemon's word on it too (§5.8: three crashes in two minutes).
//   * `<home>/run/app.token` — the `app` role's token, which the daemon mints when it starts and writes for the user
//     alone (0600; on Windows, an ACL for the user only), inside the fence so no bot can read it (spec §9.1, as S8's
//     `run/token`). `CLOVER_APP_TOKEN` overrides it for the dev scripts and the tests. The caller check (§3.1) is the
//     real guard; the token keeps another user's process out.
import type { CloverHelloParams } from "@waifucave/clover-protocol";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type StartedBy = "user" | "daemon" | "login";

export interface StartInfo {
  by: StartedBy;
  safeMode: boolean;
}

export const START_FILE_TTL_MS = 60_000;

export function startFilePath(home: string): string {
  return join(home, "run", "app-start.json");
}

export function appTokenPath(home: string): string {
  return join(home, "run", "app.token");
}

/** Reads the start: the command line first, then the daemon's start file (consumed). */
export function readStartInfo(home: string, argv: readonly string[], now: number = Date.now()): StartInfo {
  let by: StartedBy = "user";
  let safeMode = argv.includes("--safe-mode");
  const flag = argv.find((a) => a.startsWith("--clover-started-by="))?.slice("--clover-started-by=".length);
  if (flag === "daemon" || flag === "login") by = flag;
  const file = startFilePath(home);
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as { by?: unknown; safeMode?: unknown; at?: unknown };
      if (typeof s.at === "number" && now - s.at >= 0 && now - s.at < START_FILE_TTL_MS) {
        if (flag === undefined && (s.by === "daemon" || s.by === "login")) by = s.by;
        if (s.safeMode === true) safeMode = true;
      }
    } catch {
      // A torn or foreign file: a user's start.
    }
    rmSync(file, { force: true });
  }
  return { by, safeMode };
}

/** The dev overrides (`CLOVER_DAEMON_BIN`, `CLOVER_APP_TOKEN`) count only in a dev or unpackaged run: a packaged dist
 *  app finds its daemon in its own resources and its token in the daemon's run folder, whatever its environment. */
export function devOverridesAllowed(input: { packaged: boolean; profile: string }): boolean {
  return !input.packaged || input.profile === "dev";
}

/** The environment the pair reads, without the dev overrides where they don't count. */
export function pairEnv(env: NodeJS.ProcessEnv, allowed: boolean): NodeJS.ProcessEnv {
  if (allowed) return env;
  const out = { ...env };
  delete out.CLOVER_DAEMON_BIN;
  delete out.CLOVER_APP_TOKEN;
  return out;
}

/** The `app` token: `CLOVER_APP_TOKEN`, else the daemon's token file; undefined when there is none yet. */
export function readAppToken(home: string, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.CLOVER_APP_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const t = readFileSync(appTokenPath(home), "utf8").trim();
    return t === "" ? undefined : t;
  } catch {
    return undefined;
  }
}

/** The app's hello (`protocol.hello`, lane B's roles file). `features` names what the app handles: the daemon's
 *  `app.show` and `app.quit`, and plugin layers. */
export function appHello(token: string, version: string, protocolVersion: number): CloverHelloParams {
  return {
    protocolVersion,
    role: "app",
    token,
    clientName: `Clover ${version}`.slice(0, 128),
    features: ["app.show", "app.quit", "layers"],
  };
}
