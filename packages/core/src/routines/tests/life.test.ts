// D-M3 on the bot side: the `Routine` tool writes a file the engine runs in a side thread whose result posts into the
// bot's conversation; the routine methods; webhooks through the ingress; sessions' ends reach lane J.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_ERR, SESSIONS_METHODS as M, type Caller } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { MethodError } from "../../bots/rpc";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { routineFilePath } from "../engine";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };

async function side(opts: { clock?: FakeClock; levelOf?: (c: string) => "ask-risky" | "ask" | "automatic" | undefined } = {}) {
  const clock = opts.clock ?? new FakeClock({ start: Date.parse("2026-11-06T07:59:00Z") });
  const secrets = new MemorySecretStore();
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock,
    routines: { secrets, userTimeZone: () => "Europe/London", watchFiles: false, computers: () => [{ name: "Studio", level: "ask-risky" }, { name: "Box", level: "ask" }] },
    ...(opts.levelOf === undefined ? {} : { levelOf: opts.levelOf }),
  });
  const routine = () => b.side.tools("b_alpha").find((t) => t.name === "Routine")!;
  return { b, clock, secrets, routine };
}

describe("the Routine tool and the engine on the bot side", () => {
  test("a routine the bot writes runs on its schedule in a side thread, and its result posts into the conversation", async () => {
    const { b, clock, routine } = await side();
    const r = await routine().run({ name: "Morning brief", instructions: "Summarize the overnight issues.", schedule: "0 8 * * *" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Created the routine r_[a-z0-9]+ in home\/Studio\/\.clover\/routines\/alpha\/morning-brief\.md, run by Studio\./);
    const file = routineFilePath(b.home, "alpha", "morning-brief");
    expect(readFileSync(file, "utf8")).toContain("schedule: \"0 8 * * *\"");
    const [view] = b.side.routines!.list("alpha");
    expect(view).toMatchObject({ name: "Morning brief", state: "active", nextRunAt: Date.parse("2026-11-06T08:00:00Z") });
    clock.advance(60_000);
    await flush();
    const thread = b.host.list({ kind: "side-thread" })[0]!;
    expect(thread).toMatchObject({ bot: "alpha", routine: view!.id, title: "Morning brief" });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === thread.id)!.ctx;
    expect(ctx.level).toBe("ask-risky");
    expect(ctx.mayWriteMemory()).toBe(true);
    b.drivers.for(thread.id).end({ text: "Two new issues, nothing urgent." });
    await flush();
    const posted = b.host.history("b_alpha").filter((r) => r.type === "input" && r.input.from === "routine");
    expect(posted.map((r) => (r.type === "input" && r.input.from === "routine" ? r.input.text : ""))).toEqual(["Two new issues, nothing urgent."]);
    expect(b.side.routines!.runs(view!.id).runs[0]).toMatchObject({ outcome: "done", summary: "Two new issues, nothing urgent." });
    await b.shutdown();
  });

  test("a webhook routine hands back its URL, never its key; a raised level says it waits for the user's OK", async () => {
    const { b, secrets, routine } = await side();
    const r = await routine().run({ name: "Deploys", instructions: "Check the deploy.", webhook: true, level: "automatic" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Its webhook URL is https://hooks.waifucave.com/r_");
    expect(r.text).toContain("waits for the user's OK");
    const [meta] = await secrets.list({ kind: "core" });
    const key = (await secrets.get(meta!.ref))!.value.reveal();
    expect(r.text).not.toContain(key);
    expect(b.side.routines!.list()[0]!.state).toBe("waiting-for-ok");
    await b.shutdown();
  });

  test("refused: no trigger, a bad schedule or zone, an unknown computer, a name taken; another computer needs the tree", async () => {
    const { b, routine } = await side();
    expect((await routine().run({ name: "x", instructions: "y" })).text).toContain("needs a trigger");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every week" })).text).toContain("doesn't read");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every 1h", timezone: "Mars/Olympus" })).text).toContain("isn't a time zone");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every 1h", computer: "Nowhere" })).text).toContain("no computer Nowhere");
    expect((await routine().run({ name: "Dup", instructions: "y", schedule: "every 1h" })).isError).toBe(false);
    expect((await routine().run({ name: "Dup", instructions: "z", schedule: "every 1h" })).text).toContain("exists already");
    expect((await routine().run({ name: "Remote", instructions: "y", schedule: "every 1h", computer: "Box" })).text).toContain("can't reach Box's files");
    // Agents don't get the tool; bots' sessions do.
    b.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    expect(b.side.tools("s_agent").map((t) => t.name)).not.toContain("Routine");
    await b.shutdown();
  });

  test("the routine methods: the list, its runs, and runNow for the user only", async () => {
    const { b, routine } = await side();
    await routine().run({ name: "Tidy", instructions: "Tidy the downloads.", schedule: "every 1d" });
    const methods = b.side.methods({ localDevice: "studio" });
    const { routines } = (await methods[M.routineList.name]!({ bot: "alpha" }, { caller: theUser })) as { routines: { id: string }[] };
    expect(routines).toHaveLength(1);
    const plugin = await methods[M.routineRunNow.name]!({ id: routines[0]!.id }, { caller: { kind: "plugin", pluginId: "clover/sidebar" } }).catch((e: unknown) => e);
    expect(plugin instanceof MethodError && plugin.code).toBe(CLOVER_ERR.NOT_THE_USER);
    const { session } = (await methods[M.routineRunNow.name]!({ id: routines[0]!.id }, { caller: theUser })) as { session: string };
    expect(b.host.get(session)!.kind).toBe("side-thread");
    b.drivers.for(session).end({ text: "Tidied." });
    await flush();
    const runs = (await methods[M.routineRuns.name]!({ id: routines[0]!.id }, { caller: theUser })) as { runs: { outcome: string }[] };
    expect(runs.runs.map((r) => r.outcome)).toEqual(["done"]);
    await b.shutdown();
  });

  test("a session's end reaches lane J's terminals once", async () => {
    const ended: string[] = [];
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, onSessionEnded: (id) => ended.push(id) });
    b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    await b.host.stop("s_code");
    await b.host.stop("s_code");
    expect(ended).toEqual(["s_code"]);
    await b.shutdown();
  });
});

describe("webhooks through the webhook.ingress point (lane I's forwarder)", () => {
  test("a routine registers by its key's hash, each delivery runs once, late ones follow the missed rule, and all are acked or dropped", async () => {
    const host = new FakePluginHost({ clock: new FakeClock() });
    const calls: { method: string; args: unknown }[] = [];
    let queue: unknown[] = [];
    host.define("clover/forwarder", {
      ingress: {
        register: async (a: { routine: string; keyHash: string }) => (calls.push({ method: "register", args: a }), { url: `https://hooks.waifucave.com/tag1/${a.routine}` }),
        next: async () => {
          const deliveries = queue;
          queue = [];
          return { deliveries };
        },
        ack: async (a: unknown) => (calls.push({ method: "ack", args: a }), {}),
        drop: async (a: unknown) => (calls.push({ method: "drop", args: a }), {}),
      },
    } as never);
    const registry = { entries: (point: string) => (point === "webhook.ingress" ? [{ pluginId: "clover/forwarder", entryId: "waifucave", state: "active", value: { handler: "ingress" } }] : []) } as never;
    const clock = new FakeClock();
    const b = await boot({
      home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock,
      routines: { secrets: new MemorySecretStore(), watchFiles: false, ingress: { registry, host, poll: false } },
    });
    const r = await b.side.tools("b_alpha").find((t) => t.name === "Routine")!.run({ name: "Deploys", instructions: "Check the deploy.", webhook: true });
    const id = r.text.match(/routine (r_[a-z0-9]+)/)![1]!;
    expect(r.text).toContain(`Its webhook URL is https://hooks.waifucave.com/tag1/${id}`);
    const registered = calls.find((c) => c.method === "register")!.args as { keyHash: string };
    expect(registered.keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = new TextEncoder().encode("{\"ref\":\"main\"}");
    queue = [
      { id: "d1", routine: id, receivedAt: clock.now(), method: "POST", query: "", headers: [["content-type", "application/json"]], body, untrusted: true },
      { id: "d1", routine: id, receivedAt: clock.now(), method: "POST", query: "", headers: [], body, untrusted: true },
      { id: "d2", routine: "r_nosuchroutine", receivedAt: clock.now(), method: "POST", query: "", headers: [], body, untrusted: true },
    ];
    expect(await b.side.ingress!.pollOnce(0)).toBe(1);
    await flush();
    expect(calls.filter((c) => c.method !== "register")).toEqual([{ method: "ack", args: { ids: ["d1", "d1"] } }, { method: "drop", args: { ids: ["d2"] } }]);
    const thread = b.host.list({ kind: "side-thread" })[0]!;
    const input = b.drivers.for(thread.id).turns[0]!.input;
    expect(input.from === "routine" && input.text).toContain("Untrusted outside content from a webhook (application/json)");
    await b.shutdown();
  });
});
