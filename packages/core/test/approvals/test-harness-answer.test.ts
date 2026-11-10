// The test-marked build's one relaxation of the cards (scripts/test-build.ts; INT's option B for the acceptance run):
// the harness's own `cli` connection may list, frame and answer cards, and the broker takes its sealed-frame answer as
// the app's origin. A real build has none of it: the role gate refuses card.* to `cli`, and the broker refuses a
// sealed-frame proof from anything but the app. The test-build half runs in a child under the same define a test build
// is compiled with (`bun --define __CLOVER_TEST_BUILD__=…`), since a test process from source is a real build.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Card } from "@waifucave/clover-protocol";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { gateCloverRequest } from "../../src/auth/clover-caller";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";

const USER_CLI = { kind: "user", client: "cli" } as const;
const SESSION = { kind: "session", sessionId: "s_0123456789ab", sessionKind: "bot", bot: "luna" } as const;
const req: ApprovalRequest = {
  kind: "tool", session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect: "execute", ruleKey: "Bash(ls)",
  fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "ls", language: "sh" } },
};

/** A card on a broker of its own, and its answer from `from` on the card's minted channel (or `frame`). */
async function answerFrom(from: { role: "app" | "cli"; testHarness?: true }, frame?: string): Promise<string> {
  const b = new CloverApprovalBroker({ clock: new FakeClock() });
  let card: Card | undefined;
  const off = b.watch((e) => { if (e.type === "requested") card = e.card; });
  const pending = b.request(req);
  for (let i = 0; i < 100 && card === undefined; i++) await Bun.sleep(5);
  off();
  const option = card!.options.find((o) => o.kind === "approve")!.id;
  const result = await b.answer(card!.id, { optionId: option, hash: card!.hash, proof: { via: "sealed-frame", frame: frame ?? b.frameChannel(card!.id)!, input: "click", at: 1 } }, from as never);
  b.close();
  await pending.catch(() => undefined);
  return result;
}

describe("a real build (this process: no test-build define)", () => {
  test("the role gate refuses card.list, card.frame and card.answer to the cli role", () => {
    for (const m of ["card.list", "card.frame", "card.answer"]) expect(gateCloverRequest("cli", USER_CLI, m)?.message).toContain(`the cli role may not call ${m}`);
    expect(gateCloverRequest("app", { kind: "user", client: "app" }, "card.answer")).toBeNull();
  });

  test("the broker refuses a sealed-frame proof from anything but the app, a would-be harness included", async () => {
    expect(await answerFrom({ role: "app" })).toBe("accepted");
    expect(await answerFrom({ role: "cli" })).toBe("bad-origin");
    expect(await answerFrom({ role: "cli", testHarness: true })).toBe("bad-origin");
  });
});

// The same checks in a child under the test build's define.
const CHILD = `
  const { gateCloverRequest } = await import(${JSON.stringify(join(import.meta.dir, "../../src/auth/clover-caller.ts"))});
  const { CloverApprovalBroker } = await import(${JSON.stringify(join(import.meta.dir, "../../src/approvals/broker.ts"))});
  const { FakeClock } = await import(${JSON.stringify(join(import.meta.dir, "../../src/contracts/fakes/clock.ts"))});
  const req = ${JSON.stringify(req)};
  const answerFrom = async (from, wrongFrame) => {
    const logs = [];
    const b = new CloverApprovalBroker({ clock: new FakeClock(), log: (l) => logs.push(l) });
    let card;
    const off = b.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = b.request(req);
    for (let i = 0; i < 100 && card === undefined; i++) await Bun.sleep(5);
    off();
    const option = card.options.find((o) => o.kind === "approve").id;
    const result = await b.answer(card.id, { optionId: option, hash: card.hash, proof: { via: "sealed-frame", frame: wrongFrame ? "frame_not_minted" : b.frameChannel(card.id), input: "click", at: 1 } }, from);
    const stale = await b.answer(card.id, { optionId: option, hash: "0".repeat(64), proof: { via: "sealed-frame", frame: "x", input: "click", at: 1 } }, from);
    b.close();
    await pending.catch(() => undefined);
    return { result, stale, logs };
  };
  const gate = (role, caller, m) => gateCloverRequest(role, caller, m)?.message ?? null;
  const out = {
    userCli: ["card.list", "card.frame", "card.answer"].map((m) => gate("cli", ${JSON.stringify(USER_CLI)}, m)),
    sessionCli: gate("cli", ${JSON.stringify(SESSION)}, "card.answer"),
    otherMethod: gate("cli", ${JSON.stringify(USER_CLI)}, "card.confirm"),
    harness: await answerFrom({ role: "cli", testHarness: true }),
    plainCli: (await answerFrom({ role: "cli" })).result,
    harnessWrongFrame: (await answerFrom({ role: "cli", testHarness: true }, true)).result,
    remoteMarked: (await answerFrom({ role: "remote", testHarness: true })).result,
  };
  process.stdout.write(JSON.stringify(out));
`;

describe("a test-marked build (a child under the test build's define)", () => {
  test("the harness's own cli connection may frame and answer; nothing else is relaxed, and every other check holds", () => {
    const r = spawnSync(process.execPath, ["--define", `__CLOVER_TEST_BUILD__="CLOVER-TEST-BUILD"`, "-e", CHILD], { encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { userCli: (string | null)[]; sessionCli: string | null; otherMethod: string | null; harness: { result: string; stale: string; logs: string[] }; plainCli: string; harnessWrongFrame: string; remoteMarked: string };
    // The gate: the user's cli (the harness token, outside any session) may call the three; a session's may not, nor
    // any other card method.
    expect(out.userCli).toEqual([null, null, null]);
    expect(out.sessionCli).toContain("may not call card.answer");
    expect(out.otherMethod).toContain("may not call card.confirm");
    // The broker: the harness's sealed-frame answer on the minted channel counts as the app's, said once in the log.
    expect(out.harness.result).toBe("accepted");
    expect(out.harness.stale).toBe("already-answered");
    expect(out.harness.logs.filter((l) => l.includes("the acceptance harness answered card"))).toHaveLength(1);
    // A cli connection not marked as the harness, a channel the broker didn't mint, or any other role is refused.
    expect(out.plainCli).toBe("bad-origin");
    expect(out.harnessWrongFrame).toBe("bad-origin");
    expect(out.remoteMarked).toBe("bad-origin");
  });
});
