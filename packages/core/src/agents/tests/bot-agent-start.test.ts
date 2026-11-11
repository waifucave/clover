// A bot's Agent call, by class (the controller's ruling of 2026-11-11), through the real broker: one row per backend
// kind × approval level × session kind. Clover's own sandboxed agents start with no card at every level; any other
// backend asks on a card at each start (showing the backend and the whole task, with no "always"), and a read-only
// computer refuses it; a side thread starts only the former. Then what holds the child to its bot: the backend's
// identity, its commands asking while the bot's do, its commands writing temp alone, no Agent of its own, and its
// sandbox never off.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, type Level } from "@waifucave/clover-protocol";
import { botApprovalCheck } from "../../approvals/bot-check";
import { CloverApprovalBroker } from "../../approvals/broker";
import type { BotSessionContext } from "../../bots/service";
import type { AgentBackend } from "../../contracts/agent-backend";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { BOT_SANDBOX } from "../../runtime-sdk/turn-loop/driver";
import { SUBAGENT_TOOLS } from "../../runtime-sdk/turn-loop/subagent-backend";
import { bridgeOwnTools } from "../bridge/tools";
import { CLOVER_CODE_TOOLS } from "../clover-code/backend";
import { botChildPolicy } from "../manager";
import { AGENT_STARTS_PER_TURN, AGENT_TASK_CARD_MAX, AgentStarts, agentStartPolicy } from "../start-policy";
import { waitFor, World, type WorldOptions } from "./world";

const run = () => ({ signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
const ctxOf = (kind: "bot" | "side-thread", session = kind === "bot" ? "b_alpha" : "s_routine"): BotSessionContext =>
  ({ botId: "alpha", sessionId: session, kind, computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: session, sessionKind: kind, bot: "alpha" } }) as unknown as BotSessionContext;

/** The backends of each kind, as the manager would answer `isContainedBackend` for them. */
const KINDS = [
  { backend: "clover", kind: "Clover's in-process agent", contained: true },
  { backend: "clover-code", kind: "Clover's coding agent", contained: true },
  { backend: "codex", kind: "a bundled coding agent outside Clover's sandbox", contained: false },
  { backend: "acme-agent", kind: "a plugin's agent backend", contained: false },
  { backend: "cursor", kind: "a backend not admitted here", contained: false },
] as const;

/** One Agent call through the check and the real broker at `level`: allowed or refused, and the cards it raised. */
async function startAt(level: Level, kind: "bot" | "side-thread", backend: string, o: { answer?: "approve" | "none"; prompt?: string; agent?: string; starts?: AgentStarts } = {}) {
  const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => level, localComputer: "Studio" });
  const ac = new AbortController();
  const cards: ApprovalRequest[] = [];
  const shown: string[] = [];
  const watched = {
    request: (r: ApprovalRequest, x: { signal?: AbortSignal } = {}) => broker.request(r, {
      ...x,
      onCard: (id) => {
        cards.push(r);
        shown.push(id);
        if (o.answer === "approve") {
          const card = broker.cards().find((c) => c.id === id)!;
          queueMicrotask(() => void broker.answer(id, { optionId: card.options.find((op) => op.kind === "approve")!.id, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(id)!, input: "click", at: 1 } }, { role: "app" }).catch(() => ac.abort()));
        } else ac.abort();
      },
    }),
  };
  const check = botApprovalCheck(watched, {
    hostTools: () => ["Agent", "TaskStop", "SendMessage", "ListAgents"],
    agentStart: agentStartPolicy({
      contained: async (b) => KINDS.find((k) => k.backend === b)?.contained === true,
      backends: () => KINDS.map((k) => k.backend),
      definition: (_c, name) => (name === "alpha:study-buddy" ? { pluginId: "alpha", id: "study-buddy", name: "Study buddy", prompt: "Read the folder; write notes.md." } : undefined),
      starts: o.starts ?? new AgentStarts(),
    }),
  });
  const input = { backend, prompt: o.prompt ?? "Fix the failing test.", root: "home/Studio/project", ...(o.agent ? { agent: o.agent } : {}) };
  const r = await check(ctxOf(kind), () => (kind === "bot" ? "user" : "routine"))("Agent", input, { ...run(), signal: ac.signal });
  return { behavior: r.behavior, message: (r as { message?: string }).message, cards, card: shown[0] === undefined ? undefined : broker.get(shown[0])?.card };
}

describe("the class table: backend kind × level × session kind", () => {
  for (const k of KINDS) for (const level of LEVELS) for (const session of ["bot", "side-thread"] as const) {
    const want = k.contained ? "allow, no card"
      : session === "side-thread" ? "refused, no card"
      : level === "read-only" ? "refused, no card"
      : "a card";
    test(`${k.kind} (${k.backend}) at ${level}, from a ${session === "bot" ? "bot's conversation" : "side thread"}: ${want}`, async () => {
      const r = await startAt(level, session, k.backend);
      if (want === "allow, no card") expect([r.behavior, r.cards.length]).toEqual(["allow", 0]);
      else if (want === "refused, no card") expect([r.behavior, r.cards.length]).toEqual(["deny", 0]);
      else {
        expect(r.cards).toHaveLength(1);
        expect(r.cards[0]).toMatchObject({ cardAlways: true, effect: "execute" });
      }
    });
  }
});

describe("a card on each start: the backend, the whole task, no always; answered yes it starts", () => {
  test("the card names the backend and shows the definition's words and the brief, whole; it offers no Always", async () => {
    const brief = `Fix the failing test.\n${"x".repeat(10_000)}`;
    const r = await startAt("automatic", "bot", "codex", { prompt: brief, agent: "alpha:study-buddy" });
    expect(r.cards).toHaveLength(1);
    const fields = r.cards[0]!.fields as Record<string, { code?: string; text?: string }>;
    expect(fields.what!.code).toContain("codex");
    expect(fields.detail!.code).toBe(`Read the folder; write notes.md.\n\n---\n\n${brief}`);
    expect(r.card!.options.some((op) => op.remember !== undefined)).toBe(false);
  });

  test("answered yes, the start goes on; every start asks again", async () => {
    const starts = new AgentStarts();
    expect((await startAt("automatic", "bot", "codex", { answer: "approve", starts })).behavior).toBe("allow");
    expect((await startAt("automatic", "bot", "codex", { answer: "approve", starts })).cards).toHaveLength(1);
  });

  test("refused before any card: a task too long to show whole, an unknown backend or definition", async () => {
    expect(await startAt("automatic", "bot", "codex", { prompt: "y".repeat(AGENT_TASK_CARD_MAX + 1) })).toMatchObject({ behavior: "deny", cards: [] });
    expect(await startAt("automatic", "bot", "made-up")).toMatchObject({ behavior: "deny", cards: [] });
    expect(await startAt("automatic", "bot", "clover-code", { agent: "alpha:nope" })).toMatchObject({ behavior: "deny", cards: [] });
  });
});

test(`at most ${AGENT_STARTS_PER_TURN} starts a turn, before any card; the next turn starts again`, async () => {
  const starts = new AgentStarts();
  for (let i = 0; i < AGENT_STARTS_PER_TURN; i++) expect((await startAt("ask-risky", "bot", "clover-code", { starts })).behavior).toBe("allow");
  const over = await startAt("ask-risky", "bot", "codex", { starts });
  expect(over).toMatchObject({ behavior: "deny", cards: [] });
  expect(over.message).toContain(`at most ${AGENT_STARTS_PER_TURN}`);
  starts.turnStarted("b_alpha");
  expect((await startAt("ask-risky", "bot", "clover-code", { starts })).behavior).toBe("allow");
});

test("only a bot's own conversation starts agents: an agent's session is refused", async () => {
  const policy = agentStartPolicy({ contained: async () => true, backends: () => ["clover-code"], starts: new AgentStarts() });
  const agentCtx = { ...ctxOf("bot"), kind: "agent" } as unknown as BotSessionContext;
  expect(await policy(agentCtx, { backend: "clover-code", prompt: "x" }, "bot")).toMatchObject({ kind: "refused" });
});

describe("what holds the child to its bot", () => {
  let world: World | undefined;
  afterEach(async () => { await world?.close(); world = undefined; });
  const make = (o: WorldOptions = {}) => (world = new World(o));
  const stub = (id: string, d: { sandboxed: boolean; installed?: boolean }, placement: "local" | "cloud" = "local") =>
    ({ id, pluginId: `x/${id}`, quirks: { placement }, detect: async () => ({ installed: d.installed ?? true, identityOk: true, versionOk: true, sandboxed: d.sandboxed }) }) as unknown as AgentBackend;

  test("contained is the reserved id, resolved, installed and sandboxed; any other id, however sandboxed, is not", async () => {
    const w = make({ extraBackends: () => [stub("clover-code", { sandboxed: true }), stub("clover", { sandboxed: false }), stub("codex", { sandboxed: true })] });
    expect(await w.manager.isContainedBackend("clover-code")).toBe(true);
    expect(await w.manager.isContainedBackend("clover")).toBe(false);
    expect(await w.manager.isContainedBackend("codex")).toBe(false);
    expect(await w.manager.isContainedBackend("fake")).toBe(false);
    expect(await w.manager.isContainedBackend("nowhere")).toBe(false);
  });

  test("a bot's agent's commands ask on a card every time while the bot's do, at every level", async () => {
    const w = make({ level: "automatic", commandsAlwaysCard: true, script: [[{ tool: { kind: "execute", title: "make", rawInput: { command: "make" } } }, { say: "Built." }]] });
    const seen: ApprovalRequest[] = [];
    const real = w.approvals.request.bind(w.approvals);
    (w.approvals as { request: typeof real }).request = (r, o) => (seen.push(r), real(r, o));
    await w.delegate();
    await waitFor(() => seen.find((r) => r.kind === "agent-permission"), "the agent's request");
    expect(seen.find((r) => r.kind === "agent-permission")).toMatchObject({ effect: "execute", cardAlways: true });
  });

  test("a bot's agent's commands write temp alone, never the user's home its folder is in", async () => {
    const w = make({ script: [[{ wait: true }]] });
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    const policy = JSON.parse(readFileSync(join(w.cloverHome, "run", "agents", r.sessionId, "policy.json"), "utf8")) as { allowWrite: string[] };
    expect(policy.allowWrite).not.toContain(w.userHome);
    expect(policy.allowWrite.length).toBeGreaterThan(0);
    for (const p of policy.allowWrite) expect(join(w.project, "x").startsWith(`${p}/`)).toBe(false);
    // The rule itself: any write root holding the folder goes; with none left, nothing starts.
    expect(botChildPolicy({ allowWrite: ["/Users/u", "/tmp/t"], denyWrite: [], denyRead: [] }, "/Users/u/project", "/Users/u").allowWrite).toEqual(["/tmp/t"]);
    expect(() => botChildPolicy({ allowWrite: ["/Users/u"], denyWrite: [], denyRead: [] }, "/Users/u/project", "/Users/u")).toThrow();
  });

  test("one level: neither of Clover's agents nor the bridge offers Agent; their sandbox is never off", () => {
    expect(SUBAGENT_TOOLS).not.toContain("Agent");
    expect(CLOVER_CODE_TOOLS).not.toContain("Agent");
    expect(bridgeOwnTools("alpha").map((t) => t.name)).not.toContain("Agent");
    expect(BOT_SANDBOX).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
  });
});
