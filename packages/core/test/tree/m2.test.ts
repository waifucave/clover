// J-M2 on the fake link (plan §4 J, M2; controller rulings R1 and R4): approvals that follow the files, with the
// holder's reviewer and the user's answer from the calling computer; the direct path for copies and for `mv` and
// `cp` in Bash; levels per computer; the terminal panel's PTYs; MCP tools with `computer`, `saveTo` and Mirror.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../../src/contracts/common";
import { computersApiRoutes } from "../../src/computers/api";
import { placementFields, type McpResult, type McpServerPlacement } from "../../src/computers/mcp";
import type { PeerReviewer } from "../../src/tree/judge";
import { OUTPUT_BYTES_PER_SECOND, outputPacer, type TerminalOutput } from "../../src/tree/terminals";
import { answersFor, makePhone, type Phone } from "./answer-support";
import { Cluster, until, type ClusterOptions } from "./cluster-support";

const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const posix = process.platform !== "win32";

let cluster: Cluster;
afterEach(() => cluster?.close());

/** Two computers whose answers a phone signs; Studio's user is asked on the phone. */
async function two(o: { phone?: Phone; reviewer?: PeerReviewer; levels?: Record<string, "automatic" | "ask-risky" | "read-only" | "accept-edits">; extra?: ClusterOptions } = {}) {
  const phone = o.phone ?? (await makePhone());
  cluster = new Cluster();
  const opts: ClusterOptions = {
    answers: () => answersFor(phone),
    askUser: () => phone.ask,
    ...(o.reviewer ? { reviewer: () => o.reviewer } : {}),
    ...o.extra,
  };
  const studio = await cluster.add("Studio", opts);
  const laptop = await cluster.add("Laptop1", opts);
  for (const [name, level] of Object.entries(o.levels ?? {})) await cluster.get(name).node.registry.setLevel(name, level, { via: "terminal" });
  await cluster.join();
  return { studio, laptop, phone };
}

describe("approvals follow the files (R1)", () => {
  test("at ask-risky the holder's reviewer passes what isn't risky; the rest shows its card on the calling computer", async () => {
    const reviewed: string[] = [];
    const reviewer: PeerReviewer = async (c) => {
      reviewed.push(`${c.computer} ${c.method}`);
      return JSON.stringify(c.params).includes("risky") ? "risky" : "safe";
    };
    const { studio, laptop, phone } = await two({ reviewer });
    await studio.node.tree.write("home/Laptop1/plain.txt", utf8("plain"), { as: BOT });
    expect(readFileSync(join(laptop.home, "plain.txt"), "utf8")).toBe("plain");
    expect(phone.shown).toEqual([]);
    expect(reviewed).toContain("Laptop1 tree.write");
    // The reviewer asks: Laptop1's own card shows on Studio's user's phone, and the signed answer goes with the call.
    await studio.node.tree.write("home/Laptop1/risky.txt", utf8("risky"), { as: BOT });
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "tree.write"]]);
    expect(phone.shown[0]!.card?.binds?.computer).toBe("Laptop1");
    expect(readFileSync(join(laptop.home, "risky.txt"), "utf8")).toBe("risky");
    // A deny refuses it, and nothing is written.
    phone.deny = true;
    expect(await code(studio.node.tree.write("home/Laptop1/risky2.txt", utf8("risky"), { as: BOT }))).toBe("refused");
    expect(existsSync(join(laptop.home, "risky2.txt"))).toBe(false);
  });

  test("a reviewer that can't judge (no model can run) counts as risky", async () => {
    const { studio, laptop, phone } = await two({ reviewer: async () => "unavailable" });
    await studio.node.tree.write("home/Laptop1/x.txt", utf8("x"), { as: BOT });
    expect(phone.shown.map((n) => n.method)).toEqual(["tree.write"]);
    expect(readFileSync(join(laptop.home, "x.txt"), "utf8")).toBe("x");
  });

  test("a delete at ask-risky always asks; the reviewer isn't asked", async () => {
    const reviewed: string[] = [];
    const { studio, laptop, phone } = await two({ reviewer: async (c) => { reviewed.push(c.method); return "safe"; } });
    writeFileSync(join(laptop.home, "old.log"), "x");
    await studio.node.tree.remove("home/Laptop1/old.log", { as: BOT });
    expect(existsSync(join(laptop.home, "old.log"))).toBe(false);
    expect(phone.shown.map((n) => n.method)).toEqual(["tree.remove"]);
    expect(reviewed).toEqual([]);
  });

  test("a command on another computer: the reviewer there, or the user's answer for that command", async () => {
    if (!posix) return;
    const { studio, laptop, phone } = await two({ reviewer: async (c) => (JSON.stringify(c.params).includes("rm ") ? "risky" : "safe") });
    const ctx = { session: "s_alpha", sessionKind: "bot" as const, callId: "c1", cwd: "home/Studio" };
    const ok = await studio.node.tools.run("Bash", { command: "cd home/Laptop1 && echo fine" }, ctx);
    expect((ok.output as { stdout: string }).stdout).toBe("fine\n");
    expect(phone.shown).toEqual([]);
    writeFileSync(join(laptop.home, "gone.txt"), "x");
    const asked = await studio.node.tools.run("Bash", { command: "cd home/Laptop1 && rm gone.txt" }, { ...ctx, callId: "c2" });
    expect(asked.isError).toBe(false);
    expect(phone.shown.map((n) => n.method)).toEqual(["tool.run"]);
    expect(existsSync(join(laptop.home, "gone.txt"))).toBe(false);
  });
});

describe("the direct path: copies, and mv and cp in Bash (item 89)", () => {
  test("a move asks every holder up front, and the user answers one card for the whole move", async () => {
    const { studio, laptop, phone } = await two();
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    await studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT });
    // Both holders judge it as a peer's move at ask-risky; the user sees one card naming both computers.
    expect(phone.shown.map((n) => `${n.computer} ${n.method}`)).toEqual(["Laptop1 tree.transfer"]);
    expect(readFileSync(join(laptop.home, "proj", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(studio.home, "proj"))).toBe(false);
  });

  test("a read-only destination refuses a move into it before the user is asked, and nothing is left there", async () => {
    const { studio, laptop, phone } = await two({ levels: { Laptop1: "read-only" } });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    expect(await code(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT }))).toBe("refused");
    expect(phone.shown).toEqual([]);
    expect(existsSync(join(laptop.home, "proj"))).toBe(false);
    expect(readdirSync(laptop.home).filter((n) => n.startsWith(".clover-receiving-"))).toEqual([]);
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(true);
  });

  test("an answer spent already sends the card back to the user rather than dead-ending", async () => {
    const { studio, laptop, phone } = await two();
    writeFileSync(join(studio.home, "a.txt"), "a");
    const whole = { op: "move", from: "home/Studio/a.txt", to: "home/Laptop1/a.txt", source: "Studio", destination: "Laptop1" };
    const answer = await phone.approve("Laptop1", "tree.transfer", whole);
    await studio.node.tree.move("home/Studio/a.txt", "home/Laptop1/a.txt", { as: BOT, answer });
    expect(phone.shown).toEqual([]);
    // The same move again, with the answer both holders spent: the user is asked once more, and it goes through.
    writeFileSync(join(studio.home, "a.txt"), "a2");
    rmSync(join(laptop.home, "a.txt"));
    await studio.node.tree.move("home/Studio/a.txt", "home/Laptop1/a.txt", { as: BOT, answer });
    expect(phone.shown.map((n) => n.method)).toEqual(["tree.transfer"]);
    expect(readFileSync(join(laptop.home, "a.txt"), "utf8")).toBe("a2");
  });

  test("a holder whose own rule is stricter refuses the move whatever the answer, before the user is asked", async () => {
    const { studio, laptop, phone } = await two({ levels: { Studio: "read-only" } });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    expect(await code(laptop.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT }))).toBe("refused");
    expect(phone.shown).toEqual([]);
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(true);
    expect(existsSync(join(laptop.home, "proj"))).toBe(false);
  });

  test("a copy between computers keeps the source; a copy on one computer too", async () => {
    const { studio, laptop, phone } = await two({ levels: { Laptop1: "automatic", Studio: "automatic" } });
    mkdirSync(join(studio.home, "proj", "src"), { recursive: true });
    writeFileSync(join(studio.home, "proj", "src", "a.ts"), "export {}");
    await studio.node.tree.copy("home/Studio/proj", "home/Laptop1/proj", { as: BOT });
    expect(readFileSync(join(laptop.home, "proj", "src", "a.ts"), "utf8")).toBe("export {}");
    expect(existsSync(join(studio.home, "proj", "src", "a.ts"))).toBe(true);
    await studio.node.tree.copy("home/Laptop1/proj", "home/Laptop1/proj2", { as: BOT });
    expect(readFileSync(join(laptop.home, "proj2", "src", "a.ts"), "utf8")).toBe("export {}");
    expect(phone.shown).toEqual([]);
    expect(await code(studio.node.tree.copy("home/Studio/proj", "home/Laptop1/proj", { as: BOT }))).toBe("conflict");
  });

  test("Bash's plain mv and cp -r between computers take the direct path, as the shell would answer", async () => {
    const { studio, laptop } = await two({ levels: { Laptop1: "automatic", Studio: "automatic" } });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    mkdirSync(join(laptop.home, "inbox"));
    const ctx = { session: "s_alpha", sessionKind: "bot" as const, callId: "c1", cwd: "home/Studio" };
    const cp = await studio.node.tools.run("Bash", { command: "cp -r proj home/Laptop1/inbox" }, ctx);
    expect(cp).toMatchObject({ isError: false, output: "" });
    expect(readFileSync(join(laptop.home, "inbox", "proj", "a.txt"), "utf8")).toBe("a");
    expect((await studio.node.tools.run("Bash", { command: "cp proj home/Laptop1/x" }, ctx)).isError).toBe(true);
    const mv = await studio.node.tools.run("Bash", { command: "mv 'proj/a.txt' home/Laptop1/moved.txt" }, ctx);
    expect(mv.isError).toBe(false);
    expect(readFileSync(join(laptop.home, "moved.txt"), "utf8")).toBe("a");
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(false);
  });
});

describe("transfers count in the bulk slots (check 2's N3)", () => {
  test("another computer's transfers here wait behind its 4 slots, and a full queue refuses", async () => {
    const { studio, laptop } = await two({ levels: { Laptop1: "automatic", Studio: "automatic" } });
    writeFileSync(join(studio.home, "a.txt"), "a");
    const gates: (() => void)[] = [];
    const held = Array.from({ length: 4 }, () => laptop.node.bulk.run(studio.device, () => new Promise<void>((r) => gates.push(r))));
    await until(() => gates.length === 4, 1000, "Studio's four slots on Laptop1 to fill");
    let done = false;
    const move = studio.node.tree.move("home/Studio/a.txt", "home/Laptop1/a.txt", { as: BOT }).then(() => { done = true; });
    await Bun.sleep(50);
    expect(done).toBe(false);
    gates.shift()!();
    await move;
    expect(readFileSync(join(laptop.home, "a.txt"), "utf8")).toBe("a");
    // With every slot taken and the queue behind them full, a transfer is refused at once.
    // Three of the four still run; one more takes the free slot, and 32 wait behind them.
    const queued = Array.from({ length: 33 }, () => laptop.node.bulk.run(studio.device, () => new Promise<void>((r) => gates.push(r))));
    writeFileSync(join(studio.home, "b.txt"), "b");
    await until(() => gates.length === 4, 1000, "the slots to fill again");
    expect(await code(studio.node.tree.move("home/Studio/b.txt", "home/Laptop1/b.txt", { as: BOT }))).toBe("refused");
    expect(existsSync(join(studio.home, "b.txt"))).toBe(true);
    while (gates.length) gates.shift()!(), await Bun.sleep(1);
    await Promise.all([...held, ...queued]);
  });
});

describe("levels per computer", () => {
  test("another computer's level is changed there: a lowering at once, a raise with the user's answer for its card", async () => {
    const { studio, laptop, phone } = await two();
    await studio.node.registry.setLevel("Laptop1", "read-only");
    expect(laptop.node.registry.self().level).toBe("read-only");
    expect(phone.shown).toEqual([]);
    await until(() => studio.node.registry.get("Laptop1")!.level === "read-only", 2000, "the copy to update");
    await studio.node.registry.setLevel("Laptop1", "automatic");
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "computer.setLevel"]]);
    expect(laptop.node.registry.self().level).toBe("automatic");
    phone.deny = true;
    await studio.node.registry.setLevel("Laptop1", "ask");
    expect(await code(studio.node.registry.setLevel("Laptop1", "automatic"))).toBe("refused");
    expect(laptop.node.registry.self().level).toBe("ask");
  });
});

describe("holds on another computer's screen (review minor 4)", () => {
  test("live on that computer: two computers can't hold the same app on a third, and a turn's end lets go everywhere", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    const desk = await cluster.add("Desk");
    await cluster.join();
    const inSession = (sessionId: string) => ({ pluginId: "opensky", caller: { kind: "session" as const, sessionId, sessionKind: "bot" as const } });
    const fromStudio = computersApiRoutes(studio.node.registry, studio.node.holds);
    const fromDesk = computersApiRoutes(desk.node.registry, desk.node.holds);
    const a = (await fromStudio["computers.takeHold"]!(["Laptop1", { kind: "app", app: "Figma" }], inSession("s_a"))) as { held: boolean; hold: { id: string } };
    expect(a.held).toBe(true);
    expect(laptop.node.registry.holds("Laptop1").map((h) => h.session)).toEqual(["s_a"]);
    expect(await fromDesk["computers.takeHold"]!(["Laptop1", { kind: "app", app: "Figma" }], inSession("s_b"))).toEqual({ held: false, reason: "held-by-other", by: "s_a" });
    expect(((await fromDesk["computers.holds"]!(["Laptop1"], inSession("s_b"))) as { holds: unknown[] }).holds.length).toBe(1);
    // Laptop1's user working in an app refuses a hold from any computer.
    laptop.node.registry.markUserWorking("Laptop1", "Mail");
    expect(await fromDesk["computers.takeHold"]!(["Laptop1", { kind: "app", app: "Mail" }], inSession("s_b"))).toEqual({ held: false, reason: "user-working" });
    // Studio's session ends its turn: its hold on Laptop1 goes.
    expect(await studio.node.holds.releaseSession("s_a")).toBe(1);
    expect(laptop.node.registry.holds("Laptop1")).toEqual([]);
    // A dropped link lets go of the holds that computer took.
    await fromDesk["computers.takeHold"]!(["Laptop1", { kind: "app", app: "Figma" }], inSession("s_b"));
    expect(laptop.node.registry.holds("Laptop1").length).toBe(1);
    cluster.net.partition(desk.device, laptop.device);
    await until(() => laptop.node.registry.holds("Laptop1").length === 0, 2000, "the hold to go with the link");
  });
});

describe("the terminal panel (R4)", () => {
  const sh = () => ({ launch: (cwd: string) => ({ cmd: ["/bin/sh"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, PS1: "$ ", TERM: "xterm" } }) });

  test("a shell here, and one on another computer whose output streams back", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { studio, laptop, phone } = await two({ levels: { Laptop1: "automatic" }, extra: { terminals: sh } });
    const out = new Map<string, string>();
    studio.node.terminals.onOutput((o: TerminalOutput) => out.set(o.terminalId, (out.get(o.terminalId) ?? "") + o.data));
    const here = await studio.node.terminals.open({ computer: "Studio", cols: 80, rows: 24 });
    await studio.node.terminals.write(here.terminalId, "echo here-$((40+2))\r");
    await until(() => (out.get(here.terminalId) ?? "").includes("here-42"), 5000, "the local shell's output");
    mkdirSync(join(laptop.home, "proj"));
    const there = await studio.node.terminals.open({ computer: "Laptop1", cwd: "home/Laptop1/proj", cols: 80, rows: 24, session: "s_alpha" });
    await studio.node.terminals.write(there.terminalId, "pwd\r");
    await until(() => (out.get(there.terminalId) ?? "").includes(join(laptop.home, "proj")), 5000, "Laptop1's shell's output");
    expect(phone.shown).toEqual([]);
    // Another session on Studio can't write to it: the holder keys it to the device and the session.
    const link = await cluster.net.endpoint(studio.device).connect(laptop.device);
    expect(isContractError(await rejection(link.request("terminal.write", { terminalId: there.terminalId, data: "x", session: "s_other" })), "not_found")).toBe(true);
    // A dropped link closes the peer's terminals, as ssh does.
    expect(laptop.node.terminalCount()).toBe(1);
    cluster.net.partition(studio.device, laptop.device);
    await until(() => laptop.node.terminalCount() === 0, 3000, "Laptop1 to close the terminal");
    await studio.node.terminals.close(here.terminalId);
  });

  test("below automatic a terminal on another computer takes the user's answer; read-only refuses a plugin here", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { studio, laptop, phone } = await two({ extra: { terminals: sh } });
    const t = await studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 });
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "terminal.open"]]);
    await studio.node.terminals.close(t.terminalId);
    phone.deny = true;
    expect(await code(studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 }))).toBe("refused");
    await studio.node.registry.setLevel("Studio", "read-only");
    const plugin: Caller = { kind: "plugin", pluginId: "panel-terminal" };
    expect(await code(studio.node.terminals.open({ computer: "Studio", cols: 80, rows: 24 }, plugin))).toBe("refused");
    void laptop;
  });

  test("one computer keeps at most 8 terminals at another; a session's end closes its terminals everywhere", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { studio, laptop } = await two({ levels: { Laptop1: "automatic" }, extra: { terminals: sh } });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24, session: i < 4 ? "s_alpha" : "s_beta" })).terminalId);
    expect(laptop.node.terminalCount()).toBe(8);
    expect(await code(studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 }))).toBe("refused");
    const here = await studio.node.terminals.open({ computer: "Studio", cols: 80, rows: 24, session: "s_alpha" });
    expect(await studio.node.terminals.closeSession("s_alpha")).toBe(5);
    await until(() => laptop.node.terminalCount() === 4, 3000, "s_alpha's terminals on Laptop1 to close");
    expect(studio.node.terminalCount()).toBe(0);
    void here;
    // Output that isn't a terminal's shape is dropped, not passed to the app.
    const seen: unknown[] = [];
    studio.node.terminals.onOutput((o) => seen.push(o));
    cluster.net.endpoint(laptop.device).connect(studio.device).then((l) => l.notify("terminal_output", { terminalId: ids[5], data: 42 }));
    await Bun.sleep(30);
    expect(seen.filter((o) => (o as { data: unknown }).data === 42)).toEqual([]);
    // Disposing the router closes what it opened elsewhere.
    studio.node.terminals.dispose();
    await until(() => laptop.node.terminalCount() === 0, 3000, "the rest to close on Laptop1");
  });

  test("the pacer gathers small chunks on its tick, keeps to its rate, and drops past its backlog with a note", async () => {
    const got: TerminalOutput[] = [];
    // 200 KB/s and a 400 KB backlog, so the test is quick: 1,000 chunks of 600 bytes, all at once.
    const pace = outputPacer((o) => got.push(o), { rate: 200_000, backlog: 400_000 });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) pace({ terminalId: "t", data: "y\n".repeat(300) });
    pace({ terminalId: "t", data: "", exited: { code: 0 } });
    expect(got.length).toBe(0); // nothing goes out at once
    await until(() => got.some((o) => o.exited), 10_000, "the exit");
    const seconds = (performance.now() - t0) / 1000;
    const delivered = got.filter((o) => !o.data.startsWith("\r\n[clover")).reduce((n, o) => n + o.data.length, 0);
    expect(delivered).toBeLessThanOrEqual(400_000);
    expect(delivered).toBeGreaterThan(390_000);
    expect(delivered / seconds).toBeLessThan(200_000 * 1.25);
    // A frame per tick, not per chunk; the note in a frame of its own, then the exit.
    expect(got.length).toBeLessThan(seconds * 20 + 5);
    expect(got.at(-2)!.data).toContain("some output was dropped");
    expect(got.at(-1)!.exited).toEqual({ code: 0 });
  });

  test("a terminal on another computer streams a steady flood at the pacer's rate", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const flood = () => ({ launch: () => ({ cmd: ["/bin/sh", "-c", "yes | head -c 3000000"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }) });
    const { studio } = await two({ levels: { Laptop1: "automatic" }, extra: { terminals: flood } });
    let bytes = 0;
    let frames = 0;
    let done = false;
    studio.node.terminals.onOutput((o) => { bytes += o.data.length; frames++; if (o.exited) done = true; });
    const t0 = performance.now();
    await studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 });
    await until(() => done, 20_000, "the flood to end");
    const seconds = (performance.now() - t0) / 1000;
    expect(bytes).toBeGreaterThan(2_900_000); // the PTY turns \n into \r\n, so a little more
    expect(bytes / seconds).toBeLessThan(OUTPUT_BYTES_PER_SECOND * 1.25);
    expect(frames).toBeLessThan(seconds * 20 + 5);
  }, 30_000);

  test("a paste of several lines waits for the user's OK, and goes bracketed when the program asked", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    let ok = false;
    const asked: string[] = [];
    const cat = () => ({
      launch: () => ({ cmd: ["/bin/sh", "-c", "printf '\\033[?2004h'; exec cat"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm" } }),
      confirmPaste: async (text: string) => { asked.push(text); return ok; },
    });
    const { studio } = await two({ extra: { terminals: cat } });
    let seen = "";
    studio.node.terminals.onOutput((o) => { seen += o.data; });
    const t = await studio.node.terminals.open({ computer: "Studio", cols: 80, rows: 24 });
    await until(() => seen.includes("\u001b[?2004h"), 3000, "the program to ask for bracketed paste");
    await studio.node.terminals.write(t.terminalId, "one\ntwo\n", { paste: true });
    expect(asked).toEqual(["one\ntwo\n"]);
    await Bun.sleep(100);
    expect(seen.includes("one")).toBe(false);
    ok = true;
    await studio.node.terminals.write(t.terminalId, "one\ntwo\n", { paste: true });
    await until(() => seen.includes("200~"), 3000, "the bracketed paste to echo");
    await studio.node.terminals.close(t.terminalId);
  });
});

describe("MCP tools across computers", () => {
  const blender: McpServerPlacement = { name: "blender", kind: "local", computers: ["Studio", "Laptop1"] };
  const figma: McpServerPlacement = { name: "figma", kind: "remote", computers: [] };
  const PNG = Buffer.from("not really a png").toString("base64");

  test("a local server on two computers gets a required computer field; a remote one an optional saveTo", () => {
    const tools = [{ name: "Render", inputSchema: { type: "object" as const, properties: { scene: { type: "string" } }, required: ["scene"] } }];
    const local = placementFields(blender, tools);
    expect(local.fields).toEqual({ computer: "computer" });
    expect(local.tools[0]!.inputSchema.required).toEqual(["scene", "computer"]);
    expect((local.tools[0]!.inputSchema.properties!.computer as { enum: string[] }).enum).toEqual(["Studio", "Laptop1"]);
    expect(placementFields({ ...blender, computers: ["Studio"] }, tools).fields).toEqual({});
    expect(placementFields(figma, tools).fields).toEqual({ saveTo: "saveTo" });
    expect(placementFields(figma, tools).tools[0]!.inputSchema.required).toEqual(["scene"]);
    // A clash: the server's own field keeps its name, ours is prefixed.
    const clash = [{ name: "Go", inputSchema: { type: "object" as const, properties: { computer: { type: "string" }, saveTo: { type: "string" } } } }];
    expect(placementFields(blender, clash).fields).toEqual({ computer: "cloverComputer" });
    expect(placementFields(figma, clash).fields).toEqual({ saveTo: "cloverSaveTo" });
  });

  test("calls run on the computer they name, or the one that holds saveTo, and the files land there", async () => {
    const calls: string[] = [];
    const host = (self: string) => async (c: { server: string; tool: string; input: Record<string, unknown>; as: Caller }): Promise<McpResult> => {
      calls.push(`${self} ${c.server}.${c.tool} ${JSON.stringify(c.input)} as ${c.as.kind}`);
      return { content: [{ type: "text", text: `done on ${self}` }, { type: "image", data: PNG, mimeType: "image/png" }] };
    };
    const servers = new Map([["blender", blender], ["figma", figma]]);
    const { studio, laptop } = await two({
      levels: { Laptop1: "automatic" },
      extra: {
        mcp: (name) => ({
          placement: (s) => servers.get(s),
          fields: (s) => placementFields(servers.get(s)!, [{ name: "x", inputSchema: { type: "object" } }]).fields,
          call: host(name),
          scratch: () => `home/${name}/scratch`,
        }),
      },
    });
    const ctx = { session: "s_alpha", as: BOT as Caller, callId: "call_1" };
    const r = await studio.node.mcp!.run("blender", "Render", { scene: "a", computer: "Laptop1" }, ctx);
    expect(r.computer).toBe("Laptop1");
    expect(calls).toEqual(['Laptop1 blender.Render {"scene":"a"} as peer']);
    expect(r.result.content[0]).toEqual({ type: "text", text: "done on Laptop1" });
    expect(r.result.content[1]).toEqual({ type: "text", text: "Saved an image to home/Laptop1/scratch/call_1-0.png" });
    expect(readFileSync(join(laptop.home, "scratch", "call_1-0.png"), "base64")).toBe(PNG);
    // The field is required, and checked against the live list.
    expect(await code(studio.node.mcp!.run("blender", "Render", { scene: "a" }, ctx))).toBe("invalid");
    expect(await code(studio.node.mcp!.run("blender", "Render", { scene: "a", computer: "Desktop9" }, ctx))).toBe("invalid");
    // A remote tool with saveTo on Laptop1: Laptop1 makes the call and keeps the file.
    mkdirSync(join(laptop.home, "designs"));
    const f = await studio.node.mcp!.run("figma", "Export", { node: "1", saveTo: "home/Laptop1/designs" }, { ...ctx, callId: "call_2" });
    expect(f.computer).toBe("Laptop1");
    expect(readFileSync(join(laptop.home, "designs", "call_2-0.png"), "base64")).toBe(PNG);
    // Without saveTo, this computer calls and keeps it in the session's scratch folder.
    const g = await studio.node.mcp!.run("figma", "Export", { node: "2" }, { ...ctx, callId: "call_3" });
    expect(g.computer).toBe("Studio");
    expect(readFileSync(join(studio.home, "scratch", "call_3-0.png"), "base64")).toBe(PNG);
    // An offline computer answers at once.
    cluster.net.partition(laptop.device);
    expect(await code(studio.node.mcp!.run("blender", "Render", { scene: "a", computer: "Laptop1" }, ctx))).toBe("computer_offline");
  });

  test("Mirror installs a server on another computer only with the user's answer for that computer's card", async () => {
    const installed: string[] = [];
    const { studio, phone } = await two({
      levels: { Laptop1: "automatic" },
      extra: {
        mcp: (name) => ({
          placement: () => undefined, fields: () => ({}), call: async () => ({ content: [] }), scratch: () => `home/${name}`,
          install: async (server, config) => { installed.push(`${name} ${server} ${JSON.stringify(config)}`); },
        }),
      },
    });
    const r = await studio.node.mirror("blender", { command: "blender-mcp" }, ["Laptop1"], "s_alpha");
    expect(r).toEqual({ installed: ["Laptop1"], failed: [] });
    expect(installed).toEqual(['Laptop1 blender {"command":"blender-mcp"}']);
    // Even at automatic: installing a server always asks.
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "mcp.mirror"]]);
    phone.deny = true;
    const no = await studio.node.mirror("other", {}, ["Laptop1"]);
    expect(no.installed).toEqual([]);
    expect(no.failed[0]).toMatchObject({ computer: "Laptop1", code: "refused" });
  });
});
