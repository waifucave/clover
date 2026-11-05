# Spike S5: ACP support

Lane K, milestone M0. The question: can Clover's `Agent` tool drive coding agents over the Agent Client Protocol, and in particular, does Cursor's CLI accept the MCP servers Clover passes at `session/new`, and does Antigravity CLI speak ACP at all? The findings and the proposed spec edits are in [the report](../../docs/research/2026-11-05-s5-acp.md).

The prototype is `probe/`, a self-contained Bun package. It sits one level down because the root `spikes/*` workspace glob would otherwise pick it up. It has its own lockfile and changes nothing at the root.

## What is in it

| Part | File | What it does |
| :- | :- | :- |
| ACP client | `probe/src/acp/client.ts`, `transport.ts`, `client-host.ts` | The official SDK (`@agentclientprotocol/sdk` 2.4.0, protocol v1, the `/unstable` entrypoint), typed handlers, and a wire tap that logs every JSON-RPC message. Permission requests get an answer from a policy: allow once, but refuse the scripted step and anything that could reach a browser, the web or the screen. It never picks an "always" option. `fs/*` and `terminal/*` are served, confined to the session folder |
| MCP stub, stdio | `probe/src/mcp/stdio-stub.ts` | Started by the agent from the `session/new` entry. It logs every message, the environment names it got and a hash of the token passed in `env` |
| MCP stub, HTTP | `probe/src/mcp/http-stub.ts` | Streamable HTTP in the legacy era (`initialize`, `Mcp-Session-Id`, JSON responses). It logs every request and checks the `Authorization` header passed in `headers`. It answers MCP 2026-07-28's `server/discover` with the legacy fallback |
| Fake agent | `probe/src/fake-agent.ts` | A model-free ACP agent that does what Clover hopes a real one does. The self-test runs every check against it |
| Runner | `probe/src/run.ts` | One check per run, each with a deadline and a timeout on every call |
| Evidence | `probe/src/collect.ts`, `results/2026-11-05/` | Scrubbed copies of the real runs, the CLI help texts and the model-call ledger (below) |

The probe is POSIX-only: it contains agents with process groups and finds commands with `/bin/ps`. The self-test (5 tests) ran on macOS only.

How a check proves reach: each stub's tool result carries a nonce, and each server's instructions carry an instruction word. A reply that repeats a nonce means the tool result reached the model; one that repeats a word means the instructions did.

Safety, since the checks run on the owner's Mac:

* Every agent starts with a minimal environment and its own process group, and is stopped as a group.
* Its PATH starts with logging stand-ins for `open`, `xdg-open`, `osascript`, `afplay`, `say` and `terminal-notifier`, so nothing opens a window or plays sound. No run used them.
* Prompts need `--allow-model-calls`.
* Tokens are random per run and reach no log (`probe/src/util/log.ts`).

## Commands

Run all of these from `spikes/s5-acp/probe`. Run folders go to `$S5_RUNS`, or `$TMPDIR/clover-s5-acp` when it is unset. Each check prints a summary and writes `summary.json`, `acp.ndjson` (the wire), `events.ndjson` (`{event, data}` records) and the two stub logs into its run folder.

| Check | Command | Model call |
| :- | :- | :- |
| Install (local lockfile) | `bun install` | — |
| Typecheck | `bun run typecheck` | — |
| Self-test against the fake agent | `bun test` | — |
| `initialize` | `bun src/run.ts initialize --agent cursor` | no |
| `session/new` with both stubs; watches the stubs for 8 s | `bun src/run.ts session --agent cursor` | no |
| Prompt: both MCP tools, a file, two commands (one refused), the instruction words | `bun src/run.ts prompt --agent cursor --model 'default[]' --allow-model-calls` | 1 |
| `session/cancel` while a command runs | `bun src/run.ts cancel --agent cursor --model 'default[]' --allow-model-calls` | 1 |
| `session/load` in a new process, then one question from memory | `bun src/run.ts load --agent cursor --follow-up --allow-model-calls` | 1 |
| `session/load` replay only | `bun src/run.ts load --agent cursor` | no |
| `session/list` filtered to the work folder | `bun src/run.ts list --agent cursor` | no |
| The same for Antigravity CLI | `--agent agy`; for a prompt add `--model gemini-3.8-flash --effort low` | as above |
| agy with HTTP MCP advertised | `bun src/run.ts initialize --agent agy --agent-arg=--process-per-session` | no |
| `session/resume` (agy) | `bun src/run.ts load --agent agy --resume` | no |
| Collect evidence | `bun src/collect.ts "$S5_RUNS" ../results/<date> <run-folder>...` | — |

Other flags:

* `--no-mcp` passes no servers.
* `--raw` registers every handler as a raw fallback, so the SDK does no parsing.
* `--settle <s>` sets the wait after `session/new`.
* `--cancel-after <s>` sets the delay before the cancel.
* `--timeout <s>` sets the whole check's deadline.

## The evidence

`results/2026-11-05/` holds one folder per real run, made by `collect.ts` from the raw run folders:

* **Placeholders.** Every ACP session id, Antigravity conversation id, tool-call id and MCP session id is replaced by a stable placeholder across the whole set. `cursor-session-3` is the same session in every file, so a load run still points at its prompt run.
* **What is cut.** Antigravity names the account's plan under `_meta.antigravity.tier`; that object is dropped. Also cut:
  * the agent's slash-command list, which holds the owner's own skills;
  * the owner's sessions from other folders in `session/list` answers;
  * model lists past eight entries (the full list stays in `summary.json`);
  * the user's name, home and temp paths.
* **The audit.** `collect.ts` refuses to write a file that still holds a UUID, a raw tool-call id, the plan or a home path.
* **Not copied:** `events.ndjson`. It is derived from the wire, and in these runs its records were mislabelled: the event's own fields were overwritten by its data's `kind` and `ms`. `util/log.ts` now writes `{event, data}` with the log's own `ms` last. `acp.ndjson` and `summary.json` hold everything it did.
* **The ledger.** `model-calls.ndjson` is generated, not edited. It keeps the rows `run.ts` wrote for the real agents (`agent`, `check`, `kind`, `at`, and `model` when one was set), with `run` shortened to the folder name. The fake agent's rows are dropped; they are not model calls.
* **`cli-help/`** holds the `--help` and `--version` output behind the backends table in the report.
