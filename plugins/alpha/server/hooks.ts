// Alpha's hooks: her stage reacts to her own turns even when the model calls no stage tool. They only observe: each
// handler returns nothing, so no hook of hers ever rewrites an input, a result or a message, adds a note, or denies or
// holds a call. A reference plugin shows hooks that watch, not hooks that steer.
//
// * `turn.start`: the activity says "thinking".
// * `tool.after`: today's tool count goes up, and the activity says which tool ran (the file's name, never its path).
//   Not `tool.before`: a `tool.before` hook that crashes or runs late refuses the call (it fails closed), and a stage
//   reaction is never worth a refused call.
// * `turn.end`: today's turn count goes up; a turn that failed leaves her sad and one that was interrupted alert (a
//   completed turn keeps the mood she chose); the activity clears.
// They never undo what her own stage tools chose in the turn: a mood she set stays unless the turn went wrong.
// Only her own bot's sessions count: her manifest scopes every hook `own-bot`, which the host enforces before it calls
// one, and each handler checks the hook's `bot` is hers again. With the `reactions` setting off, only the tally moves.
import type { StageStore } from "./store";

export interface HookArgs {
  event?: string;
  bot?: string;
  session?: { id?: string; kind?: string };
  tool?: { name?: string };
  input?: unknown;
  outcome?: "completed" | "failed" | "interrupted";
}

export interface HookDeps {
  store: StageStore;
  bot: string;
  reactions(): Promise<boolean>;
  today(): string;
}

/** A tool's short label: its name, and the file it touched by name only. */
export function toolLabel(tool: string, input: unknown): string {
  const plain = tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");
  const path = input !== null && typeof input === "object" ? ((input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).path) : undefined;
  const file = typeof path === "string" ? path.split(/[\\/]/).filter((p) => p !== "").pop() : undefined;
  return (file === undefined ? plain : `${plain} ${file}`).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80);
}

const MOOD_OF: Record<"completed" | "failed" | "interrupted", "sad" | "alert" | undefined> = { completed: undefined, failed: "sad", interrupted: "alert" };

/** Each hook, as her host exports it. Every one resolves to undefined: they only observe. */
export function stageHooks(d: HookDeps): {
  onTurnStart(args: HookArgs): Promise<undefined>;
  onToolAfter(args: HookArgs): Promise<undefined>;
  onTurnEnd(args: HookArgs): Promise<undefined>;
} {
  const mine = (a: HookArgs) => a.bot === d.bot;
  return {
    async onTurnStart(a) {
      if (!mine(a) || !(await d.reactions())) return undefined;
      await d.store.change({ kind: "activity", activity: { kind: "thinking", label: "thinking" } });
      return undefined;
    },
    async onToolAfter(a) {
      if (!mine(a)) return undefined;
      await d.store.change({ kind: "tally", tools: 1, day: d.today() });
      if (await d.reactions()) await d.store.change({ kind: "activity", activity: { kind: "tool", label: toolLabel(a.tool?.name ?? "a tool", a.input) } });
      return undefined;
    },
    async onTurnEnd(a) {
      if (!mine(a)) return undefined;
      await d.store.change({ kind: "tally", turns: 1, day: d.today() });
      if (await d.reactions()) {
        const mood = MOOD_OF[a.outcome ?? "completed"];
        if (mood !== undefined) await d.store.change({ kind: "mood", mood });
        await d.store.change({ kind: "activity" });
      }
      return undefined;
    },
  };
}
