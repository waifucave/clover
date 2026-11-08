// The in-process backends on another computer (K-M3, remote.ts, #240's review 4): Clover's coding agent and lane A's
// in-process subagents hold their own tool calls, read-only ones too, at a `PreToolUse` hook. Run on Laptop for a bot
// on Studio, they hold on the session's combined pause (`AcpStartSpec.pause`): Laptop's own switch, and Studio's
// forwarded one, which a dropped link turns on. Their sandbox is Seatbelt's, so these run on macOS only (lane C's Linux
// fence brings them to Linux); everywhere else, the backends say they aren't available, and a delegation is refused.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { IN_PROCESS_BACKEND_ID } from "../../runtime-sdk/turn-loop/subagent-backend";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { CLOVER_CODE_ID, CloverCodeBackend } from "../clover-code/backend";
import { inProcessBackend } from "../index";
import { darwinTest } from "../../../test/helpers/darwin-only";
import { closePair, LAPTOP, make, notification, OTHER, STUDIO, type Pair } from "./pair";
import { waitFor } from "./world";

setDefaultTimeout(60_000);
afterEach(closePair);

const MODEL = "winter-test/calls";

function baseOptionsFor(home: string, spawn: SpawnClaudeCodeProcess) {
  return (o: { model: string; effort?: string; cwd: string }): Options => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CLOVER_HOME: home };
    const provider = testProviderNameFor(o.model);
    if (provider !== undefined) env["WINTER_TEST_PROVIDER"] = provider;
    return { brand: buildCoreBrand(undefined, home), model: o.model, cwd: o.cwd, env, spawnClaudeCodeProcess: spawn, settingSources: [] };
  };
}

function pairWithInProcess(spawn: SpawnClaudeCodeProcess, sandboxReady?: () => boolean): Pair {
  const ready = sandboxReady ? { sandboxReady } : {};
  return make({
    b: {
      extraBackends: (wire, self) => [
        new CloverCodeBackend({ clock: { now: () => Date.now() } as never, wire, defaultModel: () => MODEL, baseOptions: (x) => baseOptionsFor(self.cloverHome, spawn)(x), ...ready }),
        inProcessBackend({ home: self.cloverHome, spawn, defaultModel: () => MODEL }, { home: self.cloverHome, ...ready }),
      ],
    },
  });
}

/** Whether the Read ran on Laptop: its result ("read me") is in the runtime's own record of the session there. */
function readRan(p: Pair): boolean {
  for (const f of new Bun.Glob("**/*.jsonl").scanSync({ cwd: p.b.cloverHome, absolute: true })) {
    try {
      if (readFileSync(f, "utf8").includes("read me")) return true;
    } catch {
      // A file being written.
    }
  }
  return false;
}

/** A Bash call that takes a while, then a read-only Read: the Read comes while the hold is on. */
async function start(p: Pair, backend: string) {
  await Bun.write(join(p.b.project, "README"), "read me");
  return p.a.manager.start({
    caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "bot" },
    backend, root: "home/Laptop/project1", computer: "Laptop", title: "Read", model: MODEL,
    prompt: [`CALL Bash {"command":"sleep 1.5"}`, `CALL Read {"file_path":${JSON.stringify(join(p.b.project, "README"))}}`].join("\n"),
  });
}

describeWithEmbeddedRuntime("the in-process backends on another computer", (spawn) => {
  for (const backend of [CLOVER_CODE_ID, IN_PROCESS_BACKEND_ID]) {
    test(`${backend}: on a computer without its sandbox, a delegation there is refused at once, saying why`, async () => {
      const p = pairWithInProcess(spawn, () => false);
      const t0 = Date.now();
      await start(p, backend);
      // The agent there never starts: its first turn ends at once with the reason (as any agent that can't start
      // there), not a hang.
      const n = await waitFor(() => notification(p.a), "the refusal");
      expect(n.stopReason).toBe("error");
      expect(n.text).toContain(`${backend} runs in the embedded runtime's sandbox, which is macOS-only for now: it isn't available`);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(readRan(p)).toBe(false);
    });

    darwinTest(`${backend}: after a takeover, the hold follows the new opener's pause, not the old one's`, async () => {
      const p = pairWithInProcess(spawn);
      await Bun.write(join(p.b.project, "README"), "read me");
      const r = await p.a.manager.start({
        caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "bot" },
        backend, root: "home/Laptop/project1", computer: "Laptop", title: "Warm up", model: MODEL, prompt: `CALL Bash {"command":"true"}`,
      });
      await waitFor(() => notification(p.a), "the first turn's end");
      // OTHER becomes the main and takes the agent over (the session, and its gate, stay); Studio isn't paused.
      p.fenceB.view = { scope: "acct_1", epoch: 4, holder: OTHER };
      const fence = p.fenceB.token();
      const other = await p.net.endpoint(OTHER).connect(LAPTOP);
      await other.request("agent.open", { id: r.sessionId, backend, root: "home/Laptop/project1", bot: "alpha", parent: "s_alpha", paused: false, epoch: "other:1", fence });
      await other.request("agent.turn", {
        id: r.sessionId, turn: 1, origin: "bot", paused: false, epoch: "other:1", fence,
        prompt: { text: [`CALL Bash {"command":"sleep 1.5"}`, `CALL Read {"file_path":${JSON.stringify(join(p.b.project, "README"))}}`].join("\n") },
      });
      await Bun.sleep(500);
      // The new opener pauses; Studio, the old one, still isn't.
      other.notify("agent.pause", { paused: true, epoch: "other:1", fence });
      await waitFor(() => p.peersB.peerPaused(OTHER), "OTHER's pause on Laptop");
      expect(p.peersB.peerPaused(STUDIO)).toBe(false);
      await Bun.sleep(2_500);
      expect(readRan(p)).toBe(false);
      other.notify("agent.pause", { paused: false, epoch: "other:1", fence });
      await waitFor(() => readRan(p), "the read once OTHER resumes");
    });

    darwinTest(`${backend}: the bot's pause on its own computer holds a read there`, async () => {
      const p = pairWithInProcess(spawn);
      await start(p, backend);
      await Bun.sleep(500);
      p.pauseA.set(true);
      await waitFor(() => p.peersB.peerPaused(STUDIO), "the pause on Laptop");
      // The Bash call ends at 1.5 s; the Read after it waits.
      await Bun.sleep(2_500);
      expect(notification(p.a)).toBeUndefined();
      expect(readRan(p)).toBe(false);
      p.pauseA.set(false);
      expect((await waitFor(() => notification(p.a), "the task notification")).stopReason).toBe("end_turn");
    });

    darwinTest(`${backend}: a dropped link holds a read there until the bot's computer is back`, async () => {
      const p = pairWithInProcess(spawn);
      await start(p, backend);
      await Bun.sleep(500);
      p.net.partition(STUDIO, LAPTOP);
      await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
      await Bun.sleep(2_500);
      // The Read hasn't run there: it waits for the bot's computer.
      expect(readRan(p)).toBe(false);
      p.net.heal(STUDIO, LAPTOP);
      expect((await waitFor(() => notification(p.a), "the task notification")).stopReason).toBe("end_turn");
      expect(readRan(p)).toBe(true);
    });
  }
});
