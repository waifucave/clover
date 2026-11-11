// `RequestAccess`, the core tool a bot asks with when its sandboxed shell commands need more than its level gives
// (§9.1, stage 2; the controller's ruling, option A): a folder to write to, or hosts to reach. The runtime takes a
// sandbox only when it opens, so a grant ends the runtime's turn once this call's result is in, and the driver goes
// on at once in a new one under the wider sandbox (`CoreToolResult.endTurn`), inside the same turn of the user's.
// Never `allowUnsandboxedCommands`: what is granted is a root of the same sandbox.
//
//   * A folder: an ordinary folder of the user's (R1's class: `pathClass`) gets a card "<bot> wants write access to
//     <folder> for shell commands", at every level below automatic and never the reviewer (it is judged as a delete is:
//     a card, its "always" a rule of that bot's), and the fence's rule 3 asks first for what it fences. Anything else
//     (a dot-folder, ~/Library, a `.git`, a folder on the PATH, outside the home, the Clover home) is refused with no
//     card: the file tools reach those, and ask.
//   * Hosts: exact names, never a pattern or an address; the safety reviewer judges them, then a card when it isn't
//     sure, with no "always". They hold for the conversation.
import type { Level, TurnOrigin } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { BotSessionContext } from "../bots/service";
import type { CoreToolDef } from "../runtime-sdk/turn-loop/servers";
import { resolveSessionPath } from "./bot-check";
import type { CloverApprovalRequest } from "./broker";
import type { PathClass } from "./ordinary-paths";
import type { SandboxGrants } from "./sandbox-grants";
import { plainOf } from "./strings";

export const REQUEST_ACCESS_TOOL = "RequestAccess";
/** The most hosts one request names. */
export const REQUEST_ACCESS_HOSTS_MAX = 10;
const WHY_MAX = 500;

/** A host name as a request may give it: letters, digits and hyphens in dot-separated labels, at least two labels,
 *  a last label that isn't all digits; no scheme, port, path, `*`, address or `localhost`. */
export function validHost(raw: string): string | undefined {
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0 || h.length > 253) return undefined;
  const labels = h.split(".");
  if (labels.length < 2) return undefined;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return undefined;
  return h;
}

export interface RequestAccessDeps {
  broker: Pick<ApprovalBroker, "request">;
  grants: SandboxGrants;
  /** R1's class of a folder on this computer (`pathsClassOnDisk` with the PATH's folders). */
  pathClass: (paths: readonly string[]) => PathClass;
  /** The home `~` stands for. */
  home: string;
  /** The session's level now: a routine's, else its computer's. */
  levelOf: (ctx: BotSessionContext) => Level | undefined;
  /** Whether the session's shell commands may already write `folder` (its level's sandbox: the home at accept edits). */
  writable?: (ctx: BotSessionContext, folder: string) => boolean;
}

function fail(text: string): { text: string; isError: true } {
  return { text, isError: true };
}

/** The tool for one bot session. */
export function requestAccessTool(deps: RequestAccessDeps, ctx: BotSessionContext, origin: () => TurnOrigin | undefined): CoreToolDef {
  return {
    name: REQUEST_ACCESS_TOOL,
    description: [
      "Ask the user to let your shell commands (Bash) write to a folder or reach hosts on the network. Your commands",
      "run in a sandbox that limits the folders they write to and reaches no network. When one fails",
      "for that (\"Operation not permitted\", \"Read-only file system\", a host it can't reach), ask here with the",
      "folder or the hosts and why. When it's granted your turn goes on at once with a note saying so: run the command",
      "again then. Sensitive folders (dot-folders, ~/Library, .git, folders on the PATH, outside the home) are never",
      "given to shell commands; use Write and Edit there, which ask when they need to.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "The folder your commands need to write to (absolute, or ~/...)." },
        network: { type: "array", items: { type: "string" }, description: "The host names your commands need to reach (exact names: no *, no scheme or port)." },
        why: { type: "string", description: "Why, in one sentence the user reads on the card." },
      },
      required: ["why"],
      additionalProperties: false,
    },
    run: async (input) => {
      const i = (input ?? {}) as { folder?: unknown; network?: unknown; why?: unknown };
      const why = typeof i.why === "string" ? i.why.trim() : "";
      if (why === "") return fail("RequestAccess needs `why`: one sentence the user reads on the card.");
      const folder = typeof i.folder === "string" && i.folder.trim() !== "" ? i.folder.trim() : undefined;
      const network = Array.isArray(i.network) ? i.network : i.network === undefined ? [] : undefined;
      if (network === undefined) return fail("`network` is a list of host names.");
      if (folder === undefined && network.length === 0) return fail("RequestAccess needs a `folder` or `network` hosts.");
      if (network.length > REQUEST_ACCESS_HOSTS_MAX) return fail(`At most ${REQUEST_ACCESS_HOSTS_MAX} hosts at once.`);
      const hosts: string[] = [];
      for (const h of network) {
        const ok = typeof h === "string" ? validHost(h) : undefined;
        if (ok === undefined) return fail(`${JSON.stringify(h)} isn't a host name RequestAccess takes: an exact name such as api.example.com, never a pattern (*), an address, a port or a path.`);
        if (!hosts.includes(ok)) hosts.push(ok);
      }
      const shownWhy = plainOf(why).slice(0, WHY_MAX);
      const granted: string[] = [];
      const said: string[] = [];
      if (folder !== undefined) {
        const real = resolveSessionPath(folder, ctx.paths.scratch, deps.home);
        if (deps.writable?.(ctx, real) === true || deps.grants.has(ctx.sessionId, ctx.botId, real)) {
          said.push(`Your shell commands can already write to ${real}.`);
        } else if (deps.pathClass([real]) !== "ordinary") {
          return fail(`${real} is a sensitive place (a dot-folder, ~/Library, an app, a .git, a folder on the PATH, outside your home, or Clover's own): shell commands never get write access there. Use Write or Edit, which ask when they need to.`);
        } else {
          const level = deps.levelOf(ctx);
          const req: CloverApprovalRequest = {
            kind: "tool", session: ctx.sessionId, bot: ctx.botId, origin: origin() ?? "bot", computers: [ctx.computer],
            ...(level === undefined ? {} : { level }),
            // Judged as a delete is: a card at every level below automatic, never the reviewer; "always" is this bot's.
            effect: "delete", paths: [real], ruleKey: `access:write(${real})`,
            fields: {
              title: { type: "text", text: "Give shell commands write access" },
              what: { type: "code", code: plainOf(`${ctx.botId} wants write access to ${real} for shell commands`) },
              reason: { type: "code", code: shownWhy },
              paths: { type: "code", code: plainOf(real) },
              computer: { type: "code", code: plainOf(ctx.computer) },
            },
          };
          const d = await deps.broker.request(req);
          if (!d.allowed) return fail(`Write access to ${real} wasn't given (${d.by === "card" ? "the user declined it" : d.by === "fence" ? "that place is fenced on this computer" : d.by === "level" ? "this computer's level doesn't allow it" : "no one answered in time"}).`);
          deps.grants.grantFolder(ctx.sessionId, ctx.botId, real, d.remembered === true || d.by === "rule");
          granted.push(`write access to ${real}`);
        }
      }
      const newHosts = hosts.filter((h) => !deps.grants.hosts(ctx.sessionId).includes(h));
      if (hosts.length > 0 && newHosts.length === 0) said.push(`Your shell commands can already reach ${hosts.join(", ")}.`);
      if (newHosts.length > 0) {
        const level = deps.levelOf(ctx);
        const req: CloverApprovalRequest = {
          kind: "tool", session: ctx.sessionId, bot: ctx.botId, origin: origin() ?? "bot", computers: [ctx.computer],
          ...(level === undefined ? {} : { level }),
          // A fetch the reviewer judges, then a card; no "always" (no rule key).
          effect: "fetch",
          fields: {
            title: { type: "text", text: "Give shell commands network access" },
            what: { type: "code", code: plainOf(`${ctx.botId} wants its shell commands to reach ${newHosts.join(", ")}`) },
            host: { type: "code", code: newHosts.join("\n") },
            reason: { type: "code", code: shownWhy },
            computer: { type: "code", code: plainOf(ctx.computer) },
          },
        };
        const d = await deps.broker.request(req);
        if (!d.allowed) {
          const text = `Network access to ${newHosts.join(", ")} wasn't given (${d.by === "card" ? "the user declined it" : d.by === "level" ? "this computer's level doesn't allow it" : "no one answered in time"}).`;
          if (granted.length === 0) return fail(text);
          said.push(text);
        } else {
          deps.grants.grantHosts(ctx.sessionId, newHosts);
          granted.push(`network access to ${newHosts.join(", ")}`);
        }
      }
      if (granted.length === 0) return { text: said.join(" "), isError: false };
      const what = granted.join(" and ");
      return {
        text: [`Granted: ${what}, for your shell commands in this conversation.`, ...said].join(" "),
        isError: false,
        endTurn: { note: `Clover granted your shell commands ${what}. Go on from where you were: run the command that needed it again.` },
      };
    },
  };
}
