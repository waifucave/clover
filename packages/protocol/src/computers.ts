// Clover protocol area: computers and the folder tree (spec §9.1, §9.2). Owner: lane J (the computer registry, the
// tree, MCP tools across computers, cloud computers). Pinned by lane B at M0; spike S6 (mounts) is still running,
// so the tree's peer methods are the operations the `Tree` contract names, nothing about mounts.
//
// A computer is a device running clover-core. The bot sees one folder tree, `home/<Computer>/` per computer and
// `bots/<bot>/` for each bot; a call runs on the computer that holds its files, and a computer that is off answers
// "computer offline" at once. Holds, the user-working mark and `computers.control` are kept for opensky (§4, §9.2).
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, ChangeResult, ComputerName, DeviceId, Empty, Level, Ok, Os, SecretStoreView, SessionId, Timestamp, TreePath,
} from "./common";
import { SignedCardAnswer } from "./approvals";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

export const ComputerState = z.enum(["online", "offline", "asleep"]);

export const ComputerView = z.object({
  name: ComputerName,
  /** Old names, kept after a rename (§9.1). */
  aliases: z.array(ComputerName).max(32),
  device: DeviceId,
  os: Os,
  hasDisplay: z.boolean(),
  /** Installed ACP agents, by `agentBackends` id (§9.1, §9.3). */
  agents: z.array(utf16(128)).max(64),
  level: Level,
  state: ComputerState,
  /** How this computer reaches it. */
  link: z.enum(["self", "lan", "direct", "relay"]).optional(),
  isMain: z.boolean(),
  /** Where it keeps its secrets, for Settings: a headless one may show the plaintext label (§8.5). */
  secrets: SecretStoreView.optional(),
  /** A cloud computer's VM (§9.2); its state lives in the registry, not in the plugin folder. */
  cloud: z.object({
    plugin: AnyPluginId,
    provider: utf16(128),
    size: utf16(128),
    region: utf16(128),
    vm: z.enum(["creating", "running", "resizing", "stopped", "deleting", "failed"]),
  }).optional(),
});
export type ComputerView = z.infer<typeof ComputerView>;

/** What a hold covers: a whole app, or one window of it (§9.2, the inherited held apps). */
export const HoldTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app"), app: utf16(256, 1) }),
  z.object({ kind: z.literal("window"), app: utf16(256, 1), window: utf16(512, 1) }),
]);
export type HoldTarget = z.infer<typeof HoldTarget>;

export const HoldView = z.object({
  id: utf16(128, 1),
  computer: ComputerName,
  target: HoldTarget,
  /** The session acting, and the plugin that took the hold for it. */
  session: SessionId.optional(),
  pluginId: AnyPluginId,
  since: Timestamp,
});
export type HoldView = z.infer<typeof HoldView>;

/** One of Clover's own windows on a computer, which a computer-use plugin must not act on (§5.5). */
export const CloverWindow = z.object({
  id: utf16(128),
  x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative(),
  display: utf16(128).optional(),
});
export type CloverWindow = z.infer<typeof CloverWindow>;

export const FileStat = z.object({
  path: TreePath,
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  modifiedAt: Timestamp,
  executable: z.boolean(),
});
export type FileStat = z.infer<typeof FileStat>;

export const GrepMatch = z.object({ path: TreePath, line: z.number().int().positive(), text: utf16(4000) });

/** Encodings a tree read or write carries. Bytes travel base64 on JSON-RPC; large files move on a link stream. */
export const TreeData = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("utf8"), text: z.string() }),
  z.object({ encoding: z.literal("base64"), data: z.string() }),
]);

const Files = { roles: ["peer", "layer"] as const, capability: "files" };
export const TerminalId = utf16(128, 1).regex(/^[A-Za-z0-9._:-]+$/);
/** The most one `terminal.write` carries, in UTF-16 code units; a longer paste goes in pieces. */
export const TERMINAL_WRITE_MAX = 1_000_000;
/** What a peer's tree call carries (review N2), as `tool.run` does: the calling session, the calling computer's level
 *  for it, and a signed answer bound to this call where the stricter level asks. A layer's call leaves them out; a
 *  receiver refuses a peer's write, remove or move that leaves out `level` (`invalid`). */
const ViaPeer = {
  session: SessionId.optional(),
  level: Level.optional(),
  answer: SignedCardAnswer.optional(),
};

export const COMPUTERS_METHODS = {
  computerList: defineMethod({
    name: "computer.list", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read",
    params: Empty, result: z.object({ computers: z.array(ComputerView) }),
    doc: "Every computer: its folders' owner, OS, display, agents, level and state (§9.1).",
  }),
  computerGet: defineMethod({
    name: "computer.get", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read",
    params: z.object({ name: ComputerName }), result: z.object({ computer: ComputerView }),
    doc: "One computer, by name or alias.",
  }),
  computerSetLevel: defineMethod({
    name: "computer.setLevel", owner: "J", roles: ["app", "cli", "remote"], userOnly: true, change: "sensitive",
    params: z.object({ name: ComputerName, level: Level }), result: ChangeResult,
    doc: "Changes a computer's approval level: a sealed card unless made in the user's own terminal (§5.5).",
  }),
  computerRename: defineMethod({
    name: "computer.rename", owner: "J", roles: ["app", "cli"], userOnly: true, change: "core",
    params: z.object({ name: ComputerName, to: ComputerName }), result: ChangeResult,
    doc: "Renames a computer in the tree; the old name stays as an alias.",
  }),
  holdList: defineMethod({
    name: "hold.list", owner: "J", roles: ["app", "layer"], capability: "computers.control",
    params: z.object({ computer: ComputerName }), result: z.object({ holds: z.array(HoldView), userWorking: z.boolean() }),
    doc: "A computer's holds and its user-working mark.",
  }),
  // A computer-use plugin's own calls (taking and releasing holds, the user-working mark, a running action, where
  // Clover's windows are) are plugin-API calls (`computers.takeHold`, `computers.releaseHold`,
  // `computers.setUserWorking`, `computers.setActionRunning`, `computers.cloverWindows`), made through
  // `pluginHost.api` with the plugin id the host stamps (review S3). Their shapes are `HoldTarget`, `HoldView` and
  // `CloverWindow` above.

  // The folder tree. Between computers (`peer`), and for plugins with `files`, inside the fence (§5.4, §9.1). The owner
  // decided there are no OS mounts: the holder's daemon serves the tree over the link, so this is the main path. A
  // peer's call carries `ViaPeer`: the receiver fences it as that session (`Caller` kind `peer`, never the user) and
  // judges writes, removes and moves at the stricter of its own level and `level`, as `tool.run` (review N2).
  treeStat: defineMethod({
    name: "tree.stat", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath }), result: z.object({ stat: FileStat.nullable() }),
    doc: "A path's type, size and time; null when it doesn't exist.",
  }),
  treeRead: defineMethod({
    name: "tree.read", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath, offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().max(16 * 1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional() }),
    result: TreeData,
    doc: "Reads a file on the computer that holds it.",
  }),
  treeWrite: defineMethod({
    name: "tree.write", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath, data: TreeData, createDirs: z.boolean().optional() }), result: Ok,
    doc: "Writes a file on the computer that holds it, inside the fence.",
  }),
  treeList: defineMethod({
    name: "tree.list", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath }), result: z.object({ entries: z.array(FileStat) }),
    doc: "A folder's entries.",
  }),
  treeRemove: defineMethod({
    name: "tree.remove", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath, recursive: z.boolean().optional() }), result: Ok,
    doc: "Deletes a file or folder.",
  }),
  treeMove: defineMethod({
    name: "tree.move", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, from: TreePath, to: TreePath }), result: Ok,
    doc: "Moves within one computer; across computers the core copies, then deletes.",
  }),
  treeGlob: defineMethod({
    name: "tree.glob", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, pattern: utf16(1024, 1), cwd: TreePath, limit: z.number().int().min(1).max(100_000).optional() }),
    result: z.object({ paths: z.array(TreePath), truncated: z.boolean() }),
    doc: "Finds files on the computer that holds `cwd`; only the results travel (§9.1).",
  }),
  treeGrep: defineMethod({
    name: "tree.grep", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, pattern: utf16(4096, 1), cwd: TreePath, glob: utf16(1024).optional(), limit: z.number().int().min(1).max(100_000).optional() }),
    result: z.object({ matches: z.array(GrepMatch), truncated: z.boolean() }),
    doc: "Searches file contents on the computer that holds `cwd`.",
  }),
  toolRun: defineMethod({
    name: "tool.run", owner: "J", roles: ["peer"],
    params: z.object({
      session: SessionId, callId: utf16(128, 1), epoch: z.number().int().nonnegative(),
      tool: utf16(256, 1), input: z.unknown(),
      /** The calling computer's level for the call (the stricter of the computers it touches, §9.1). The receiver runs
       *  it at the stricter of this and its own level; what that level would ask about needs `answer`, a signed answer
       *  bound to this call, or the receiver shows its own card. */
      level: Level,
      answer: SignedCardAnswer.optional(),
    }),
    result: z.object({ output: z.unknown(), isError: z.boolean() }),
    doc: "Runs a tool call (Bash, a local MCP server's tool) on the computer that holds its folder; output streams as `tool_output`.",
  }),
  toolCancel: defineMethod({
    name: "tool.cancel", owner: "J", roles: ["peer"],
    params: z.object({ callId: utf16(128, 1) }), result: Ok,
    doc: "Cancels a running call; if the link is down, the holding computer stops it when the link returns (§6.4).",
  }),

  // Terminals (lane F's request; lane J's PTY): the user's own terminals in the panel. A layer needs `terminal`, which
  // only the bundled `clover` tree holds (review T1; the SDK's `mayHoldCapability`), and whose OK says it runs commands
  // on the user's computers. What a `write` carries is what lane E's runtime derived from trusted input events in the
  // terminal panel (a key press's bytes; a paste through the paste door, which brackets it and asks before one of more
  // than one line): the daemon can't check that, which is why no other plugin may hold `terminal`.
  terminalOpen: defineMethod({
    name: "terminal.open", owner: "J", roles: ["app", "layer"], capability: "terminal",
    params: z.object({
      computer: ComputerName,
      /** A folder in the tree on that computer; its home folder when left out. */
      cwd: TreePath.optional(),
      /** The session it belongs to, which shows it in its panel. */
      session: SessionId.optional(),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(1).max(1000),
    }),
    result: z.object({ terminalId: TerminalId }),
    doc: "Opens a terminal on a computer, in the user's shell; its output streams as `terminal_output`. A computer at read-only never opens one for a plugin (`refused`).",
  }),
  terminalWrite: defineMethod({
    name: "terminal.write", owner: "J", roles: ["app", "layer"], capability: "terminal",
    params: z.object({
      terminalId: TerminalId,
      data: utf16(TERMINAL_WRITE_MAX),
      /** A paste, whole, through the paste door: already bracketed (`ESC[200~` … `ESC[201~`) when the program turned
       *  bracketed paste on, and confirmed by the user when it holds more than one line. */
      paste: z.boolean().optional(),
    }),
    result: Ok,
    doc: "What lane E's runtime derived from the user's key presses or a paste in the terminal panel.",
  }),
  terminalResize: defineMethod({
    name: "terminal.resize", owner: "J", roles: ["app", "layer"], capability: "terminal",
    params: z.object({ terminalId: TerminalId, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000) }),
    result: Ok,
    doc: "The terminal's new size in cells.",
  }),
  terminalClose: defineMethod({
    name: "terminal.close", owner: "J", roles: ["app", "layer"], capability: "terminal",
    params: z.object({ terminalId: TerminalId }), result: Ok,
    doc: "Ends the terminal's shell and closes it.",
  }),
} as const;

export const ComputerChangedEvent = coreEvent("computer_changed", { computer: ComputerView });
export const ComputerRemovedEvent = coreEvent("computer_removed", { name: ComputerName });
export const HoldsChangedEvent = coreEvent("holds_changed", { computer: ComputerName, holds: z.array(HoldView), userWorking: z.boolean() });
export const ActionRunningEvent = coreEvent("action_running", { computer: ComputerName, running: z.boolean() });
export const ToolOutputEvent = coreEvent("tool_output", { callId: utf16(128, 1), chunk: utf16(1_000_000), stream: z.enum(["stdout", "stderr"]) });
export const TerminalOutputEvent = coreEvent("terminal_output", { terminalId: TerminalId, data: utf16(1_000_000), exited: z.object({ code: z.number().int().nullable() }).optional() });

export const COMPUTERS_EVENTS = {
  computerChanged: defineEvent({
    type: "computer_changed", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read", schema: ComputerChangedEvent,
    fixture: { type: "computer_changed", ts: 1781270000000, computer: { name: "Desktop1", aliases: ["Gaming-PC"], device: "d1sk7t0p3a5b7c9d1e3f5a7b9c1d3e5f", os: "windows", hasDisplay: true, agents: ["claude-code", "codex"], level: "ask-risky", state: "online", link: "lan", isMain: false, secrets: { backend: "encrypted-file", keySource: "credential-manager", plaintext: false, state: "unlocked" } } },
    doc: "A computer was added or changed state, level or name.",
  }),
  computerRemoved: defineEvent({
    type: "computer_removed", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read", schema: ComputerRemovedEvent,
    fixture: { type: "computer_removed", ts: 1781270000000, name: "Desktop1" },
    doc: "A computer left the tree.",
  }),
  holdsChanged: defineEvent({
    type: "holds_changed", owner: "J", roles: ["app", "layer"], capability: "computers.control", schema: HoldsChangedEvent,
    fixture: { type: "holds_changed", ts: 1781270000000, computer: "Studio", holds: [{ id: "h_1", computer: "Studio", target: { kind: "window", app: "com.apple.Safari", window: "Checkout" }, session: "s_alpha", pluginId: "opensky", since: 1781269990000 }], userWorking: false },
    doc: "A computer's holds or user-working mark changed.",
  }),
  actionRunning: defineEvent({
    type: "action_running", owner: "J", roles: ["app"], schema: ActionRunningEvent,
    fixture: { type: "action_running", ts: 1781270000000, computer: "Studio", running: true },
    doc: "A computer-use action started or ended on a computer; the app counts no card click meanwhile.",
  }),
  toolOutput: defineEvent({
    type: "tool_output", owner: "J", roles: ["peer"], schema: ToolOutputEvent, transient: true,
    fixture: { type: "tool_output", ts: 1781270000000, callId: "call_1", chunk: "On branch main\n", stream: "stdout" },
    doc: "A running `tool.run` call's output, back to the computer running the session.",
  }),
  terminalOutput: defineEvent({
    type: "terminal_output", owner: "J", roles: ["app", "layer"], capability: "terminal", schema: TerminalOutputEvent, transient: true,
    fixture: { type: "terminal_output", ts: 1781270000000, terminalId: "term_1", data: "$ " },
    doc: "A terminal's output; `exited` once its shell ends.",
  }),
} as const;
