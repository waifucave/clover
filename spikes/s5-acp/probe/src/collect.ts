#!/usr/bin/env bun
// Copies run folders into spikes/s5-acp/results/<date>/ as committed evidence, scrubbed for a
// public repo:
//   * every ACP session id, Antigravity conversation id, live tool-call id and MCP session id
//     becomes a stable placeholder across the whole set (cursor-session-3 is the same session in
//     every file), so a load still points back at its prompt run. Cursor's load replay renames
//     its tool calls replay-0-N; those are Cursor's own ids and are kept;
//   * an object under a `tier` key (Antigravity names the account's plan there) is dropped;
//   * the agent's slash-command list (it holds the owner's own skills), other folders'
//     sessions from session/list, and long model lists are cut;
//   * the user's name, home and temp paths are replaced.
// Tokens never reached the run folders (util/log.ts). events.ndjson is not copied: it is
// derived, and in these runs its labels were overwritten by the data (see the README).
// The model-call ledger is generated from the raw one, keeping the fields run.ts wrote.
//
//   bun src/collect.ts <runsDir> <outDir> <runName>...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";

const [runsDir, outDir, ...runs] = process.argv.slice(2);
if (!runsDir || !outDir || !runs.length) {
  console.error("usage: bun src/collect.ts <runsDir> <outDir> <runName>...");
  process.exit(2);
}
const RUNS = resolve(runsDir);
const OUT = resolve(outDir);
const PROBE = resolve(import.meta.dir, "..");
const user = userInfo().username;
const FILES = ["summary.json", "acp.ndjson", "mcp-stdio.ndjson", "mcp-http.ndjson"] as const;
const agentOf = (run: string) => run.split("-").slice(-2, -1)[0]!; // 2026-…-<agent>-<check>

// Cutting what is private or long (applied as each acp.ndjson is loaded).
const KEEP = 8;
const trimList = (xs: any[]) => (xs.length > KEEP + 2 ? [...xs.slice(0, KEEP), `…${xs.length - KEEP} more (full list in summary.json)`] : xs);

function trimAcp(msg: any, workDir: string): any {
  const u = msg?.params?.update;
  if (u?.sessionUpdate === "available_commands_update") {
    return { ...msg, params: { ...msg.params, update: { sessionUpdate: u.sessionUpdate, availableCommands: `<${u.availableCommands?.length ?? 0} commands omitted: they include the owner's own skills>` } } };
  }
  const r = msg?.result;
  if (r && Array.isArray(r.sessions)) {
    const mine = r.sessions.filter((s: any) => s.cwd === workDir);
    return { ...msg, result: { ...r, sessions: mine, _omitted: `${r.sessions.length - mine.length} sessions from other folders (the owner's)` } };
  }
  const out = structuredClone(msg);
  for (const holder of [out?.result, out?.params?.update]) {
    if (!holder) continue;
    if (holder.models?.availableModels) holder.models.availableModels = trimList(holder.models.availableModels);
    if (holder.configOptions) holder.configOptions = holder.configOptions.map((o: any) => (Array.isArray(o.options) ? { ...o, options: trimList(o.options) } : o));
  }
  return out;
}

// 1. Load every file of every run, in time order.
type Loaded = { run: string; file: string; ndjson: boolean; data: any };
const loaded: Loaded[] = [];
for (const run of [...runs].sort()) {
  for (const file of FILES) {
    const p = join(RUNS, run, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const ndjson = file.endsWith(".ndjson");
    let data = ndjson ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(text);
    // Cut before collecting ids, so sessions from other folders never get a placeholder.
    if (file === "acp.ndjson") data = data.map((rec: any) => ({ ...rec, msg: trimAcp(rec.msg, join(RUNS, "work", agentOf(run))) }));
    loaded.push({ run, file, ndjson, data });
  }
}

// 2. Collect the ids, in order of first appearance.
function walk(v: any, visit: (key: string, value: any) => void) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      visit(k, x);
      walk(x, visit);
    }
}
const ids = new Map<string, string>(); // original → placeholder
const counters = new Map<string, number>();
function assign(original: string, kind: string) {
  if (ids.has(original)) return;
  const n = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, n);
  ids.set(original, `${kind}-${n}`);
}
for (const { run, data } of loaded) {
  const agent = agentOf(run);
  walk(data, (k, v) => {
    if (typeof v !== "string") return;
    if (k === "sessionId" || k === "lastSessionId") assign(v, `${agent}-session`);
    else if (k === "antigravity.google/conversation_id" || k === "antigravity.google/root_conversation_id") assign(v, "agy-conversation");
    else if (k === "toolCallId" && !v.startsWith("replay-")) assign(v, `${agent}-call`);
    else if (k === "mcp-session-id") assign(v, "mcp-session");
  });
}
const byLength = [...ids.keys()].sort((a, b) => b.length - a.length);

// 3. Transform: drop the tier, replace ids inside every string, scrub paths.
function scrubString(s: string): string {
  for (const original of byLength) if (s.includes(original)) s = s.split(original).join(ids.get(original)!);
  return s
    .split(RUNS).join("$RUNS")
    .split(PROBE).join("$PROBE")
    .split(homedir()).join("~")
    .replace(/\/private\/tmp\/claude-\d+\/[^"\s]*?\/scratchpad/g, "$SCRATCH")
    .replace(/\/(private\/)?var\/folders\/[^/"\s]+\/[^/"\s]+\/T/g, "$TMPDIR")
    .split(user).join("<user>");
}

function clean(v: any, key?: string): any {
  if (key === "tier" && v && typeof v === "object") return "<omitted: it names the account's plan>";
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map((x) => clean(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubString(k), clean(x, k)]));
  return v;
}

// 4. Audit, then write. Nothing is written if a raw id, the plan or a private path survives.
const LEAKS: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "a UUID"],
  [/\bcall_\d{6,}\b/, "an Antigravity tool-call id"],
  [/\bfc_[0-9a-f-]{8,}/, "a Cursor tool-call id"],
  [new RegExp(user), "the user's name"],
  [/\/Users\//, "a home path"],
];
const outputs: { path: string; text: string }[] = [];
for (const { run, file, ndjson, data } of loaded) {
  const cleaned = ndjson ? data.map((rec: any) => clean(rec)) : clean(data);
  const text = ndjson ? cleaned.map((r: any) => JSON.stringify(r)).join("\n") + "\n" : JSON.stringify(cleaned, null, 2) + "\n";
  let planLeft = false; // the plan sits in an object under a `tier` key; a boolean `tier` capability is fine
  walk(cleaned, (k, v) => {
    if (k === "tier" && v && typeof v === "object") planLeft = true;
  });
  if (planLeft) {
    console.error(`refusing to write ${run}/${file}: it still holds the account's plan`);
    process.exit(1);
  }
  for (const [re, what] of LEAKS) {
    const m = text.match(re);
    if (m) {
      console.error(`refusing to write ${run}/${file}: it still holds ${what} (${m[0].slice(0, 12)}…)`);
      process.exit(1);
    }
  }
  outputs.push({ path: join(OUT, run, file), text });
}
for (const { path, text } of outputs) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// 5. The ledger, generated: the real agents' rows for these runs, as run.ts wrote them.
const ledgerIn = join(RUNS, "model-calls.ndjson");
if (existsSync(ledgerIn)) {
  const rows = readFileSync(ledgerIn, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.agent !== "fake" && runs.includes(basename(r.run)))
    .map((r) => ({ ...r, run: basename(r.run) }));
  writeFileSync(join(OUT, "model-calls.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

console.log(`collected ${runs.length} runs, ${outputs.length} files; ${ids.size} ids replaced (${[...counters].map(([k, n]) => `${k} ${n}`).join(", ")})`);
