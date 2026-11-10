// The read-only switch is counted on only when the agent confirms it: its config option's answer, or for ACP's session
// modes its own `current_mode_update` (never Clover's own record of what it asked for). Unconfirmed, a session isn't
// started, and a running one is ended before the turn is sent, as the sandbox writer's mode floor does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { World, waitFor, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, marks: ["unasked-actions"] };
// Read-only by ACP's session modes: the backend's read-only option isn't a config option this agent offers.
const make = (o: WorldOptions) => (world = new World({ quirks, acpModes: ["default", "plan"], readOnlyMode: { option: "mode", values: ["plan"] }, modeConfirmMs: 300, ...o }));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const notifications = (w: World) => w.parentInputs("task-notification").map((r) => r.input as { text: string; stopReason?: string });

describe("the read-only switch by session/set_mode", () => {
  test("confirmed by the agent's current_mode_update: the session starts at read-only and its turn runs", async () => {
    const w = make({ level: "read-only", script: [[{ say: "read it" }]] });
    await w.delegate();
    expect((await waitFor(() => notifications(w)[0], "the notification")).text).toContain("read it");
    expect(w.report("set-mode")).toEqual([expect.objectContaining({ mode: "plan", turn: false })]);
  });

  test("never confirmed: the session isn't started at read-only, and no turn is sent", async () => {
    const w = make({ level: "read-only", silentSetMode: true, script: [[{ say: "never" }]] });
    await w.delegate();
    const n = await waitFor(() => notifications(w)[0], "the notification");
    expect(n.stopReason).toBe("error");
    expect(n.text).toContain("didn't confirm its read-only mode");
    expect(w.report("set-mode")).toEqual([expect.objectContaining({ mode: "plan" })]);
    expect(w.report("prompt")).toEqual([]);
  });

  test("the level drops to read-only mid-session and the switch isn't confirmed: the session is ended before the turn", async () => {
    const w = make({ level: "ask", silentSetMode: true, script: [[{ say: "one" }], [{ say: "never" }], [{ say: "never" }]] });
    const r = await w.delegate();
    await waitFor(() => notifications(w)[0], "the first notification");
    w.level = "read-only";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    const second = await waitFor(() => notifications(w)[1], "the second notification");
    expect(second.text).toContain("didn't confirm its read-only mode");
    expect(w.report("prompt")).toHaveLength(1);
    // Ended, not just refused once: the agent's process is gone.
    const pid = (w.report("started")[0] as unknown as { pid: number }).pid;
    await waitFor(() => !alive(pid), "the agent's process to end");
    expect(w.report("prompt")).toHaveLength(1);
  });

  test("confirmed mid-session, and back when the level rises: each switch waits for the agent's word", async () => {
    const w = make({ level: "ask", script: [[{ say: "one" }], [{ say: "two" }], [{ say: "three" }]] });
    const r = await w.delegate();
    await waitFor(() => notifications(w)[0], "the first notification");
    w.level = "read-only";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    await waitFor(() => notifications(w)[1], "the second notification");
    w.level = "ask";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Three." });
    await waitFor(() => notifications(w)[2], "the third notification");
    expect(w.report("set-mode").map((m) => m["mode"])).toEqual(["plan", "default"]);
    expect(w.report("prompt")).toHaveLength(3);
  });
});
