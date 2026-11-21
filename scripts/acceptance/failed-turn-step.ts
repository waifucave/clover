// A coding session whose turn failed stays open (lane MC1k), headless, on the real path: the user's coding session on MOSS's
// own agent is started (the app's `agent.start`) on a model the run holds no key for (named: since 2026-11-20 the default is
// computed from the providers the person added, so it is always one with a key), and its first
// message fails with the provider's own reason, as an error row. The session is not ended: `session.list` says so, and the
// same session answers once the user switches it to the model the run's key drives (`session.setModel`, the call the model
// picker makes) and sends again.
import { fail, type ExampleCtx } from "./example-steps";

export const FAILED_TURN_STEP = "a coding session's turn fails for a missing key and shows the provider's reason; the session stays open, and the same session answers after the user switches it to a model with a key";

type Ev = Record<string, unknown>;

/** A model of a provider the run holds no key for (Codex's sign-in). */
const UNKEYED_MODEL = "codex-oauth/gpt-5.6-sol";

export async function failedTurnStep(ctx: ExampleCtx): Promise<string> {
  const done: string[] = [];
  const computer = (await ctx.rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) fail("computer.list lists no computer");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(join(ctx.userHome, "failed-turn"), { recursive: true });
  const keyed = (await ctx.rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.model;
  if (keyed === undefined) fail("Alpha has no model to give the coding session once it is switched");
  const session = (await ctx.rpc.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/failed-turn`, model: UNKEYED_MODEL }, 30_000)).session;

  const first = await ctx.turn(session, "say hello", 150_000);
  const stop = String(first.events.find((e: Ev) => e.type === "turn_completed")?.stopReason ?? "?");
  const errors = first.events.filter((e: Ev) => e.type === "agent_error" || e.type === "error").map((e: Ev) => String(e.message ?? e.error ?? JSON.stringify(e)));
  const said = first.events.some((e: Ev) => e.type === "assistant_message");
  if (said) fail("the session answered on a model the run holds no key for; the row needs an unkeyed one");
  if (stop === "end_turn" && errors.length === 0) fail(`the turn on the unkeyed model ended ${stop} with no error row (events: ${[...new Set(first.events.map((e: Ev) => String(e.type)))].join(", ")})`);
  const whole = (await ctx.rpc.request<{ events: Ev[] }>("session.history", { id: session, limit: 200 })).events;
  const wording = JSON.stringify(whole.filter((e: Ev) => e.type !== "turn_started"));
  if (!/key|credential|sign.?in|auth/i.test(wording)) fail(`the failed turn does not give the provider's reason (${wording.slice(0, 500)})`);
  done.push(`the turn failed (stop ${stop}) with the provider's reason in its record`);

  const row = async () => (await ctx.rpc.request<{ sessions: { id: string; status?: string }[] }>("session.list", { kinds: ["coding"] })).sessions.find((s) => s.id === session);
  const afterFail = await row();
  if (afterFail === undefined || afterFail.status === "failed" || afterFail.status === "stopped") fail(`the failed turn ended the session (its row reads ${afterFail?.status ?? "missing"})`);
  done.push(`the session stays open (status ${afterFail?.status})`);

  await ctx.rpc.request("session.setModel", { id: session, model: keyed }, 30_000);
  const second = await ctx.turn(session, "say hello again", 150_000);
  const reply = second.events.some((e: Ev) => e.type === "assistant_message");
  const stop2 = String(second.events.find((e: Ev) => e.type === "turn_completed")?.stopReason ?? "?");
  if (!reply || stop2 === "error") fail(`the same session did not answer after the switch to ${keyed} (stop ${stop2}; ${second.events.map((e: Ev) => String(e.type)).join(", ").slice(0, 200)})`);
  const rows = (await ctx.rpc.request<{ sessions: { id: string }[] }>("session.list", { kinds: ["coding"] })).sessions.filter((s) => s.id === session);
  if (rows.length !== 1) fail("the answer did not come in the session that failed");
  done.push(`switched to ${keyed}, the same session answered`);
  return done.join("; ");
}
