// A driver-initiated turn (lane A's ask): a background task of the session's runtime finished, and the driver hands
// its notification to the host (`ctx.wake`) instead of starting a turn itself. The host logs it, starts or folds the
// turn through the pause and the update gate, and records the turn's end and usage like any other.
import { afterEach, describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { flush } from "../../contracts/fakes/clock";
import { projectRecords } from "../../sessions/wire";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };

describe("a turn the driver asks for", () => {
  test("idle: the host logs the notification and starts a task-notification turn, whose end and usage are recorded", async () => {
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx;
    expect(await ctx.wake!({ task: "bash_7", status: "completed", text: "The build passed." })).toMatchObject({ disposition: "turn" });
    await flush();
    const d = b.drivers.for("b_alpha");
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({ origin: "task-notification", input: { from: "task", task: "bash_7", status: "completed" } });
    d.end({ text: "Your build passed.", usage: { inputTokens: 1200, outputTokens: 40, contextTokens: 1240 } });
    await flush();
    const records = b.host.history("b_alpha");
    expect(records.map((r) => r.type)).toEqual(expect.arrayContaining(["input", "turn_started", "turn_ended"]));
    expect(records.find((r) => r.type === "turn_started")).toMatchObject({ origin: "task-notification" });
    expect(records.find((r) => r.type === "turn_ended")).toMatchObject({ end: { reason: "end_turn", usage: { inputTokens: 1200, outputTokens: 40 } } });
    const wire = projectRecords(records, { kind: "bot" });
    expect(wire.find((e) => e.type === "note")).toMatchObject({ label: "Background task completed", text: "The build passed." });
    expect(wire.find((e) => e.type === "turn_completed")).toBeDefined();
    await b.shutdown();
  });

  test("during a turn it folds in; while paused it waits, and starts when the user resumes", async () => {
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx;
    await b.host.sendUser("b_alpha", { text: "go", device: "studio", sentAt: 1, clientMessageId: "g" });
    await flush();
    expect(await ctx.wake!({ task: "bash_8", status: "failed", text: "exit 1" })).toMatchObject({ disposition: "folded" });
    const d = b.drivers.for("b_alpha");
    expect(d.turns[0]!.folded.map((i) => i.from)).toEqual(["task"]);
    d.end({ text: "done" });
    await flush();
    // A running monitor's event wakes it too; the task goes on running.
    expect(await ctx.wake!({ task: "monitor_1", status: "event", text: "CPU above 90%" })).toMatchObject({ disposition: "turn" });
    await flush();
    expect(d.turns[1]).toMatchObject({ origin: "task-notification", input: { from: "task", task: "monitor_1", status: "event" } });
    expect(projectRecords(b.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "note").at(-1)).toMatchObject({ label: "Background task event", text: "CPU above 90%" });
    d.end({ text: "noted" });
    await flush();
    await b.bots.setPaused(true, theUser);
    expect(await ctx.wake!({ task: "bash_9", status: "stopped", text: "stopped by the user" })).toMatchObject({ disposition: "queued" });
    await flush();
    expect(d.turns).toHaveLength(2);
    await b.bots.setPaused(false, theUser);
    await flush();
    expect(d.turns).toHaveLength(3);
    expect(d.turns[2]).toMatchObject({ origin: "task-notification", input: { from: "task", task: "bash_9" } });
    await b.shutdown();
  });
});
