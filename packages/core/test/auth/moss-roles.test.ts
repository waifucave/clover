import { describe, expect, test } from "bun:test";
import { MOSS_ERR, MOSS_PROTOCOL_VERSION, type MossHelloParams } from "@waifucave/moss-protocol";
import { MossTokens, isRefusal } from "../../src/auth/moss-tokens";
import { gateMossRequest, isFencedCaller, resolveMossCaller, SessionProcesses } from "../../src/auth/moss-caller";
import type { PeerFacts } from "../../src/platform/caller-probe";

const hello = (role: MossHelloParams["role"], token: string, extra: Partial<MossHelloParams> = {}): MossHelloParams =>
  ({ protocolVersion: MOSS_PROTOCOL_VERSION, role, token, clientName: "t", ...extra });
const user: PeerFacts = { pid: 10, ancestors: [1], probe: {}, floor: "outside-floor" };

describe("the app's peer image in the caller check", () => {
  test("an app hello passes only a check that says yes; \"none\" makes no check; the floor's refusal comes first", () => {
    const app = { binding: { role: "app" as const }, peer: user, processes: new SessionProcesses() };
    expect(resolveMossCaller({ ...app, appPeer: "none" })).toEqual({ kind: "user", client: "app" });
    expect(resolveMossCaller({ ...app, appPeer: () => true })).toEqual({ kind: "user", client: "app" });
    expect(resolveMossCaller({ ...app, appPeer: () => false })).toMatchObject({ code: MOSS_ERR.PROCESS_REFUSED });
    let asked = 0;
    const fenced: PeerFacts = { ...user, floor: "fenced" };
    expect(resolveMossCaller({ ...app, peer: fenced, appPeer: () => { asked++; return true; } })).toMatchObject({ code: MOSS_ERR.NOT_THE_USER });
    expect(asked).toBe(0);
    // Only the app role is checked.
    expect(resolveMossCaller({ binding: { role: "cli" }, peer: user, processes: new SessionProcesses(), appPeer: () => false })).toEqual({ kind: "user", client: "cli" });
  });
});

describe("MOSS roles and tokens", () => {
  test("each minted token is bound to its role and its object, and can be revoked", async () => {
    const t = new MossTokens({ verifyCli: async () => false });
    const layer = t.mint({ role: "layer", pluginId: "a" });
    expect(await t.verify(hello("layer", layer, { pluginId: "a" }))).toEqual({ role: "layer", pluginId: "a" });
    expect(isRefusal(await t.verify(hello("layer", layer, { pluginId: "b" })))).toBe(true);
    expect(isRefusal(await t.verify(hello("bridge", layer, { agentSessionId: "s" })))).toBe(true); // wrong role
    const bridge = t.mint({ role: "bridge", agentSessionId: "s-1" });
    expect(isRefusal(await t.verify(hello("bridge", bridge, { agentSessionId: "s-2" })))).toBe(true);
    t.revoke(layer);
    expect(isRefusal(await t.verify(hello("layer", layer, { pluginId: "a" })))).toBe(true);
    expect(t.revokeWhere((b) => b.role === "bridge")).toBe(1);
  });

  test("a plugin-host token names its process: another claim is PROCESS_REFUSED (S4)", async () => {
    const t = new MossTokens({ verifyCli: async () => false });
    const shared = t.mint({ role: "plugin-host", hostProcess: "shared" });
    expect(await t.verify(hello("plugin-host", shared, { hostProcess: "moss" }))).toMatchObject({ code: MOSS_ERR.PROCESS_REFUSED });
  });

  test("the app's token is this run's; the CLI's is the user's terminal token", async () => {
    const t = new MossTokens({ appToken: "A".repeat(43), verifyCli: async (tok) => tok === "cli-token" });
    expect(await t.verify(hello("app", "A".repeat(43)))).toEqual({ role: "app" });
    expect(isRefusal(await t.verify(hello("app", "B".repeat(43))))).toBe(true);
    expect(await t.verify(hello("cli", "cli-token"))).toEqual({ role: "cli" });
    expect(isRefusal(await new MossTokens({ verifyCli: async () => true }).verify(hello("app", "A".repeat(43))))).toBe(true); // no pair side, no app
  });
});

describe("the caller check", () => {
  test("a CLI under a process the daemon started for a session is that session, even outside the floor", () => {
    const p = new SessionProcesses();
    p.add(30, { sessionId: "s", sessionKind: "coding" });
    const peer: PeerFacts = { pid: 40, ancestors: [30, 1], probe: {}, floor: "outside-floor" };
    expect(resolveMossCaller({ appPeer: "none", binding: { role: "cli" }, peer, processes: p })).toEqual({ kind: "session", sessionId: "s", sessionKind: "coding" });
    expect(resolveMossCaller({ appPeer: "none", binding: { role: "cli" }, peer: user, processes: p })).toEqual({ kind: "user", client: "cli" });
    p.remove(30);
    expect(resolveMossCaller({ appPeer: "none", binding: { role: "cli" }, peer, processes: p })).toEqual({ kind: "user", client: "cli" });
  });

  test("a plugin-host connection from a process other than the one the daemon started is refused", () => {
    const r = resolveMossCaller({ appPeer: "none", binding: { role: "plugin-host", hostProcess: "moss" }, peer: user, processes: new SessionProcesses(), hostPid: 99 });
    expect(r).toMatchObject({ code: MOSS_ERR.PROCESS_REFUSED });
    expect(resolveMossCaller({ appPeer: "none", binding: { role: "plugin-host", hostProcess: "moss" }, peer: { ...user, pid: 99 }, processes: new SessionProcesses(), hostPid: 99 })).toEqual({ kind: "plugin", pluginId: "moss" });
  });

  test("everyone but the user and the core is fenced; a peer always", () => {
    expect(isFencedCaller({ kind: "peer", device: "e".repeat(32) })).toBe(true);
    expect(isFencedCaller({ kind: "session", sessionId: "s", sessionKind: "bot" })).toBe(true);
    expect(isFencedCaller({ kind: "plugin", pluginId: "x" })).toBe(true);
    expect(isFencedCaller({ kind: "user", client: "app" })).toBe(false);
    expect(isFencedCaller({ kind: "core" })).toBe(false);
  });

  test("the gate: a role's list, then userOnly, with a layer's change let through for its card", () => {
    expect(gateMossRequest("cli", { kind: "user", client: "cli" }, "pair.status")).toBeNull();
    expect(gateMossRequest("web", { kind: "user", client: "web" }, "pair.status")).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    expect(gateMossRequest("cli", { kind: "session", sessionId: "s", sessionKind: "bot" }, "pair.quit")).toMatchObject({ code: MOSS_ERR.NOT_THE_USER });
    expect(gateMossRequest("layer", { kind: "plugin", pluginId: "p" }, "ui.set")).toBeNull(); // becomes a sealed card
  });
});
