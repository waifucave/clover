// Lane M's update gate on the bot side (../update-gate.ts, #198's `UpdateGate` surface): running turns keep an update
// waiting; while the gate is closed no turn starts, the user's message is refused typed, and what was held (a bot's
// message, a routine's run) starts once it reopens.
import { afterEach, describe, expect, test } from "bun:test";
import { ERR, SESSIONS_METHODS as M, type Caller } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MethodError } from "../rpc";
import { REOPEN_POLL_MS, UPDATE_RESTARTING, type UpdateGateLike } from "../update-gate";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(() => removeTemps());

class FakeUpdateGate implements UpdateGateLike {
  closed = false;
  readonly sources = new Map<string, { name: string; count(): number }>();
  register(source: { name: string; count(): number }): () => void {
    this.sources.set(source.name, source);
    return () => this.sources.delete(source.name);
  }
  busy(): number {
    return [...this.sources.values()].reduce((n, s) => n + s.count(), 0);
  }
}

const theUser: Caller = { kind: "user", client: "app" };

describe("the update gate", () => {
  test("turns are busy; while closed none starts, the user's message is refused typed, and the held ones start on reopen", async () => {
    const updates = new FakeUpdateGate();
    const clock = new FakeClock({ start: Date.parse("2026-11-07T07:59:00Z") });
    const b = await boot({
      home: tempDir(), clock, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, updateGate: updates,
      routines: { watchFiles: false, userTimeZone: () => "UTC" },
    });
    expect([...updates.sources.keys()]).toEqual(["bot-turns"]);
    const methods = b.side.methods({ localDevice: "studio" });
    const send = (text: string) => methods[M.sessionSend.name]!({ id: "b_alpha", message: { text, clientMessageId: text } }, { caller: theUser });

    // Open: a turn starts and keeps the update waiting until it ends.
    await send("hello");
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(1);
    expect(updates.busy()).toBe(1);
    b.drivers.for("b_alpha").end({ text: "hi" });
    await flush();
    expect(updates.busy()).toBe(0);

    // Closed: the user's message is refused, typed; nothing is recorded.
    updates.closed = true;
    const refused = await send("again").catch((e: unknown) => e);
    expect(refused instanceof MethodError && refused.code).toBe(ERR.INVALID_REQUEST);
    expect((refused as MethodError).data).toMatchObject(UPDATE_RESTARTING);

    // A bot's message and a routine's run arrive meanwhile: recorded and held, no turn starts.
    await b.host.deliver("b_alpha", { from: "bot", bot: "luna", session: "b_luna", text: "ping" });
    await b.side.tools("b_alpha").find((t) => t.name === "Routine")!.run({ name: "Brief", instructions: "Brief me.", schedule: "0 8 * * *" });
    clock.advance(60_000);
    await flush();
    const side = b.host.list({ kind: "side-thread" })[0]!;
    expect(b.drivers.for("b_alpha").turns).toHaveLength(1);
    expect(b.drivers.for(side.id).turns).toHaveLength(0);
    expect(updates.busy()).toBe(0);

    // Reopened: both start.
    updates.closed = false;
    await new Promise((r) => setTimeout(r, REOPEN_POLL_MS + 200));
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(2);
    expect(b.drivers.for(side.id).turns).toHaveLength(1);
    await b.shutdown();
    expect(updates.sources.size).toBe(0);
  });
});
