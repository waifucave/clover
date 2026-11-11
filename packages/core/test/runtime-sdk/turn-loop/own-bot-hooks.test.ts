// A bot plugin's hooks scoped to its own bot (`scope: "own-bot"`): the host hands them only the sessions of the bots
// the plugin's tree contributes (their conversations, side threads and delegations), never another bot's or a
// user's own coding session; the OK card says "only what its own bot does"; widening to `bots` asks for the OK again.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookOkLines, PLUGIN_API_VERSION, validateManifest } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../../src/contracts/fakes/approval-broker";
import { FakeClock } from "../../../src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { openPluginRegistry } from "../../../src/registry/open";
import type { Caller } from "@waifucave/clover-protocol";
import type { InvokeRequest } from "../../../src/contracts/plugin-host";
import type { Contribution } from "../../../src/contracts/plugin-registry";
import { pluginHooks, servesSession, type HookSession } from "../../../src/runtime-sdk/turn-loop/hooks";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test("own-bot: the plugin's own bots' sessions and their delegations only", () => {
  const own = (s: { kind: "bot" | "side-thread" | "agent" | "coding"; bot?: string }, plugin = "luna") => servesSession("own-bot", s, plugin);
  expect(own({ kind: "bot", bot: "luna" })).toBe(true);
  expect(own({ kind: "side-thread", bot: "luna" })).toBe(true);
  expect(own({ kind: "agent", bot: "luna" })).toBe(true);
  expect(own({ kind: "bot", bot: "sol" })).toBe(false);
  expect(own({ kind: "agent", bot: "sol" })).toBe(false);
  expect(own({ kind: "coding" })).toBe(false);
  expect(own({ kind: "agent" })).toBe(false);
  // A pack's child bot belongs to its tree; another tree's same-looking id doesn't.
  expect(own({ kind: "bot", bot: "pack/luna" }, "pack")).toBe(true);
  expect(own({ kind: "bot", bot: "pack/luna" }, "pack/sol")).toBe(true);
  expect(own({ kind: "bot", bot: "packed" }, "pack")).toBe(false);
  expect(servesSession("own-bot", { kind: "bot", bot: "luna" })).toBe(false);
  // `bots` still sees every bot.
  expect(servesSession("bots", { kind: "bot", bot: "sol" })).toBe(true);
});

const manifest = (scope: string) => ({
  manifest: 1, id: "luna", name: "Luna", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  host: { entry: "host/index.js" },
  contributes: { hooks: [{ id: "watch", on: ["tool.after", "turn.end"], handler: "watch", scope }] },
});

test("the OK card names the narrower scope", () => {
  const own = validateManifest(manifest("own-bot"));
  expect(own.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(hookOkLines([own])[0]).toBe("Its hooks see only what its own bot does: what each tool returns; they can change what a tool returns.");
  expect(hookOkLines([validateManifest(manifest("bots"))])[0]).toBe("Its hooks see your conversations: what each tool returns; they can change what a tool returns.");
  expect(validateManifest(manifest("everyone")).issues.some((i) => i.severity === "error")).toBe(true);
});

test("widening a hook from own-bot to bots asks for the OK again (its scope is in what it runs, and its card line changes)", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-ownbot-")));
  temps.push(home);
  const dir = join(home, "plugins", "luna");
  mkdirSync(join(dir, "host"), { recursive: true });
  writeFileSync(join(dir, "host", "index.js"), "export const watch = async () => undefined;\n");
  writeFileSync(join(dir, "clover.json"), JSON.stringify(manifest("own-bot")));
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50, sandboxed: true });
  try {
    const reg = opened.registry;
    await reg.approve("luna", reg.get("luna")!.treeHash!);
    expect(reg.get("luna")!.state).toBe("running");
    writeFileSync(join(dir, "clover.json"), JSON.stringify(manifest("bots")));
    await opened.folders.refresh(dir);
    expect(reg.get("luna")!.state).toBe("found");
    expect(opened.folders.okText("luna", "macos", false, true).lines).toContain("Its hooks see your conversations: what each tool returns; they can change what a tool returns.");
  } finally {
    opened.close();
  }
});

test("the host hands an own-bot hook only its own bot's sessions, and a throw or a timeout on tool.after or turn.end is skipped, reported, and leaves the turn alone", async () => {
  const entries: Contribution[] = [
    { point: "hooks", pluginId: "luna", ref: "hooks/watch", state: "active", value: { id: "watch", on: ["tool.after", "turn.end"], handler: "watch", scope: "own-bot", timeoutMs: 50 } },
  ];
  const calls: InvokeRequest[] = [];
  const skipped: { pluginId: string; hook: string; reason: string }[] = [];
  let mode: "throw" | "timeout" = "throw";
  const hooks = pluginHooks({
    registry: { entries: ((point: string) => (point === "hooks" ? entries : [])) as never, get: ((id: string) => ({ id, manifest: {} })) as never },
    host: {
      invoke: (async (req: InvokeRequest) => {
        calls.push(req);
        if (mode === "throw") throw new Error("kaboom");
        const e = new Error("timed out") as Error & { code: string };
        e.code = "timeout";
        throw e;
      }) as never,
    },
    onSkipped: (s) => skipped.push(s),
  });
  const as = (bot: string | undefined, kind: HookSession["kind"] = "bot"): HookSession => {
    const caller = { kind: "session", sessionId: `s_${bot ?? "me"}`, sessionKind: kind, ...(bot === undefined ? {} : { bot }) } as Caller;
    return { id: `s_${bot ?? "me"}`, kind, caller, ...(bot === undefined ? {} : { bot }), computer: "Studio" };
  };
  // Another bot's turn and the user's own coding session never reach her hook.
  expect(await hooks.toolAfter(as("sol"), { name: "Read", callId: "c" }, {}, "result")).toBe("result");
  await hooks.turnEnd(as(undefined, "coding"), "done", "completed");
  expect(calls).toEqual([]);
  // Her own bot's turn: it runs; a throw or a timeout is skipped and reported, the result unchanged, the turn ends.
  for (const m of ["throw", "timeout"] as const) {
    mode = m;
    expect(await hooks.toolAfter(as("luna"), { name: "Read", callId: "c" }, {}, "result")).toBe("result");
    await hooks.turnEnd(as("luna"), "done", "completed");
  }
  expect(calls.map((c) => (c.args as { event: string }).event)).toEqual(["tool.after", "turn.end", "tool.after", "turn.end"]);
  expect(skipped.map((s) => [s.pluginId, s.hook])).toEqual([["luna", "watch"], ["luna", "watch"], ["luna", "watch"], ["luna", "watch"]]);
});
