// Who may call `app.capture` (the picture of what this computer's app draws): the user's own CLI on this computer,
// and no one else. The protocol's gate (role allow list, then `userOnly`) refuses every other role and every caller
// that isn't the user before the handler runs, and the handler checks once more. The whole path over the real
// endpoint is in clover-connections.test.ts ("app.capture: …").
import { describe, expect, test } from "bun:test";
import { CLOVER_ERR, CLOVER_METHODS, CLOVER_ROLES, ERR, type Caller, type CloverRole } from "@waifucave/clover-protocol";
import { gateCloverRequest } from "../../src/auth/clover-caller";
import { appCaptureHandler, appOpenHandlers, mayCapture } from "../../src/ipc/app-capture";
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

describe("app.open and app.where: the same door", () => {
  test("the CLI's alone and the user's; every other role and a bot's session refused", () => {
    for (const m of ["app.open", "app.where"]) {
      const spec = CLOVER_METHODS.get(m)!;
      expect({ m, roles: spec.roles, userOnly: spec.userOnly, direction: spec.direction }).toEqual({ m, roles: ["cli"], userOnly: true, direction: "to-daemon" });
      expect(gateCloverRequest("cli", user, m)).toBeNull();
      expect(gateCloverRequest("cli", bot, m)?.code).toBe(CLOVER_ERR.NOT_THE_USER);
      for (const role of CLOVER_ROLES.filter((r) => r !== "cli") as CloverRole[]) {
        const caller = role === "layer" || role === "plugin-host" ? plugin : role === "remote" || role === "web" ? remoteUser : role === "peer" ? peerUser : role === "bridge" ? bot : user;
        expect({ m, role, code: gateCloverRequest(role, caller, m)?.code }).toEqual({ m, role, code: CLOVER_ERR.ROLE_REFUSED });
      }
    }
    expect(CLOVER_METHODS.get("app.window.open")).toMatchObject({ roles: ["app"], direction: "from-daemon" });
  });

  test("the handlers ask the app that serves app.open, and take only a user's cli connection", async () => {
    const asked: unknown[] = [];
    const app = { role: "app", caller: { kind: "user", client: "app" }, features: ["app.capture", "app.open"] } as unknown as CloverConn;
    const old = { role: "app", caller: { kind: "user", client: "app" }, features: ["app.capture"] } as unknown as CloverConn;
    const answer = { target: "settings", shown: true, drawn: true, where: { tab: { kind: "settings" }, side: "bots" }, frames: [] };
    const h = appOpenHandlers({ connections: () => [app], ask: async (_c, method, params) => { asked.push({ method, params }); return answer; } });
    expect(await h["app.open"]({ role: "cli", caller: user } as unknown as CloverConn, { target: "settings", frames: true })).toEqual(answer);
    expect(await h["app.where"]({ role: "cli", caller: user } as unknown as CloverConn, { frames: false })).toEqual(answer);
    expect(asked).toEqual([{ method: "app.window.open", params: { target: "settings", frames: true } }, { method: "app.window.open", params: { frames: false } }]);
    await expect(h["app.open"]({ role: "cli", caller: bot } as unknown as CloverConn, { target: "settings" }) as Promise<unknown>).rejects.toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    await expect(h["app.open"]({ role: "cli", caller: user } as unknown as CloverConn, { target: "a b" }) as Promise<unknown>).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    const older = appOpenHandlers({ connections: () => [old], ask: async () => answer });
    await expect(older["app.open"]({ role: "cli", caller: user } as unknown as CloverConn, { target: "settings" }) as Promise<unknown>).rejects.toThrow("older than app.open");
    expect(asked).toHaveLength(2);
  });
});
