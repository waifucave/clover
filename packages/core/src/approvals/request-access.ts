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
//   * Hosts: refused, with no card, while the runtime can't filter by host (agent SDK 0.0.76 refuses a domain list,
//     and the whole network is never given): the SDK request is in docs/research/. Every unix socket stays out of
//     reach either way: the sandbox denies the network (macOS `(deny network*)`, Linux a new network namespace and
//     `socket(AF_UNIX)` refused by seccomp), whatever folder is granted.
import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import type { Level, TurnOrigin } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { BotSessionContext } from "../bots/service";
import type { CoreToolDef } from "../runtime-sdk/turn-loop/servers";
import { resolveSessionPath } from "./bot-check";
import type { CloverApprovalRequest } from "./broker";
import type { PathClass } from "./ordinary-paths";
import type { SandboxGrants } from "./sandbox-grants";
import { plainOf, shownCode } from "./strings";
import { CONTROL } from "../fence/sandbox-settings";

export const REQUEST_ACCESS_TOOL = "RequestAccess";
/** What a network request is answered with while the runtime can't filter by host. */
export const NETWORK_UNSUPPORTED = "Shell commands can't reach the network yet: their sandbox has no way to let through only some hosts, and the whole network is never given to them. Use WebFetch or WebSearch to read the web, or ask the user to run the command.";

/** Whether `path` is a folder, or nothing yet (not a socket, a device, a file or a link to one). */
function folderOrNothing(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}
/** What a commit is told, in the description and in each refusal that names `.git`. */
export const GIT_IN_SANDBOX = "use git read commands here (status, log, diff); a commit, or anything else that writes .git, can't run in the sandbox and needs a command outside it, on its own card";

/** How far RequestAccess looks down a folder before its card: folders, and depth. */
const LOOK_DIRS_MAX = 5_000;
const LOOK_DEPTH_MAX = 8;
const LOOK_SKIPPED = new Set(["node_modules"]);

/** What a folder holds that the sandbox holds whatever is granted: its git repositories, apps and PATH folders,
 *  found by a bounded look down (`LOOK_DIRS_MAX` folders, `LOOK_DEPTH_MAX` deep); `complete` false past the bound. */
export function folderHolds(folder: string, pathFolders: readonly string[]): { repos: number; apps: number; pathFolders: number; complete: boolean } {
  let repos = 0, apps = 0, complete = true, left = LOOK_DIRS_MAX;
  const onPath = new Set(pathFolders);
  let paths = 0;
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name.toLowerCase() === ".git")) repos++;
    else if (entries.some((e) => e.name === "HEAD") && entries.some((e) => e.name === "objects") && entries.some((e) => e.name === "config")) { repos++; return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.toLowerCase() === ".git" || LOOK_SKIPPED.has(e.name)) continue;
      const at = join(dir, e.name);
      if (onPath.has(at)) paths++;
      if (e.name.toLowerCase().endsWith(".app")) { apps++; continue; }
      if (e.name.toLowerCase().endsWith(".git")) { repos++; continue; }
      if (--left < 0 || depth >= LOOK_DEPTH_MAX) { complete = false; continue; }
      walk(at, depth + 1);
    }
  };
  walk(folder, 0);
  return { repos, apps, pathFolders: paths, complete };
}

/** The card's line for what a folder holds, in plain words; undefined when it holds none of it. */
export function holdsLine(h: ReturnType<typeof folderHolds>): string | undefined {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (h.repos > 0) parts.push(n(h.repos, "git repository", "git repositories"));
  if (h.apps > 0) parts.push(n(h.apps, "app", "apps"));
  if (h.pathFolders > 0) parts.push(n(h.pathFolders, "folder of commands on your PATH", "folders of commands on your PATH"));
  if (!h.complete) {
    return `It holds more than Clover looked through (${LOOK_DIRS_MAX.toLocaleString("en-US")} folders${parts.length > 0 ? `; ${parts.join(", ")} so far` : ""}): `
      + "whatever git repositories, apps and folders of commands are in it, shell commands can't change them, or any editor or tool settings.";
  }
  if (parts.length === 0) return undefined;
  return `It holds ${parts.join(", ")}: shell commands can't change their .git, the apps or those folders, or any editor or tool settings in it.`;
}

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
  /** The folders on the user's PATH now (`pathFolders`): one, or a folder holding one at its top, is never granted. */
  pathFolders?: () => readonly string[];
  /** The Clover home: a folder holding it is never granted. */
  cloverHome?: string;
  /** The OS (default: this one's). Linux grants are refused (its sandbox holds only what exists when a command starts). */
  os?: "macos" | "linux" | "windows";
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Why a folder is never given to shell commands, before its class is asked: undefined when nothing here says so. */
function neverGiven(real: string, deps: RequestAccessDeps): string | undefined {
  const os = deps.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  if (os === "linux") return "On Linux the shell's sandbox holds only the places that exist when a command starts, so a .git or a hook made by a command wouldn't be held: shell commands get no folder beyond their level's here. Use Write or Edit, which ask when they need to.";
  if (CONTROL.test(real) || shownCode(real) !== real || plainOf(real) !== real) return `That folder's name has hidden or control characters, so it can't be shown on a card as it is: shell commands never get it.`;
  // macOS and Windows open a name in any case.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const inside = (a: string, root: string) => same(a, root) || a.toLowerCase().startsWith(root.toLowerCase().replace(/\/$/, "") + "/");
  const homes = [...new Set([deps.home, realOrSelf(deps.home)])];
  if (homes.flatMap((h) => [h, join(h, "Applications"), join(h, "Library")]).some((f) => same(real, f))) return `${real} is your home, your apps or your Library: shell commands never get write access to it.`;
  if (deps.cloverHome !== undefined && inside(deps.cloverHome, real)) return `${real} holds Clover's own folder: shell commands never get write access to it.`;
  for (const f of deps.pathFolders?.() ?? []) {
    if (same(f, real) || same(dirname(f), real)) return `${real} is, or holds at its top, a folder of commands on your PATH: shell commands never get write access to it.`;
  }
  return undefined;
}

function fail(text: string): { text: string; isError: true } {
  return { text, isError: true };
}

/** The tool for one bot session. */
export function requestAccessTool(deps: RequestAccessDeps, ctx: BotSessionContext, origin: () => TurnOrigin | undefined): CoreToolDef {
  return {
    name: REQUEST_ACCESS_TOOL,
    description: [
      "Ask the user to let your shell commands (Bash) write to a folder. Your commands run in a sandbox that limits the",
      "folders they write to and reaches no network. When one fails because it can't write somewhere (\"Operation not",
      "permitted\", \"Read-only file system\"), ask here with the folder and why. When it's granted your turn goes on at",
      "once with a note saying so: run the command again then. Sensitive folders (dot-folders, ~/Library, .git, folders on",
      "the PATH, outside the home) are never given to shell commands; use Write and Edit there, which ask when they need",
      "to. Inside any folder your commands write to, they never change a .git, an app, a folder of commands on the PATH or",
      `an editor's or tool's settings: ${GIT_IN_SANDBOX}.`,
      "Network access for shell commands isn't available yet: use WebFetch or WebSearch for the web.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "The folder your commands need to write to (absolute, or ~/...)." },
        network: { type: "array", items: { type: "string" }, description: "Host names your commands need to reach. Not available yet: asking says so." },
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
      // The runtime's sandbox has no per-host filter: a domain list is refused when it opens (agent SDK 0.0.76,
      // `resolveNetworkPosture`), and the only other posture is the whole network, which a shell command never gets. So
      // no host is granted until the SDK filters by host (docs/research/2026-11-11-…); nothing is asked of the user.
      if (hosts.length > 0) return fail(NETWORK_UNSUPPORTED);
      const shownWhy = plainOf(why).slice(0, WHY_MAX);
      const granted: string[] = [];
      const said: string[] = [];
      if (folder !== undefined) {
        const real = resolveSessionPath(folder, ctx.paths.scratch, deps.home);
        // A folder, or one not made yet: never a socket, a device or a file (`run/core.sock` is refused as Clover's own
        // anyway; a socket is never connected to from the sandbox, whose network is denied).
        if (!folderOrNothing(real)) return fail(`${real} isn't a folder: RequestAccess gives shell commands write access to a folder.`);
        const never = neverGiven(real, deps);
        if (never !== undefined) return fail(never);
        if (deps.writable?.(ctx, real) === true || deps.grants.has(ctx.sessionId, ctx.botId, real)) {
          said.push(`Your shell commands can already write to ${real}.`);
        } else if (deps.pathClass([real]) !== "ordinary") {
          return fail(`${real} is a sensitive place (a dot-folder, ~/Library, an app, a .git, a folder on the PATH, outside your home, or Clover's own): shell commands never get write access there. Use Write or Edit, which ask when they need to; for a repository, ${GIT_IN_SANDBOX}.`);
        } else {
          const level = deps.levelOf(ctx);
          // What it holds, looked down for before the card, so the user is told no less than the truth.
          const holds = holdsLine(folderHolds(real, deps.pathFolders?.() ?? []));
          const req: CloverApprovalRequest = {
            kind: "tool", session: ctx.sessionId, bot: ctx.botId, origin: origin() ?? "bot", computers: [ctx.computer],
            ...(level === undefined ? {} : { level }),
            // Judged as a delete is: a card at every level below automatic, never the reviewer; "always" is this bot's.
            effect: "delete", paths: [real], ruleKey: `access:write(${real})`,
            fields: {
              title: { type: "text", text: "Give shell commands write access" },
              what: { type: "code", code: plainOf(`${ctx.botId} wants write access to ${real} for shell commands`) },
              reason: { type: "code", code: shownWhy },
              ...(holds === undefined ? {} : { holds: { type: "text", text: holds } }),
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
      if (granted.length === 0) return { text: said.join(" "), isError: false };
      const what = granted.join(" and ");
      return {
        text: [`Granted: ${what}, for your shell commands in this conversation.`, ...said].join(" "),
        isError: false,
        endTurn: { note: `Clover granted your shell commands ${what}. Go on from where you were: run the command that needed it again. Inside it they still never change a .git: ${GIT_IN_SANDBOX}.` },
      };
    },
  };
}
