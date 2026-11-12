// Who may call `app.capture` (the picture of what this computer's app draws): the user's own CLI on this computer,
// and no one else. The protocol's gate (role allow list, then `userOnly`) refuses every other role and every caller
// that isn't the user before the handler runs, and the handler checks once more. The whole path over the real
// endpoint is in clover-connections.test.ts ("app.capture: …").
import { describe, expect, test } from "bun:test";
import { CLOVER_ERR, CLOVER_METHODS, CLOVER_ROLES, type Caller, type CloverRole } from "@waifucave/clover-protocol";
import { gateCloverRequest } from "../../src/auth/clover-caller";
import { appCaptureHandler, mayCapture } from "../../src/ipc/app-capture";
import type { CloverConn } from "../../src/ipc/clover";

const user: Caller = { kind: "user", client: "cli" };
const bot: Caller = { kind: "session", sessionId: "s-1", sessionKind: "bot", bot: "alpha" };
const plugin: Caller = { kind: "plugin", pluginId: "vn-composer" };
const remoteUser: Caller = { kind: "user", client: "ios", device: "d".repeat(32) };
const peerUser: Caller = { kind: "peer", device: "d".repeat(32), asKind: "user" } as Caller;

describe("app.capture's caller gate", () => {
  test("the method is the CLI's alone and the user's", () => {
    const spec = CLOVER_METHODS.get("app.capture")!;
    expect({ roles: spec.roles, userOnly: spec.userOnly, direction: spec.direction }).toEqual({ roles: ["cli"], userOnly: true, direction: "to-daemon" });
    expect(CLOVER_METHODS.get("app.window.capture")).toMatchObject({ roles: ["app"], direction: "from-daemon" });
  });

  test("a local user's CLI passes; a bot's session, a plugin, a layer, a remote device and another computer are refused", () => {
    expect(gateCloverRequest("cli", user, "app.capture")).toBeNull();
    expect(gateCloverRequest("cli", bot, "app.capture")?.code).toBe(CLOVER_ERR.NOT_THE_USER);
    for (const role of CLOVER_ROLES.filter((r) => r !== "cli") as CloverRole[]) {
      const caller = role === "layer" || role === "plugin-host" ? plugin : role === "remote" || role === "web" ? remoteUser : role === "peer" ? peerUser : role === "bridge" ? bot : user;
      expect({ role, code: gateCloverRequest(role, caller, "app.capture")?.code }).toEqual({ role, code: CLOVER_ERR.ROLE_REFUSED });
    }
  });

  test("the handler itself takes only a user's cli connection", async () => {
    expect(mayCapture({ role: "cli", caller: user })).toBe(true);
    for (const c of [{ role: "cli", caller: bot }, { role: "app", caller: { kind: "user", client: "app" } }, { role: "layer", caller: plugin }, { role: "remote", caller: remoteUser }] as const) {
      expect(mayCapture(c as never)).toBe(false);
    }
    const asked: unknown[] = [];
    const app = { role: "app", caller: { kind: "user", client: "app" }, features: ["app.capture"] } as unknown as CloverConn;
    const handle = appCaptureHandler({ connections: () => [app], ask: async (_c, method, params) => { asked.push({ method, params }); return { windows: [] }; } });
    await expect(handle({ role: "cli", caller: bot } as unknown as CloverConn, { window: "main" }) as Promise<unknown>).rejects.toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    expect(asked).toEqual([]);
    expect(await handle({ role: "cli", caller: user } as unknown as CloverConn, { window: "main" })).toEqual({ windows: [] });
    expect(asked).toEqual([{ method: "app.window.capture", params: { window: "main" } }]);
  });
});
