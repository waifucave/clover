// A-M1 review S3: THE WORKER-CHURN SOAK, inside a real daemon process. Run by `worker-churn-soak.test.ts` in a
// child process (a Bun crash must show up as that child's exit status, never take the test runner down).
//
// Boots a daemon on a temp home with a fake model (no model calls), then:
//   1. CHURN: `rounds` code sessions one after another, each created, given one turn, and ended, so every
//      round spawns one Worker and terminates it, the pattern Bun 1.3.14's Worker use-after-free needs;
//   2. CONCURRENCY: `concurrent` code sessions live at once, each through one turn, to measure what one live
//      code session's Worker costs the daemon in resident memory.
// Prints one JSON line: the rounds completed, the RSS readings, and the per-session estimate.
import { METHODS } from "@waifucave/clover-protocol";
import { mb, rss, startSoakDaemon } from "./soak-support";

const rounds = Number(process.env["SOAK_ROUNDS"] ?? "80");
const concurrent = Number(process.env["SOAK_CONCURRENT"] ?? "8");

const { daemon, client, cwd, stop } = await startSoakDaemon("worker-soak", "winter-test/echo");

async function oneTurn(): Promise<string> {
  const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "soak", mode: "code", model: "winter-test/echo", cwd, approvalPolicy: "auto" });
  await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  const before = client.events.length;
  await client.call(METHODS.sessionSend, { sessionId, text: "hello" });
  await client.turnCompleted(sessionId, before);
  return sessionId;
}

const out: Record<string, unknown> = { rounds, concurrent };
try {
  const start = rss();
  // 1. churn: one Worker spawned and terminated per round.
  let completed = 0;
  for (let i = 0; i < rounds; i++) {
    const sid = await oneTurn();
    await daemon.clover.get(sid)?.end();
    completed++;
  }
  out["churnRounds"] = completed;
  out["liveAfterChurn"] = daemon.embedded.live().length;
  const afterChurn = rss();
  // 2. concurrency: `concurrent` live code sessions at once.
  const ids: string[] = [];
  for (let i = 0; i < concurrent; i++) ids.push(await oneTurn());
  const withLive = rss();
  out["liveDuring"] = daemon.embedded.live().length;
  for (const sid of ids) await daemon.clover.get(sid)?.end();
  await Bun.sleep(500);
  const afterEnd = rss();
  out["rssMb"] = { start: mb(start), afterChurn: mb(afterChurn), withLive: mb(withLive), afterEnd: mb(afterEnd) };
  out["perLiveCodeSessionMb"] = mb((withLive - afterChurn) / concurrent);
  out["retainedPerChurnRoundMb"] = mb((afterChurn - start) / Math.max(1, completed));
} finally {
  await stop();
}
console.log(JSON.stringify(out));
process.exit(0);
