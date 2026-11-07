// MCP tools across computers (spec §9.1 "MCP tools across computers", the owner's design of November 3; plan §4 J,
// M2, with lane B). The MCP host itself (servers, sign-ins, the MCP block in the prompt) is lanes B's and D's; this
// is where a call runs and where its files land.
//
// * A local server (a `stdio` command, or plugin code bound to its computer) runs on each computer it is installed on.
//   On two or more, each of its tools gains a required `computer` field listing them, and the call runs there; on one,
//   there is no field and every call goes to it. A server that gained a computer since the prompt's list was made has
//   no field yet, so its calls go to its first computer until the refresh; a field's value is checked against the
//   live list.
// * A remote server (`http`, or plugin code that only talks to the web) runs from anywhere. Each of its tools gains an
//   optional `saveTo` folder in the tree: the computer that holds that folder makes the call, so the files land there
//   without a second transfer. Without it, the computer running the session makes the call and the files go to the
//   session's scratch folder.
// * A call's files are its embedded resources and images: the computer that made the call writes them into the folder
//   and puts their tree paths in the result instead.
// * A name clash: a server whose tools already have a `computer` or `saveTo` field gets `cloverComputer` or
//   `cloverSaveTo` instead, for that server.
// * Another computer's call is `tool.run` with the tool `mcp__<server>__<tool>`, judged there as a command at the
//   stricter of that computer's level and the call's (R1), its answer bound to the tool and its input.
// * Mirror installs a local server on the other computers, each copy running on its own computer: `mcp.mirror` to
//   each, which installs only with the user's answer for that computer's own card.
import { checkActFence, fenceParam, type ActFence } from "../tree/fencing";
import { extname } from "node:path";
import { z } from "zod";
import { FencingToken, Level, SessionId, SignedCardAnswer, type Caller } from "@waifucave/clover-protocol";
import { ContractError, isContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import { isTreePath } from "../tree/tools";
import { judgePeer, withAnswer, type AnswerAsker, type Answers } from "../tree/judge";
import { offlineAs } from "../tree/remote";
import type { LocalHolder } from "../tree/holder";
import type { CoreTree, TreeDirectory } from "../tree/tree";

/** A tool as the MCP host lists it. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

/** Where a server runs: local ones on the computers it is installed (or ticked) on, in order; remote ones anywhere. */
export interface McpServerPlacement {
  name: string;
  kind: "local" | "remote";
  /** Local servers: the computers that have it, the first first. */
  computers: readonly string[];
}

/** The fields a server's tools carry, as the prompt's list gave them. */
export interface McpFields {
  computer?: string;
  saveTo?: string;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: string; [k: string]: unknown };

export interface McpResult {
  content: McpContent[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Calls a tool of a server running on this computer (lanes B and D's MCP host). */
export type McpCaller = (call: { server: string; tool: string; input: Record<string, unknown>; as: Caller; session: string; signal?: AbortSignal }) => Promise<McpResult>;

/** Each server's tools with the fields this placement gives them, and the names it used. */
export function placementFields(server: McpServerPlacement, tools: readonly McpToolDef[]): { tools: McpToolDef[]; fields: McpFields } {
  const has = (name: string) => tools.some((t) => Object.prototype.hasOwnProperty.call(t.inputSchema.properties ?? {}, name));
  if (server.kind === "local") {
    if (server.computers.length < 2) return { tools: tools.map((t) => structuredClone(t)), fields: {} };
    const field = has("computer") ? "cloverComputer" : "computer";
    return {
      fields: { computer: field },
      tools: tools.map((t) => {
        const s = structuredClone(t.inputSchema);
        s.properties = { ...(s.properties ?? {}), [field]: { type: "string", enum: [...server.computers], description: "The computer to run this on." } };
        s.required = [...new Set([...(s.required ?? []), field])];
        return { ...structuredClone(t), inputSchema: s };
      }),
    };
  }
  const field = has("saveTo") ? "cloverSaveTo" : "saveTo";
  return {
    fields: { saveTo: field },
    tools: tools.map((t) => {
      const s = structuredClone(t.inputSchema);
      s.properties = { ...(s.properties ?? {}), [field]: { type: "string", description: "A folder in the tree (home/<Computer>/…) for the files this returns; the computer that holds it makes the call." } };
      return { ...structuredClone(t), inputSchema: s };
    }),
  };
}

/** The tool name `tool.run` carries for an MCP call. */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

const IMAGE_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" };

/** A plain file name for a call's file. */
function fileName(callId: string, i: number, c: McpContent): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  const prefix = `${safe(callId)}-${i}`;
  if (c.type === "image") return `${prefix}${IMAGE_EXT[(c as { mimeType: string }).mimeType] ?? ".bin"}`;
  const uri = (c as { resource: { uri: string } }).resource.uri;
  let base = "";
  try {
    base = decodeURIComponent(new URL(uri).pathname.split("/").pop() ?? "");
  } catch {
    base = uri.split(/[\\/]/).pop() ?? "";
  }
  base = safe(base);
  return base && extname(base) ? `${prefix}-${base}` : `${prefix}${base ? `-${base}` : ""}.bin`;
}

/** Writes a result's files into `folder` (a tree folder on this computer) and puts their tree paths in the result
 *  instead. The writes are part of the call that was approved, so they aren't judged again; the fence still applies. */
export async function saveFiles(holder: LocalHolder, result: McpResult, folder: string, callId: string, as: Caller): Promise<McpResult> {
  const out: McpContent[] = [];
  let i = 0;
  for (const c of result.content ?? []) {
    const file = c.type === "image" ? { data: (c as { data: string }).data, base64: true }
      : c.type === "resource" && (c as { resource: { blob?: string; text?: string } }).resource
        ? ((r) => (r.blob !== undefined ? { data: r.blob, base64: true } : r.text !== undefined ? { data: r.text, base64: false } : null))((c as { resource: { blob?: string; text?: string } }).resource)
        : null;
    if (!file) {
      out.push(c);
      continue;
    }
    const path = `${folder.replace(/\/+$/, "")}/${fileName(callId, i++, c)}`;
    await holder.write(path, file.base64 ? { encoding: "base64", data: file.data } : { encoding: "utf8", text: file.data }, { as, approved: true });
    out.push({ type: "text", text: `Saved ${c.type === "image" ? "an image" : "a file"} to ${path}` });
  }
  return { ...result, content: out };
}

export interface McpRouterOptions {
  tree: CoreTree;
  /** This computer's holder, where a call made here saves its files. */
  holder: LocalHolder;
  directory: TreeDirectory;
  transport: LinkTransport;
  deviceOf: (computer: string) => string | undefined;
  /** The servers and where they run, live (lanes B and D). */
  placement: (server: string) => McpServerPlacement | undefined;
  /** The fields the session's prompt gave a server's tools (`placementFields` at its last refresh). */
  fields: (server: string, session: string) => McpFields;
  /** This computer's MCP host. */
  call: McpCaller;
  /** A session's scratch folder, a tree folder on this computer (§6.4; lane D). */
  scratch: (session: string) => string;
  /** Shows the user another computer's card where its level needs their answer (R1). */
  /** This computer's fencing token, on every call it asks of another (`fencing.ts`). */
  fence?: ActFence;
  ask?: AnswerAsker;
}

export interface McpCallContext {
  session: string;
  as: Caller;
  callId: string;
  level?: Level;
  answer?: SignedCardAnswer;
  epoch?: number;
  signal?: AbortSignal;
}

/** Where each MCP call runs, and where its files land. */
export class McpRouter {
  readonly #o: McpRouterOptions;

  constructor(o: McpRouterOptions) {
    this.#o = o;
  }

  /** Runs `server`'s `tool` where it belongs; answers with the computer that ran it. */
  async run(server: string, tool: string, rawInput: Record<string, unknown>, ctx: McpCallContext): Promise<{ result: McpResult; computer: string }> {
    const placement = this.#o.placement(server);
    if (!placement) throw new ContractError("not_installed", `no MCP server ${server}`);
    const fields = this.#o.fields(server, ctx.session);
    const input = { ...rawInput };
    let target: string;
    let saveTo: string | undefined;
    const self = this.#o.directory.self();
    if (placement.kind === "local") {
      if (placement.computers.length === 0) throw new ContractError("not_installed", `${server} isn't installed on any computer`);
      if (fields.computer) {
        const named = input[fields.computer];
        delete input[fields.computer];
        if (typeof named !== "string" || named === "") throw new ContractError("invalid", `say which computer runs this in ${fields.computer}: ${placement.computers.join(", ")}`);
        const c = this.#o.directory.get(named);
        const name = c?.name ?? named;
        if (!placement.computers.includes(name)) throw new ContractError("invalid", `${server} isn't on ${named}; it is on ${placement.computers.join(", ")}`);
        target = name;
      } else {
        target = placement.computers[0]!;
      }
    } else {
      if (fields.saveTo) {
        const folder = input[fields.saveTo];
        delete input[fields.saveTo];
        if (folder !== undefined) {
          if (!isTreePath(folder)) throw new ContractError("invalid", `${fields.saveTo} is a folder in the tree (home/<Computer>/…)`);
          saveTo = folder.replace(/\/+$/, "");
        }
      }
      target = saveTo ? this.#o.tree.resolve(saveTo).computer : self;
    }
    const c = this.#o.directory.get(target);
    if (!c) throw new ContractError("not_found", `no computer ${target}`);
    if (!c.online) throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
    if (c.name === self) {
      const result = await this.#o.call({ server, tool, input, as: ctx.as, session: ctx.session, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      return { result: await saveFiles(this.#o.holder, result, saveTo ?? this.#o.scratch(ctx.session), ctx.callId, ctx.as), computer: c.name };
    }
    // Another computer: `tool.run`, at this computer's level for it; it saves the files on its own disk.
    const device = this.#o.deviceOf(c.name);
    if (!device) throw new ContractError("computer_offline", `${c.name} can't be reached`, { computer: c.name });
    const level = ctx.level ?? c.level;
    const carried = { ...input, ...(saveTo ? { saveTo } : {}) };
    try {
      const link = await this.#o.transport.connect(device);
      const r = await withAnswer(ctx.answer ? undefined : this.#o.ask, (answer) => link.request<{ output: McpResult; isError: boolean }>("tool.run", {
        session: ctx.session, callId: ctx.callId, epoch: ctx.epoch ?? 0, tool: mcpToolName(server, tool), input: carried, level, ...fenceParam(this.#o.fence),
        ...((answer ?? ctx.answer) ? { answer: answer ?? ctx.answer } : {}),
      }, { priority: "control" }));
      return { result: r.output, computer: c.name };
    } catch (e) {
      throw offlineAs(c.name, e);
    }
  }

  /** The holder's side of another computer's MCP call (`tool.run` with an `mcp__` tool, already judged): runs it on
   *  this computer's host and saves its files here, in `saveTo` or the session's scratch folder. */
  async serveHere(p: { tool: string; input: unknown; as: Caller; session: string; callId: string; signal: AbortSignal }): Promise<{ output: McpResult; isError: boolean }> {
    const name = parseMcpToolName(p.tool);
    if (!name) throw new ContractError("not_installed", `${p.tool} isn't an MCP tool`);
    const placement = this.#o.placement(name.server);
    const self = this.#o.directory.self();
    if (!placement || (placement.kind === "local" && !placement.computers.includes(self))) throw new ContractError("not_installed", `${name.server} isn't on ${self}`);
    const input = { ...((p.input ?? {}) as Record<string, unknown>) };
    const saveTo = typeof input.saveTo === "string" && placement.kind === "remote" ? input.saveTo : undefined;
    delete input.saveTo;
    if (saveTo && this.#o.tree.resolve(saveTo).computer !== self) throw new ContractError("invalid", `${saveTo} isn't on ${self}`);
    const result = await this.#o.call({ server: name.server, tool: name.tool, input, as: p.as, session: p.session, signal: p.signal });
    const saved = await saveFiles(this.#o.holder, result, saveTo ?? this.#o.scratch(p.session), p.callId, p.as);
    return { output: saved, isError: saved.isError === true };
  }
}

/** Installs a mirrored server here (lanes B and D: a `stdio` command's config, or ticking this computer for a
 *  plugin's server). */
export type McpInstaller = (server: string, config: unknown) => Promise<void>;

const MirrorParams = z.object({ server: z.string().min(1).max(256), config: z.unknown(), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional(), fence: FencingToken.optional() });

/** Mirror: another computer asks this one to install a server. It always takes the user's answer for this computer's
 *  own card, bound to the server and its config, whatever the levels: a server runs commands. */
export function serveMirror(o: { transport: LinkTransport; self: () => string; mayCall: (device: string) => boolean; install?: McpInstaller; answers?: Answers; clock: { now(): number }; fence?: ActFence }): Unsubscribe {
  return o.transport.handle("mcp.mirror", async (raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    const p = MirrorParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", `mcp.mirror: ${p.error.issues[0]?.message ?? "bad params"}`);
    checkActFence(o.fence, p.data.fence, "mcp.mirror");
    if (!o.install) throw new ContractError("not_installed", `${o.self()} can't install MCP servers yet`);
    const as: Caller = { kind: "peer", device: from, ...(p.data.session ? { sessionId: p.data.session } : {}) };
    await judgePeer({
      computer: o.self(), ownLevel: "ask", callLevel: p.data.level, effect: "execute",
      method: "mcp.mirror", params: { server: p.data.server, config: p.data.config ?? null }, as, now: o.clock.now(),
      ...(p.data.answer ? { answer: p.data.answer } : {}), ...(o.answers ? { answers: o.answers } : {}),
    });
    await o.install(p.data.server, p.data.config ?? null);
    return { ok: true };
  });
}

/** Presses Mirror: installs `server` (with `config`) on each of `computers`, asking the user for each computer's
 *  card. Answers which took it and why the others didn't. */
export async function mirror(o: {
  transport: LinkTransport;
  directory: TreeDirectory;
  deviceOf: (computer: string) => string | undefined;
  server: string;
  config: unknown;
  computers: readonly string[];
  session?: string;
  ask?: AnswerAsker;
  /** This computer's fencing token, on each computer's `mcp.mirror`. */
  fence?: ActFence;
}): Promise<{ installed: string[]; failed: { computer: string; code: string; message: string }[] }> {
  const installed: string[] = [];
  const failed: { computer: string; code: string; message: string }[] = [];
  for (const name of o.computers) {
    const c = o.directory.get(name);
    try {
      if (!c) throw new ContractError("not_found", `no computer ${name}`);
      if (!c.online) throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
      const device = o.deviceOf(c.name);
      if (!device) throw new ContractError("computer_offline", `${c.name} can't be reached`, { computer: c.name });
      const link = await o.transport.connect(device).catch((e) => { throw offlineAs(c.name, e); });
      await withAnswer(o.ask, (answer) => link.request("mcp.mirror", {
        server: o.server, config: o.config, level: c.level, ...fenceParam(o.fence),
        ...(o.session ? { session: o.session } : {}), ...(answer ? { answer } : {}),
      })).catch((e) => { throw offlineAs(c.name, e); });
      installed.push(c.name);
    } catch (e) {
      failed.push({ computer: c?.name ?? name, code: isContractError(e) ? e.code : "failed", message: (e as Error).message });
    }
  }
  return { installed, failed };
}
