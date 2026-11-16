// Hooks that only observe (`observe: true`): a `message.out` observer hears each stored reply with the bot and the
// session (`hearReply`), never inline and never counted as rewriting replies, so the replies keep streaming; what an
// observer answers is ignored on every event, and one that fails or answers a deny never refuses anything.
import { expect, test } from "bun:test";
import { hookOkLines, PLUGIN_API_VERSION, validateManifest } from "@waifucave/moss-plugin-sdk";
import type { InvokeRequest } from "../../../src/contracts/plugin-host";
import type { Contribution } from "../../../src/contracts/plugin-registry";
import { pluginHooks, type HookSession } from "../../../src/runtime-sdk/turn-loop/hooks";

const session: HookSession = { id: "s_luna_main", kind: "bot", caller: { kind: "user" } as HookSession["caller"], bot: "luna", computer: "c1" };

function harness(entries: { pluginId: string; value: Record<string, unknown> }[], answer: (r: InvokeRequest) => unknown) {
  const calls: InvokeRequest[] = [];
  const registry = {
    entries: (point: string) => (point === "hooks" ? entries.map((e) => ({ pluginId: e.pluginId, point, state: "active", value: e.value }) as unknown as Contribution) : []),
    get: () => undefined,
  };
  const host = { invoke: async (r: InvokeRequest) => { calls.push(r); return answer(r) as never; } };
  return { calls, hooks: pluginHooks({ registry: registry as never, host: host as never }) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("a message.out observer hears each stored reply with the bot and the session, and doesn't hold replies", async () => {
  const { calls, hooks } = harness([{ pluginId: "voice", value: { id: "hear", on: ["message.out"], handler: "hear", observe: true } }], () => ({ text: "IGNORED" }));
  // It doesn't make the replies wait for hooks (they stream).
  expect(hooks.rewritesReplies()).toBe(false);
  // Inline, it isn't called and changes nothing.
  expect(await hooks.messageOut(session, "hello")).toBe("hello");
  expect(calls).toEqual([]);
  // Once stored, it hears the reply.
  hooks.hearReply!(session, "hello there");
  await settle();
  expect(calls.length).toBe(1);
  const args = calls[0]!.args as { event: string; text: string; bot: string; session: { id: string; kind: string } };
  expect(args.event).toBe("message.out");
  expect(args.text).toBe("hello there");
  expect(args.bot).toBe("luna");
  expect(args.session.id).toBe("s_luna_main");
  expect(args.session.kind).toBe("bot");
});

test("a rewriting message.out hook still holds replies; the observer hears the rewritten text once", async () => {
  const { calls, hooks } = harness([
    { pluginId: "upper", value: { id: "up", on: ["message.out"], handler: "up" } },
    { pluginId: "voice", value: { id: "hear", on: ["message.out"], handler: "hear", observe: true } },
  ], (r) => (r.pluginId === "upper" ? { text: String((r.args as { text: string }).text).toUpperCase() } : { text: "IGNORED" }));
  expect(hooks.rewritesReplies()).toBe(true);
  const text = await hooks.messageOut(session, "hi");
  expect(text).toBe("HI");
  expect(calls.map((c) => c.pluginId)).toEqual(["upper"]);
  hooks.hearReply!(session, text);
  await settle();
  expect(calls.map((c) => c.pluginId)).toEqual(["upper", "voice"]);
  expect((calls[1]!.args as { text: string }).text).toBe("HI");
});

test("an observer's deny or crash refuses nothing; it hears the event after the others", async () => {
  const { calls, hooks } = harness([
    { pluginId: "guard", value: { id: "g", on: ["tool.before"], handler: "g", observe: true } },
  ], () => ({ deny: { reason: "no" } }));
  const r = await hooks.toolBefore(session, { name: "Bash", callId: "c" }, { command: "ls" });
  expect(r.deny).toBeUndefined();
  expect(r.input).toEqual({ command: "ls" });
  await settle();
  expect(calls.length).toBe(1);
  const crash = harness([{ pluginId: "guard", value: { id: "g", on: ["tool.before"], handler: "g", observe: true } }], () => { throw new Error("boom"); });
  expect((await crash.hooks.toolBefore(session, { name: "Bash", callId: "c" }, {})).deny).toBeUndefined();
});

test("the OK card says an observer sees, never that it changes", () => {
  const m = (observe: boolean) => validateManifest({
    manifest: 1, id: "voice-x", name: "Voice X", version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js" },
    contributes: { hooks: [{ id: "hear", on: ["message.out", "turn.end"], handler: "hear", ...(observe ? { observe: true } : {}) }] },
  });
  const observing = m(true);
  expect(observing.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(hookOkLines([observing])[0]).toBe("Its hooks see your conversations: the bots' replies.");
  expect(hookOkLines([m(false)])[0]).toBe("Its hooks see your conversations: the bots' replies; they can change messages.");
});
