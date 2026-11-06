// The bot's agent tools (spec §9.3 "How a delegation runs"): `Agent` and `TaskStop`, in a neutral shape: a name, a
// description that stands on its own, a JSON Schema and a `run`. The embedded runtime registers them as core tools
// (lane A, with lane D for the bot's session). `SendMessage` and `ListAgents` are the bot's own tools (lane D's
// bots/tools.ts, the controller's ruling: one `ListAgents`): `SendMessage` reaches an agent through the
// session host, as it reaches any session, and `ListAgents` lists the agents from `AgentManager.sessionHooks().agents`.
import { ContractError, isContractError } from "../contracts/common";
import type { Level, TurnOrigin } from "@waifucave/clover-protocol";
import type { AgentManager } from "./manager";

export interface CoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<{ text: string; isError: boolean }>;
}

/** The calling bot's session, as the runtime knows it. */
export interface AgentToolCaller {
  bot: string;
  session: string;
  origin: TurnOrigin;
  /** A routine's raised level, for a side thread's delegations (§7). */
  level?: Level;
}

function fail(err: unknown): { text: string; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { text: isContractError(err) ? `${msg} (${err.code})` : msg, isError: true };
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function agentToolDefs(manager: AgentManager, caller: AgentToolCaller, opts: { backends?: () => string[] } = {}): CoreToolDef[] {
  const backends = opts.backends?.() ?? [];
  return [
    {
      name: "Agent",
      description: [
        "Start a background coding agent (Claude Code, Codex, Cursor, Antigravity …) on a task, in a folder of the",
        "folder tree. It returns at once with the agent's session id; the agent works in the background, can message",
        "you with SendMessage while it works, and when it finishes you get a task notification with its final report",
        "and the path to its full transcript. Use ListAgents to see it and TaskStop to stop it; a message you send it",
        "with SendMessage becomes its next prompt. Write the prompt as a complete brief: the agent sees nothing of this",
        "conversation.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short title for the task, three to six words." },
          prompt: { type: "string", description: "The task, as a complete brief." },
          backend: backends.length > 0 ? { type: "string", enum: backends, description: "Which agent runs it." } : { type: "string", description: "Which agent runs it (an agent backend's id)." },
          root: { type: "string", description: "The folder it works in, as a folder-tree path: home/<Computer>/…" },
          model: { type: "string", description: "The agent's model, where it offers a choice." },
          effort: { type: "string", description: "The agent's effort level, where it offers one." },
          computer: { type: "string", description: "The computer to run on; the one holding the root by default." },
        },
        required: ["prompt", "backend", "root"],
        additionalProperties: false,
      },
      run: async (input) => {
        const prompt = str(input, "prompt");
        const backend = str(input, "backend");
        const root = str(input, "root");
        if (!prompt || !backend || !root) return fail(new ContractError("invalid", "Agent needs a prompt, a backend and a root folder"));
        try {
          const model = str(input, "model");
          const effort = str(input, "effort");
          const computer = str(input, "computer");
          const title = str(input, "description");
          const r = await manager.start({
            caller: { kind: "bot", bot: caller.bot, session: caller.session, origin: caller.origin, ...(caller.level === undefined ? {} : { level: caller.level }) },
            backend, prompt, root,
            ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(computer ? { computer } : {}), ...(title ? { title } : {}),
          });
          return {
            text: `Started agent ${r.sessionId} (${backend}) in ${root}. It runs in the background: you'll get a task notification when it finishes, with its report and its transcript (${r.transcript}). ListAgents shows it; TaskStop stops it.`,
            isError: false,
          };
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: "TaskStop",
      description: "Stop one of your background agents by its session id: it is cancelled, its process ends, and you get its task notification.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The agent's session id." } }, required: ["id"], additionalProperties: false },
      run: async (input) => {
        const id = str(input, "id");
        if (!id) return fail(new ContractError("invalid", "TaskStop needs the agent's session id"));
        try {
          await manager.stop(id, { bot: caller.bot });
          return { text: `Stopped ${id}.`, isError: false };
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}
