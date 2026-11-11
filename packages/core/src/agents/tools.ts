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

export interface AgentToolOptions {
  backends?: () => string[];
  /** The runtime's own `TaskStop`, which this one hides (A-M3's `shadowBuiltins`): a task id that names none of the
   *  bot's agents is passed on to it, so the bot's background commands and monitors still stop. */
  stopRuntimeTask?: (taskId: string) => Promise<{ text: string; isError: boolean }>;
  /** Whether the bot may start an agent on `model` (lane D's provider check, #311 S1): a provider the user didn't
   *  choose or allow for the bot asks the user first, and a no refuses the call. */
  checkModel?: (model: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** A plugin's agent definition by the name Glossary gives it (`<plugin>:<id>`). It brings words only: its
   *  instructions go before the bot's brief, and its backend, model and effort fill only what the bot left out, each
   *  held to the same checks as the bot's own; the folder, the computer and the tools are the bot's alone. */
  definition?: (name: string) => AgentDefinitionView | undefined;
}

/** What the Agent tool takes of a plugin's agent definition (glossary.ts `AgentDefinition`). */
export interface AgentDefinitionView {
  pluginId: string;
  id: string;
  name: string;
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
}

export function agentToolDefs(manager: AgentManager, caller: AgentToolCaller, opts: AgentToolOptions = {}): CoreToolDef[] {
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
          ...(opts.definition === undefined ? {} : { agent: { type: "string", description: "A plugin's agent definition to start from, by the name Glossary lists (<plugin>:<id>): its instructions go before your brief, and its backend, model and effort fill what you leave out. The folder and the computer stay yours to give." } }),
        },
        required: opts.definition === undefined ? ["prompt", "backend", "root"] : ["prompt", "root"],
        additionalProperties: false,
      },
      run: async (input) => {
        const named = str(input, "agent");
        const def = named === undefined ? undefined : opts.definition?.(named);
        if (named !== undefined && def === undefined) return fail(new ContractError("not_found", `no agent definition ${named.slice(0, 120)} (Glossary lists them as <plugin>:<id>)`));
        const brief = str(input, "prompt");
        const prompt = def === undefined || brief === undefined ? brief : `${def.prompt === "" ? "" : `${def.prompt}\n\n---\n\n`}${brief}`;
        const backend = str(input, "backend") ?? def?.backend;
        const root = str(input, "root");
        if (!prompt || !backend || !root) return fail(new ContractError("invalid", "Agent needs a prompt, a backend and a root folder"));
        if (backends.length > 0 && !backends.includes(backend)) return fail(new ContractError("invalid", `no agent backend ${backend.slice(0, 64)} (${backends.join(", ")})`));
        try {
          const model = str(input, "model") ?? def?.model;
          if (model !== undefined && opts.checkModel !== undefined) {
            const verdict = await opts.checkModel(model);
            if (!verdict.ok) return { text: verdict.reason, isError: true };
          }
          const effort = str(input, "effort") ?? def?.effort;
          const computer = str(input, "computer");
          const title = str(input, "description") ?? def?.name;
          const r = await manager.start({
            caller: { kind: "bot", bot: caller.bot, session: caller.session, origin: caller.origin, ...(caller.level === undefined ? {} : { level: caller.level }) },
            backend, prompt, root,
            ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(computer ? { computer } : {}), ...(title ? { title } : {}),
          });
          const from = def === undefined ? "" : ` with ${def.pluginId}'s agent definition ${def.id}`;
          return {
            text: `Started agent ${r.sessionId} (${backend})${from} in ${root}. It runs in the background: you'll get a task notification when it finishes, with its report and its transcript (${r.transcript}). ListAgents shows it; TaskStop stops it.`,
            isError: false,
          };
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: "TaskStop",
      description: opts.stopRuntimeTask
        ? "Stop one of your background agents by its session id (it is cancelled, its process ends, and you get its task notification), or one of your background commands or monitors by its task id."
        : "Stop one of your background agents by its session id: it is cancelled, its process ends, and you get its task notification.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: opts.stopRuntimeTask ? "The agent's session id, or the background task's id." : "The agent's session id." },
          ...(opts.stopRuntimeTask ? { task_id: { type: "string", description: "The same as id, as background commands name it." } } : {}),
        },
        ...(opts.stopRuntimeTask ? {} : { required: ["id"] }),
        additionalProperties: false,
      },
      run: async (input) => {
        const id = str(input, "id") ?? (opts.stopRuntimeTask ? str(input, "task_id") : undefined);
        if (!id) return fail(new ContractError("invalid", "TaskStop needs the agent's session id"));
        try {
          await manager.stop(id, { bot: caller.bot });
          return { text: `Stopped ${id}.`, isError: false };
        } catch (err) {
          // Not one of Clover's agents at all: the runtime's own task (a background command, a monitor), if it has one.
          if (opts.stopRuntimeTask && isContractError(err) && err.code === "not_found") return opts.stopRuntimeTask(id);
          return fail(err);
        }
      },
    },
  ];
}
