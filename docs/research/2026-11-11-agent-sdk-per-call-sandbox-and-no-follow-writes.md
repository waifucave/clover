# Agent SDK requests: a per-call sandbox overlay, no-follow file writes, and the ACP path keys

Lane C, stage 2 of "bots ask less" (§9.1). Three asks of the agent SDK (`@waifucave/clover-agent-sdk`, 0.0.76 at
the time of writing), why Clover needs each, and what Clover does until then.

## 1. A sandbox overlay on one call

**The ask.** Let a `canUseTool` allow, or a `PreToolUse` answer, carry a sandbox overlay for the one spawn it
allows: extra `filesystem.allowWrite` roots and extra `network.allowedDomains`, added to the session's sandbox for
that command only (never `allowUnsandboxedCommands`, never fewer denies). Shape, for example:

```ts
{ behavior: "allow", updatedInput, sandboxOverlay: { allowWrite: ["/Users/k/Documents"], allowedDomains: ["registry.npmjs.org"] } }
```

The overlay's roots go through the same real-path and deny handling as the session's own roots; a deny still wins.

**Why.** `Options.sandbox` is read only when the runtime opens (measured: no per-call or live update). A bot's
shell commands run in a sandbox drawn from the fence at its level: at "ask for risky actions" they write only to
its own folders and the temp folder and reach no network. When the user grants a folder or a host, the only way to
widen the sandbox today is to end the runtime's turn, reopen the runtime under the new settings, and start a new
turn. That costs a reopen, splits one piece of work into two runtime turns, and makes the grant hold for the whole
conversation, when the user agreed to one command.

**And a host filter.** Today `sandbox.network.allowedDomains` is refused when the runtime opens
(`resolveNetworkPosture`: "Seatbelt filters by socket class, not hostname, and Winter has no filtering proxy yet").
The only other posture is the whole network. That also opens every unix socket, including `core.sock`, the plugin
host's, the SSH agent's and Docker's, so a shell command is never given it. The ask is a filtering proxy that lets
named hosts through while unix sockets stay denied (macOS `(deny network*)` with an outbound allow to the proxy
only; Linux keeps `--unshare-net` and the seccomp `socket(AF_UNIX)` refusal).

**The interim (built).** `RequestAccess` is a Clover core tool. A folder gets a card. A network request is refused
with no card and nothing granted, until the host filter exists. A folder grant joins the conversation's sandbox
(`SandboxGrants` → `botSandboxSettings`, which never carries a `network` key). The tool's result carries
`endTurn`, the driver's PostToolUse hook answers `continue: false` (measured: the runtime ends the turn with
`terminal_reason: "hook_stopped"` right after that round, with no model request between), and the driver goes on at
once in a new runtime turn led by a short note ("Clover granted your shell commands …; run the command again"). The
runtime reopens because the host's sandbox changed. This happens inside the same host turn: no new turn for the
observers, so the fetch budget doesn't refill, and no plugin turn hooks run. There are at most four continuations
per host turn. Measured with the runtime's test model: the note reaches the model folded after the tool result,
the same way a mid-turn message is folded.

## 2. No-follow writes in the file tools

**The ask.** In `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, open the target with `O_NOFOLLOW` on its last name,
and walk the folders above it with `openat` from a descriptor of the folder the host checked (or refuse a path whose
real path differs from the one checked). Alternatively, let the host hand the tool an already-resolved real path
that the tool won't follow links past.

**Why.** Clover checks a file tool's path at `PreToolUse`, with links followed (`resolveSessionPath`). The tool then
writes later and follows links when it writes. With stage 2, a bot's sandboxed shell can create links inside its
write roots. A background command (a `Bash` in the background, a `Monitor`) can therefore swap a checked file for a
link to `~/.zshrc` between the check and the write: a TOCTOU race. `~/.ssh` and the run-later places are refused by
the fence whatever the card, but the race reaches anything the link can point at.

**The interim (built, the controller's ruling).** While the conversation has a background command or monitor
running, a file tool's write inside the shell's write roots is not contained. That includes the bot's own folders,
whose writes otherwise run outright. It goes to the reviewer, then a card (`liveShell`/`shellRoots`, `notContained`).
The driver reports the live count (`observe.tasks`). This narrows the window to commands the user approved; it
doesn't close it.

## 3. The ACP listing's path keys

**The ask.** In the ACP listing (`pathsOf` in `@waifucave/clover-agent-sdk/acp`), also read the keys a move, a rename
or a delete names its files under: `source`, `src`, `from`, `old_path`, `oldPath`, `new_path`, `newPath`,
`destination`, `dest`, `to`, `paths` (an array), `files` (an array), `file`. Better still, expose whether the listing
is complete for the call.

**Why.** Today `pathsOf` reads `locations`, a diff's `path`, and the input keys `path`, `Path`, `file_path`,
`filePath`, `target`, `TargetFile`, `AbsolutePath`, `notebook_path`, `directory`, `cwd` and `Cwd`. An agent's
`mv ~/.ssh/id_rsa ~/Projects/x` reported as `{ source, target }` is listed as `~/Projects/x` alone. The fence's
rule 3 and the manager's Clover-home check then judge only the destination.

**The interim (built).** An agent's move or delete whose input names a file under any key the listing doesn't read
(`namesUnlistedPaths`: by the key's name, by the value's shape, or anything past four levels deep) is unresolved: a
card every time, ahead of rule 3 and the level, saying why. A move is never contained either way.
