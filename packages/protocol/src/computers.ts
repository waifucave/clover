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
  AnyPluginId, BotId, ChangeResult, ComputerName, DeviceId, Empty, Level, Ok, Os, SecretStoreView, SessionId, Timestamp, TreePath,
} from "./common";
import { Card, SignedCardAnswer } from "./approvals";
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

/** A peer asks the receiver to change its own level (levels per computer, J-M2): a lowering applies; a raise needs the
 *  user's answer signed for the receiver's own card (`levelRaiseCall`), or it is refused with `NeedsAnswer`. */
const PeerSetLevel = z.strictObject({ level: Level, answer: SignedCardAnswer.optional() });

export const COMPUTERS_METHODS = {
  computerList: defineMethod({
    name: "computer.list", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read",
    params: Empty, result: z.object({ computers: z.array(ComputerView) }),
    doc: "Every computer: its folders' owner, OS, display, agents, level and state (§9.1).",
  }),
  /** Whether any computer-use session is driving this computer right now (§5.5's answer gate: a sealed button's
   *  click counts only while no computer-use action runs). User and app only: no plugin asks. */
  computerActing: defineMethod({
    name: "computer.acting", owner: "J", roles: ["app"], userOnly: true,
    params: Empty, result: z.object({ running: z.boolean(), session: SessionId.optional() }),
    doc: "Whether any computer-use session is acting on this computer now, with that session when one is.",  }),
  computerGet: defineMethod({
    name: "computer.get", owner: "J", roles: ["app", "cli", "remote", "layer"], capability: "computers.read",
    params: z.object({ name: ComputerName }), result: z.object({ computer: ComputerView }),
    doc: "One computer, by name or alias.",
  }),
  computerSetLevel: defineMethod({
    name: "computer.setLevel", owner: "J", roles: ["app", "cli", "remote", "peer"], userOnly: true, change: "sensitive",
    params: z.union([z.strictObject({ name: ComputerName, level: Level }), PeerSetLevel]),
    /** From a peer, only its own variant: `name` is refused (#179's review, S3). */
    peerParams: PeerSetLevel,
    result: z.union([ChangeResult, z.object({ applied: z.literal(true) })]),
    doc: "Changes a computer's approval level: a sealed card unless made in the user's own terminal (§5.5); from a peer, the receiver's own level.",
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
  // judges writes, removes, moves, new folders and links at the stricter of its own level and `level`, as `tool.run`
  // (review N2). At "ask for risky actions" the receiver runs its own safety reviewer on the change, as it does for
  // its own sessions (ruling R1): only what the reviewer judges risky, or can't judge, needs `answer`.
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
    params: z.object({ ...ViaPeer, path: TreePath, data: TreeData, createDirs: z.boolean().optional(), executable: z.boolean().optional() }), result: Ok,
    doc: "Writes a file on the computer that holds it, inside the fence; `executable` sets its mode (a new file keeps it off).",
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
    params: z.object({ ...ViaPeer, pattern: utf16(4096, 1), cwd: TreePath, glob: utf16(1024).optional(), ignoreCase: z.boolean().optional(), limit: z.number().int().min(1).max(100_000).optional() }),
    result: z.object({ matches: z.array(GrepMatch), truncated: z.boolean() }),
    doc: "Searches file contents on the computer that holds `cwd`.",
  }),
  treeMkdir: defineMethod({
    name: "tree.mkdir", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath }), result: Ok,
    doc: "Makes a folder, and any missing above it, inside the fence.",
  }),
  treeReadlink: defineMethod({
    name: "tree.readlink", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath }), result: z.object({ target: utf16(4096) }),
    doc: "A link's target, as written in the link.",
  }),
  treeSymlink: defineMethod({
    name: "tree.symlink", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath, target: utf16(4096, 1) }), result: Ok,
    doc: "Makes a link at `path`; the holder's fence judges the link and, when it is followed, where it leads.",
  }),
  treeWatch: defineMethod({
    name: "tree.watch", owner: "J", ...Files,
    params: z.object({ ...ViaPeer, path: TreePath }), result: z.object({ watchId: utf16(128, 1) }),
    doc: "Watches a folder (a code session's, never a whole home): its changes come as `tree_changed` with this id.",
  }),
  treeUnwatch: defineMethod({
    name: "tree.unwatch", owner: "J", ...Files,
    params: z.object({ watchId: utf16(128, 1) }), result: Ok,
    doc: "Ends a watch; only the computer that started it can end it.",
  }),
  toolRun: defineMethod({
    name: "tool.run", owner: "J", roles: ["peer"],
    params: z.object({
      session: SessionId, callId: utf16(128, 1), epoch: z.number().int().nonnegative(),
      tool: utf16(256, 1), input: z.unknown(),
      /** The calling computer's level for the call (the stricter of the computers it touches, §9.1). The receiver runs
       *  it at the stricter of this and its own level. At "ask for risky actions" the receiver's own reviewer judges
       *  it first (ruling R1); what the level would still ask about needs `answer`, a signed answer bound to this
       *  call, or the receiver shows its own card. */
      level: Level,
      answer: SignedCardAnswer.optional(),
    }),
    result: z.object({ output: z.unknown(), isError: z.boolean() }),
    doc: "Runs a tool call (Bash, a local MCP server's tool) on the computer that holds its folder; output streams as `tool_output`.",
  }),
  toolCancel: defineMethod({
    name: "tool.cancel", owner: "J", roles: ["peer"],
    params: z.object({ callId: utf16(128, 1), session: SessionId.optional() }), result: Ok,
    doc: "Cancels a running call; if the link is down, the holding computer stops it when the link returns (§6.4).",
  }),

  // The direct path between computers (J-M1's S1): the destination's holder takes the files straight from the source's
  // over one link stream. The caller asks `tree.receive` of the destination; the destination opens a `tree.send`
  // stream (priority `files`, meta `TreeSendMeta`) to the source, which sends the entries in order; once they are in
  // place the destination tells the source `tree.sent`, and a move's source removes what it sent. Each holder judges
  // the whole operation once, before anything lands (`tree.judge` asks first and spends no answer). One card names both
  // computers and the whole move or copy (ruling R15): its single signed answer binds the full description, each holder
  // checks it against its own rebuilt card, and a holder whose own rule is stricter (read-only) still refuses.
  treeJudge: defineMethod({
    name: "tree.judge", owner: "J", roles: ["peer"],
    params: z.object({ from: TreePath, to: TreePath, move: z.boolean(), role: z.enum(["source", "destination"]), session: SessionId.optional(), level: Level }),
    result: Ok,
    doc: "Whether this holder would take its part of a move or copy at this level; refused with `NeedsAnswer` when the user's answer would lift it.",
  }),
  treeReceive: defineMethod({
    name: "tree.receive", owner: "J", roles: ["peer"],
    params: z.object({
      from: TreePath, to: TreePath, move: z.boolean(), session: SessionId.optional(), level: Level,
      /** The one signed answer for the whole operation (R15): its card binds `tree.transfer` (`TreeTransferParams`, with
       *  `operation`, `from`, `to`, `source` and `destination`), and each holder checks it against its own card. */
      answer: SignedCardAnswer.optional(),
    }),
    result: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), kept: z.number().int().nonnegative() }),
    doc: "Makes this computer the destination of a move or copy from another: it takes the files over `tree.send` and renames them into place, never over something there. `kept`: a move's entries that changed at the source meanwhile, and stay there too.",
  }),
  treeSent: defineMethod({
    name: "tree.sent", owner: "J", roles: ["peer"],
    params: z.object({ sendId: utf16(128, 1) }), result: z.object({ kept: z.number().int().nonnegative() }),
    doc: "The destination has the files in place: a move's source removes what it sent, keeping what changed meanwhile.",
  }),

  // Holds on another computer's screen live on that computer (J-M1 review minor 4): its registry decides, with its own
  // user-working marks, and a dropped link lets go of every hold the other computer took there.
  computerTakeHold: defineMethod({
    name: "computer.takeHold", owner: "J", roles: ["peer"],
    params: z.object({ target: HoldTarget, pluginId: AnyPluginId, session: SessionId.optional() }), result: z.object({ hold: HoldView }),
    doc: "Takes a hold on the receiver's own screen, for the calling computer's session.",
  }),
  computerReleaseHold: defineMethod({
    name: "computer.releaseHold", owner: "J", roles: ["peer"],
    params: z.object({ id: utf16(128, 1) }), result: Ok,
    doc: "Lets go of a hold the calling computer took here.",
  }),
  computerReleaseSession: defineMethod({
    name: "computer.releaseSession", owner: "J", roles: ["peer"],
    params: z.object({ session: SessionId }), result: z.object({ released: z.number().int().nonnegative() }),
    doc: "Lets go of every hold the calling computer took here for one session, at its turn's end.",
  }),
  computerHolds: defineMethod({
    name: "computer.holds", owner: "J", roles: ["peer"],
    params: Empty, result: z.object({ holds: z.array(HoldView), userWorking: z.boolean() }),
    doc: "The receiver's holds and whether the user is working there.",
  }),

  // MCP across computers (J-M2): a tool call on another computer is `tool.run` with `mcp__<server>__<tool>`, judged there
  // (R1); `mcp.mirror` installs a server there.
  mcpMirror: defineMethod({
    name: "mcp.mirror", owner: "J", roles: ["peer"],
    params: z.object({ server: utf16(256, 1), config: z.unknown(), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional() }),
    result: Ok,
    doc: "Installs an MCP server on the receiver: always the user's answer for its own card, bound to the server and its config, whatever the levels, since a server runs commands.",
  }),

  // Terminals (lane F's request; lane J's PTY): the user's own terminals in the panel. A layer needs `terminal`, which
  // only the bundled `clover` tree holds (review T1; the SDK's `mayHoldCapability`), and whose OK says it runs commands
  // on the user's computers. What a `write` carries is what lane E's runtime derived from trusted input events in the
  // terminal panel (a key press's bytes; a paste through the paste door, which brackets it and asks before one of more
  // than one line): the daemon can't check that, which is why no other plugin may hold `terminal`.
  terminalOpen: defineMethod({
    name: "terminal.open", owner: "J", roles: ["app", "layer", "peer"], capability: "terminal",
    params: z.union([
      z.object({
        computer: ComputerName,
        /** A folder in the tree on that computer; its home folder when left out. */
        cwd: TreePath.optional(),
        /** The session it belongs to, which shows it in its panel. */
        session: SessionId.optional(),
        cols: z.number().int().min(2).max(1000),
        rows: z.number().int().min(1).max(1000),
      }),
      /** A peer opens one on the receiver, fenced at `cwd` and judged as `tool.run` is: an interactive shell has
       *  nothing for a reviewer to read, so below `automatic` it takes the user's answer bound to `terminal.open`
       *  with its folder (R1). */
      z.object({
        cwd: TreePath,
        cols: z.number().int().min(2).max(1000),
        rows: z.number().int().min(1).max(1000),
        session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional(),
      }),
    ]),
    result: z.object({ terminalId: TerminalId }),
    doc: "Opens a terminal on a computer, in the user's shell; its output streams as `terminal_output`. A computer at read-only never opens one for a plugin (`refused`).",
  }),
  terminalWrite: defineMethod({
    name: "terminal.write", owner: "J", roles: ["app", "layer", "peer"], capability: "terminal",
    params: z.object({
      terminalId: TerminalId,
      data: utf16(TERMINAL_WRITE_MAX),
      /** A paste, whole, through the paste door: already bracketed (`ESC[200~` … `ESC[201~`) when the program turned
       *  bracketed paste on, and confirmed by the user when it holds more than one line. */
      paste: z.boolean().optional(),
      /** A peer's call: the session the terminal was opened for. */
      session: SessionId.optional(),
    }),
    result: Ok,
    doc: "What lane E's runtime derived from the user's key presses or a paste in the terminal panel.",
  }),
  terminalResize: defineMethod({
    name: "terminal.resize", owner: "J", roles: ["app", "layer", "peer"], capability: "terminal",
    params: z.object({ terminalId: TerminalId, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000), session: SessionId.optional() }),
    result: Ok,
    doc: "The terminal's new size in cells.",
  }),
  terminalClose: defineMethod({
    name: "terminal.close", owner: "J", roles: ["app", "layer", "peer"], capability: "terminal",
    params: z.object({ terminalId: TerminalId, session: SessionId.optional() }), result: Ok,
    doc: "Ends the terminal's shell and closes it.",
  }),
} as const;

export const ComputerChangedEvent = coreEvent("computer_changed", { computer: ComputerView });
export const ComputerRemovedEvent = coreEvent("computer_removed", { name: ComputerName });
export const HoldsChangedEvent = coreEvent("holds_changed", { computer: ComputerName, holds: z.array(HoldView), userWorking: z.boolean() });
export const ActionRunningEvent = coreEvent("action_running", { computer: ComputerName, running: z.boolean() });
export const ToolOutputEvent = coreEvent("tool_output", { callId: utf16(128, 1), session: SessionId.optional(), chunk: utf16(1_000_000), stream: z.enum(["stdout", "stderr"]) });

/** What a refusal carries when the user's answer would lift it (ruling R1): the holder's own card for the call, for the
 *  calling computer to show on any of the user's devices; the signed answer then travels with the call again. In a
 *  JSON-RPC error's `data.detail`, with `data.code` `refused`. */
export const NeedsAnswer = z.object({
  needsAnswer: z.literal(true),
  computer: ComputerName,
  method: utf16(128, 1),
  card: Card.pick({ kind: true, change: true, binds: true, fields: true, options: true, children: true }).optional(),
});
export type NeedsAnswer = z.infer<typeof NeedsAnswer>;

/** A `tree.send` stream's meta (the direct path): what the source is to send, and the operation's one answer. */
export const TreeSendMeta = z.object({ from: TreePath, to: TreePath, move: z.boolean(), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional() });
export type TreeSendMeta = z.infer<typeof TreeSendMeta>;
export const TreeChangedEvent = coreEvent("tree_changed", {
  watchId: utf16(128, 1),
  /** The tree paths that changed, coalesced. */
  paths: z.array(TreePath).max(10_000).optional(),
  /** The holder's watch dropped and came back: list the folder again. */
  resync: z.boolean().optional(),
});
/** Where a computer's part of the tree lives (lane J's `TreeRoots`). */
export const TreeRoots = z.object({
  home: utf16(4096, 1),
  botsRoot: utf16(4096, 1).optional(),
  os: Os,
  /** The bots this computer runs, whose `bots/<bot>/` lives here. */
  bots: z.array(BotId).max(1024).optional(),
});
export const ComputerHelloEvent = coreEvent("computer_hello", {
  name: ComputerName,
  os: Os,
  hasDisplay: z.boolean(),
  agents: z.array(utf16(128)).max(64),
  level: Level,
  tree: TreeRoots,
});
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
  treeChanged: defineEvent({
    type: "tree_changed", owner: "J", roles: ["peer"], schema: TreeChangedEvent, transient: true,
    fixture: { type: "tree_changed", ts: 1781270000000, watchId: "w_1", paths: ["home/Studio/project/a.ts"] },
    doc: "A watched folder's changes, from the computer that holds it to the one that watches (`tree.watch`).",
  }),
  computerHello: defineEvent({
    type: "computer_hello", owner: "J", roles: ["peer"], schema: ComputerHelloEvent,
    fixture: { type: "computer_hello", ts: 1781270000000, name: "Studio", os: "macos", hasDisplay: true, agents: ["claude-code"], level: "ask-risky", tree: { home: "/Users/me", botsRoot: "/Users/me/.clover/bots", os: "macos", bots: ["alpha"] } },
    doc: "A computer introduces itself to a peer when a link opens and when it changes: its name, level, agents and where its part of the tree lives.",
  }),
  terminalOutput: defineEvent({
    type: "terminal_output", owner: "J", roles: ["app", "layer", "peer"], capability: "terminal", schema: TerminalOutputEvent, transient: true,
    fixture: { type: "terminal_output", ts: 1781270000000, terminalId: "term_1", data: "$ " },
    doc: "A terminal's output; `exited` once its shell ends.",
  }),
} as const;
