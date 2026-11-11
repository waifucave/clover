import type { AgentLive } from "./context";
import { useState, type ReactNode } from "react";
import { clip, hostOf } from "./format";
import { S } from "./strings";
import { splitPluginTool } from "./tool-phrases";
import type { ToolCall } from "./types";

/** How a call's result reads: never a JSON dump for a tool whose shape is known. `ToolResult` returns `null` when the
 *  plain text block is the right answer (a plain-text result of an unknown tool), and a drawn view otherwise. */

/** One diff line as the runtime reports it. */
export interface DiffLine {
  type: "add" | "remove" | "context";
  oldLine?: number;
  newLine?: number;
  content: string;
}

/** The most lines of a diff or list one result draws. */
export const MAX_RESULT_LINES = 40;
/** Context lines kept either side of a change in a long diff. */
const CONTEXT = 2;

function tryParse(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Diff lines out of a parsed result, or, when the core cut the JSON short, out of whatever objects survived. */
export function diffLinesOf(output: string): DiffLine[] | undefined {
  const parsed = tryParse(output);
  const raw: unknown[] | undefined =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { diff?: unknown }).diff) ? (parsed as { diff: unknown[] }).diff : undefined;
  if (raw) return raw.flatMap((r) => toLine(r) ?? []);
  if (!output.includes('"diff"')) return undefined;
  // Truncated: take each complete `{"type":…}` object after the `"diff"` key.
  const at = output.indexOf('"diff"');
  const found: DiffLine[] = [];
  for (const m of output.slice(at).matchAll(/\{"type":"(?:add|remove|context)"[^{}]*?"content":"(?:[^"\\]|\\.)*"\}/g)) {
    try {
      const l = toLine(JSON.parse(m[0]));
      if (l) found.push(l);
    } catch {
      /* a cut object: skip */
    }
  }
  return found.length > 0 ? found : undefined;
}

function toLine(r: unknown): DiffLine | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const type = o.type === "add" || o.type === "remove" || o.type === "context" ? o.type : undefined;
  if (!type || typeof o.content !== "string") return undefined;
  return {
    type,
    content: o.content,
    ...(typeof o.oldLineNumber === "number" ? { oldLine: o.oldLineNumber } : {}),
    ...(typeof o.newLineNumber === "number" ? { newLine: o.newLineNumber } : {}),
  };
}

/** Keep the changes and a little context; a gap marker where lines are left out. */
export function trimDiff(lines: readonly DiffLine[]): (DiffLine | { gap: number })[] {
  const keep = lines.map((l, i) => l.type !== "context" || lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((n) => n.type !== "context"));
  const out: (DiffLine | { gap: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap > 0) out.push({ gap });
      gap = 0;
      out.push(l);
    } else gap += 1;
  });
  if (gap > 0) out.push({ gap });
  return out;
}

/** "created" or "edited", read from the result's own `type`. */
export function writeVerb(output: string | undefined): "created" | "edited" {
  const parsed = output ? tryParse(output) : undefined;
  return parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "create" ? "created" : "edited";
}

export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function DiffView({ lines, path }: { lines: DiffLine[]; path?: string }) {
  const rows = trimDiff(lines);
  const shown = rows.slice(0, MAX_RESULT_LINES);
  const more = rows.length - shown.length;
  return (
    <div className="cl-conv-result cl-conv-result--diff" data-result="diff">
      {path && <div className="cl-conv-result__path" title={path}>{shortPath(path)}</div>}
      <ol className="cl-conv-difflines">
        {shown.map((r, i) =>
          "gap" in r ? (
            <li key={i} className="cl-conv-difflines__gap">{S.resultGap(r.gap)}</li>
          ) : (
            <li key={i} className="cl-conv-difflines__line" data-line={r.type}>
              <span className="cl-conv-difflines__no">{r.type === "remove" ? r.oldLine : r.newLine}</span>
              <span className="cl-conv-difflines__sign" aria-hidden="true">{r.type === "add" ? "+" : r.type === "remove" ? "−" : " "}</span>
              <span className="cl-conv-difflines__text">{r.content === "" ? " " : r.content}</span>
            </li>
          ),
        )}
      </ol>
      {more > 0 && <div className="cl-conv-result__more">{S.toolMoreLines(more)}</div>}
    </div>
  );
}

/** Bash's text: the runtime marks `[stderr]`, `[exit N]` and `[sandbox: …]` on their own lines. */
export function splitBash(output: string): { stdout: string; stderr: string; exit?: number; notes: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const notes: string[] = [];
  let exit: number | undefined;
  let into = stdout;
  for (const line of output.split("\n")) {
    const code = /^\[exit (-?\d+)\]$/.exec(line);
    if (code) {
      exit = Number(code[1]);
      continue;
    }
    if (line === "[stderr]") {
      into = stderr;
      continue;
    }
    if (/^\[sandbox: .*\]$/.test(line)) {
      notes.push(line.slice(1, -1));
      continue;
    }
    if (line === "(no stdout)") continue;
    into.push(line);
  }
  const trim = (l: string[]) => l.join("\n").replace(/^\n+|\n+$/g, "");
  return { stdout: trim(stdout), stderr: trim(stderr), ...(exit === undefined ? {} : { exit }), notes };
}

const TAIL = 12;
function tail(text: string): { text: string; cut: number } {
  const lines = text.split("\n");
  return lines.length > TAIL ? { text: lines.slice(-TAIL).join("\n"), cut: lines.length - TAIL } : { text, cut: 0 };
}

function BashView({ call }: { call: ToolCall }) {
  const r = splitBash(call.output ?? "");
  const out = tail(r.stdout);
  const err = tail(r.stderr);
  const failed = call.status === "failed" || (r.exit !== undefined && r.exit !== 0);
  return (
    <div className="cl-conv-result cl-conv-result--shell" data-result="bash" data-error={failed || undefined}>
      {out.text && (
        <pre className="cl-conv-result__stream" data-stream="stdout">
          {out.cut > 0 && <span className="cl-conv-result__cut">{S.resultEarlier(out.cut)}{"\n"}</span>}
          {out.text}
        </pre>
      )}
      {err.text && (
        <pre className="cl-conv-result__stream" data-stream="stderr">
          {err.cut > 0 && <span className="cl-conv-result__cut">{S.resultEarlier(err.cut)}{"\n"}</span>}
          {err.text}
        </pre>
      )}
      {!out.text && !err.text && <div className="cl-conv-result__quiet">{S.toolNoOutput}</div>}
      <div className="cl-conv-result__status" data-state={failed ? "failed" : "ok"}>
        {r.exit === undefined ? (failed ? S.toolFailed : S.toolSucceeded) : S.resultExit(r.exit)}
        {r.notes.map((n) => <span key={n} className="cl-conv-result__note">{n}</span>)}
      </div>
    </div>
  );
}

function Lines({ lines, kind }: { lines: string[]; kind: string }) {
  const shown = lines.slice(0, MAX_RESULT_LINES);
  return (
    <div className="cl-conv-result cl-conv-result--list" data-result={kind}>
      <ul className="cl-conv-hits">
        {shown.map((l, i) => <li key={i} className="cl-conv-hits__hit">{l}</li>)}
      </ul>
      {lines.length > shown.length && <div className="cl-conv-result__more">{S.toolMoreLines(lines.length - shown.length)}</div>}
    </div>
  );
}

/** A value as a short, plain string (objects as a count, never a dump). */
function plain(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return clip(v, 240);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "none" : v.every((x) => typeof x === "string" || typeof x === "number") ? clip(v.join(", "), 240) : S.resultItems(v.length);
  return S.resultFields(Object.keys(v as object).length);
}

/** An unknown tool's JSON: a tidy key/value list, with the raw text one click away. */
function KeyValueView({ data, raw }: { data: unknown; raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const entries: [string, unknown][] = Array.isArray(data) ? data.map((v, i) => [String(i + 1), v]) : Object.entries(data as object);
  return (
    <div className="cl-conv-result cl-conv-result--kv" data-result="kv">
      {showRaw ? (
        <pre className="cl-conv-result__raw">{clip(raw, 4000)}</pre>
      ) : (
        <dl className="cl-conv-kv">
          {entries.slice(0, 16).map(([k, v]) => (
            <div key={k} className="cl-conv-kv__row">
              <dt className="cl-conv-kv__key">{k}</dt>
              <dd className="cl-conv-kv__value">{plain(v)}</dd>
            </div>
          ))}
          {entries.length > 16 && <div className="cl-conv-result__more">{S.toolMore(entries.length - 16)}</div>}
        </dl>
      )}
      <button type="button" className="cl-conv-result__toggle" aria-pressed={showRaw} onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? S.resultTidy : S.resultRaw}
      </button>
    </div>
  );
}

function str(o: unknown, ...keys: string[]): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function SearchChips({ call, data }: { call: ToolCall; data: unknown }) {
  const items = (Array.isArray(data) ? data : Array.isArray((data as { results?: unknown })?.results) ? (data as { results: unknown[] }).results : []) as unknown[];
  const chips = items.flatMap((i) => {
    const url = str(i, "url", "link");
    return url ? [{ url, title: str(i, "title", "name") ?? hostOf(url) }] : [];
  });
  void call;
  const all = chips;
  if (all.length === 0) return null;
  return (
    <ul className="cl-conv-chips" data-result="search">
      {all.slice(0, 12).map((c) => (
        <li key={c.url} className="cl-conv-chips__chip" title={c.url}>
          <span className="cl-conv-chips__title">{clip(c.title, 60)}</span>
          <span className="cl-conv-chips__host">{hostOf(c.url)}</span>
        </li>
      ))}
    </ul>
  );
}

function ReadView({ call }: { call: ToolCall }) {
  const text = call.output ?? "";
  const parsed = tryParse(text);
  const file = parsed && typeof parsed === "object" ? (parsed as { file?: Record<string, unknown> }).file : undefined;
  const body = typeof file?.content === "string" ? file.content : text;
  const count = body === "" ? 0 : body.split("\n").length;
  const start = typeof file?.startLine === "number" ? file.startLine : 1;
  const path = str(file, "filePath") ?? call.detail;
  return (
    <div className="cl-conv-result cl-conv-result--read" data-result="read">
      {path && <div className="cl-conv-result__path" title={path}>{shortPath(path)}</div>}
      <div className="cl-conv-result__range">{count === 0 ? S.toolNoOutput : S.resultRange(start, start + count - 1)}</div>
    </div>
  );
}

function FetchView({ call, data }: { call: ToolCall; data: unknown }) {
  const url = str(data, "url") ?? call.detail;
  const title = str(data, "title") ?? (url ? hostOf(url) : "");
  return (
    <div className="cl-conv-result cl-conv-result--fetch" data-result="fetch">
      <div className="cl-conv-result__title">{clip(title, 100)}</div>
      {url && <div className="cl-conv-result__host" title={url}>{hostOf(url)}</div>}
    </div>
  );
}

function AgentView({ call, data, agents }: { call: ToolCall; data: unknown; agents?: readonly AgentLive[] }) {
  const who = str(data, "agent", "agentType", "subagent_type", "description") ?? call.detail ?? "agent";
  const live = [...(agents ?? [])].reverse().find((a) => a.name === who);
  const state = live
    ? (S.agentStatus[live.status] ?? live.status)
    : call.status === "failed" ? S.toolFailed : call.status === "succeeded" ? S.toolSucceeded : call.status === "running" ? S.toolRunning : S.toolWaiting;
  return (
    <div className="cl-conv-result cl-conv-result--agent" data-result="agent" data-state={live?.status ?? call.status}>
      <span className="cl-conv-result__title">{clip(who, 80)}</span>
      {live?.backend && <span className="cl-conv-result__host">{live.backend}</span>}
      <span className="cl-conv-result__state">{state}</span>
      {live?.line && <span className="cl-conv-result__line">{live.line}</span>}
    </div>
  );
}

function SearchOrRaw({ call, data, output }: { call: ToolCall; data: unknown; output: string }) {
  return SearchChips({ call, data }) ?? (data !== undefined && typeof data === "object" && data !== null ? <KeyValueView data={data} raw={output} /> : null);
}

/** The drawn result of a call, or `null` when the standard plain block should draw. */
export function ToolResult({ call, agents }: { call: ToolCall; agents?: readonly AgentLive[] }): ReactNode {
  const output = call.output;
  const plugin = splitPluginTool(call.name);
  const tool = (plugin ? plugin.tool : call.name).replace(/^mcp__[^_]+__/, "");
  // An agent that has just started has no output yet, but it has a name and a status to show.
  if (output === undefined) return (tool === "Agent" || tool === "Task") && agents && agents.length > 0 ? <AgentView call={call} data={undefined} agents={agents} /> : null;
  const data = tryParse(output);
  switch (tool) {
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const lines = diffLinesOf(output);
      if (lines) return <DiffView lines={lines} path={str(data, "filePath", "file_path", "notebook_path") ?? call.diff?.path ?? call.detail} />;
      return data ? <div className="cl-conv-result cl-conv-result--quiet" data-result="write"><span className="cl-conv-result__title">{writeVerb(output) === "created" ? S.resultCreated : S.resultEdited}</span>{call.detail ? <span className="cl-conv-result__host">{shortPath(call.detail)}</span> : null}</div> : null;
    }
    case "Bash":
    case "BashOutput":
      return <BashView call={call} />;
    case "Read":
      return <ReadView call={call} />;
    case "Grep":
    case "Glob": {
      if (data !== undefined) return <KeyValueView data={data} raw={output} />;
      const lines = output.split("\n").filter((l) => l.trim() !== "");
      return lines.length === 0 ? null : <Lines lines={lines} kind={tool.toLowerCase()} />;
    }
    case "WebSearch":
      return SearchOrRaw({ call, data, output });
    case "WebFetch":
      return <FetchView call={call} data={data} />;
    case "Agent":
    case "Task":
      return <AgentView call={call} data={data} agents={agents} />;
    default: {
      if (data !== undefined && typeof data === "object" && data !== null) return <KeyValueView data={data} raw={output} />;
      // A plugin tool that answers with one short plain sentence is drawn as that sentence on a small card, not a code block.
      const line = plugin ? output.trim() : "";
      if (line !== "" && line.length <= 160 && !line.includes("\n")) {
        return <div className="cl-conv-result cl-conv-result--line" data-result="line" data-state={call.status}>{line}</div>;
      }
      return null;
    }
  }
}
