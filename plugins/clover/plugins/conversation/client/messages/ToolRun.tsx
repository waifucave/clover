import { useId, type ReactNode } from "react";
import type { MessageContext, MessageSpotProps } from "../context";
import { clip, firstLine, hostOf } from "../format";
import { IconChevron, IconFileText, IconGlobe, IconPencil, IconSparkles, IconTerminal, IconWrench } from "../icons";
import { StatusGlyph } from "../parts";
import { Link } from "../Link";
import { safeAsset } from "../links";
import { AppView } from "../sdk";
import { S } from "../strings";
import { ToolResult, shortPath, writeVerb } from "../result";
import { isOwnTool, runStatus, sharedComputer, splitPluginTool, titleFor, toolSentence, toolWords } from "../tool-phrases";
import type { ToolCall, ToolRunItem } from "../types";

/** Bounds on what one output block DRAWS (the core already capped what it stores). */
export const MAX_OUTPUT_LINES = 16;
export const MAX_OUTPUT_CHARACTERS = 4000;
/** The longest failure line a collapsed run shows. */
export const MAX_FAILURE_SUMMARY = 140;

const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

/** The `tool` key's props: the spot's `{ bot, session, item, ctx }`, where `item` is the run, plus the
 *  view's own open state. */
export interface ToolRunProps extends MessageSpotProps<ToolRunItem> {
  expanded: boolean;
  onToggle: () => void;
  /** The `tool.result` spot (keyed by tool name): a replacement for one call's result, or `undefined` to draw the
   *  default, which it is handed (`standard`) to fall back on. */
  renderResult?: (call: ToolCall, standard: ReactNode) => ReactNode | undefined;
}

export function outputPreview(output: string): { text: string; moreLines: number; cut: boolean } {
  const lines = output.split("\n");
  const moreLines = Math.max(0, lines.length - MAX_OUTPUT_LINES);
  let text = moreLines > 0 ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : output;
  const cut = text.length > MAX_OUTPUT_CHARACTERS;
  if (cut) text = text.slice(0, MAX_OUTPUT_CHARACTERS);
  return { text, moreLines, cut };
}

/** The tool as a theme can name it in CSS: `data-tool="write"`, `"bash"`, `"websearch"`; a plugin's tool by its own name.
 *  A run of one kind carries that kind (Write, Edit and the like read as `write`), a mixed run `"mixed"`. */
export function toolKind(name: string): string {
  const plugin = splitPluginTool(name);
  return (plugin ? plugin.tool : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tool";
}
function runKind(calls: readonly ToolCall[]): string {
  // Edits of files read as one kind: a Write and an Edit in a run are file work.
  const kinds = new Set(calls.map((c) => { const k = toolKind(c.name); return k === "edit" || k === "multiedit" || k === "notebookedit" ? "write" : k; }));
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
}

/** The run's kind as one icon, for a theme that shows the run as a card (`.cl-conv-tools__icon`, hidden in the stock look). */
function kindIcon(kind: string): { name: string; glyph: ReactNode } {
  if (kind === "write") return { name: "edit", glyph: <IconPencil /> };
  if (kind === "bash") return { name: "terminal", glyph: <IconTerminal /> };
  if (kind === "websearch" || kind === "webfetch" || kind === "browser") return { name: "web", glyph: <IconGlobe /> };
  if (kind === "agent" || kind === "task") return { name: "agent", glyph: <IconSparkles /> };
  if (kind === "read" || /(^|-)(read|note|notes|file|files)(-|$)/.test(kind)) return { name: "file", glyph: <IconFileText /> };
  return { name: "tool", glyph: <IconWrench /> };
}

/** A one-call run's result in a few words, for a theme that shows the run as a card (`.cl-conv-tools__meta`): its
 *  output's lines once it is done, that it failed or was cut off; nothing while it runs or waits (its mark says so). */
function resultMeta(call: ToolCall): string | undefined {
  if (call.status === "failed") return S.toolFailed;
  if (call.status === "interrupted") return S.toolInterrupted;
  if (call.status !== "succeeded") return undefined;
  const text = (call.output ?? "").replace(/\n+$/, "");
  if (text === "") return undefined;
  return S.toolLines(text.split("\n").length);
}

/** The call's name: a bot's own plugin's tools by words alone, another plugin's with its name after. */
function callName(call: ToolCall, botId: string): string {
  const plugin = splitPluginTool(call.name);
  if (!plugin) return call.name;
  // A row always names the tool as the plugin serves it (its own name, never a title that could pass for Clover's).
  return isOwnTool(call.name, botId) ? plugin.tool : `${plugin.tool} (${plugin.namespace})`;
}

/** One own-plugin call as a chip: the tool's own one-line answer when it gave one ("Scene: starry night"), else its name in words. */
function chipText(call: ToolCall): string {
  if (call.display && call.status === "succeeded") return `${call.display.label}: ${call.display.value}`;
  const line = call.status === "succeeded" ? (call.output ?? "").trim() : "";
  if (line !== "" && line.length <= 56 && !line.includes("\n") && !line.startsWith("{")) return line.replace(/\.$/, "");
  return toolWords(call.name);
}

function failureSummary(calls: readonly ToolCall[]): string | undefined {
  const failed = calls.find((c) => c.status === "failed");
  if (!failed) return undefined;
  const line = firstLine(failed.output ?? "");
  return line ? clip(line, MAX_FAILURE_SUMMARY) : undefined;
}

function DiffChip({ call, ctx }: { call: ToolCall; ctx: MessageContext }) {
  const diff = call.diff;
  if (!diff) return null;
  const body = (
    <>
      <span className="cl-conv-diff__verb">{writeVerb(call.output) === "created" ? S.resultCreated : S.resultEdited}</span>
      <span className="cl-conv-diff__path">{shortPath(diff.path)}</span>
      <span className="cl-conv-diff__removed">-{diff.removed}</span>
      <span className="cl-conv-diff__added">+{diff.added}</span>
    </>
  );
  const open = ctx.actions.onOpenDiff;
  return open ? (
    <button type="button" className="cl-conv-diff" onClick={() => open(diff.diffId)} aria-label={S.toolOpenDiff(diff.path)} title={diff.path}>
      {body}
    </button>
  ) : (
    <span className="cl-conv-diff" title={diff.path}>
      {body}
    </span>
  );
}

function Sites({ call, ctx }: { call: ToolCall; ctx: MessageContext }) {
  if (!call.sites?.length) return null;
  return (
    <ul className="cl-conv-sites">
      {call.sites.map((site) => (
        <li key={site.url}>
          <Link className="cl-conv-sites__link" href={site.url} onOpenLink={ctx.actions.onOpenLink} title={site.url}>
            {safeAsset(site.icon) ? <img className="cl-conv-sites__icon" src={safeAsset(site.icon)} alt="" /> : null}
            {hostOf(site.url)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Output({ call }: { call: ToolCall }) {
  if (call.output === undefined) return null;
  const preview = outputPreview(call.output);
  return (
    <div className="cl-conv-output" data-error={call.status === "failed" || undefined}>
      <pre className="cl-conv-output__text">{preview.text.length > 0 ? preview.text : S.toolNoOutput}</pre>
      {(preview.moreLines > 0 || preview.cut) && (
        <div className="cl-conv-output__more">{preview.cut ? S.toolMoreCharacters : S.toolMoreLines(preview.moreLines)}</div>
      )}
    </div>
  );
}

function CallDetail({ call, ctx }: { call: ToolCall; ctx: MessageContext }) {
  const detail = call.detail;
  const open = ctx.actions.onOpenFile;
  if (detail && open && FILE_TOOLS.has(call.name)) {
    return (
      <button type="button" className="cl-conv-call__path" onClick={() => open(detail)} title={detail}>
        {detail}
      </button>
    );
  }
  return detail === undefined ? null : <span className="cl-conv-call__detail">{detail}</span>;
}

export function ToolRun({ item, ctx, expanded, onToggle, renderResult }: ToolRunProps) {
  const calls = item.calls;
  const bodyId = useId();
  const status = runStatus(calls);
  const computer = sharedComputer(calls);
  const reviewing = calls.some((c) => c.reviewing);
  const failure = status === "failed" ? failureSummary(calls) : undefined;
  const own = calls.filter((c) => isOwnTool(c.name, ctx.botId));
  const others = calls.filter((c) => !isOwnTool(c.name, ctx.botId));
  const diffs = calls.filter((c) => c.diff);
  const apps = calls.filter((c) => c.app);
  // What a theme can show of the run as a card (hidden in the stock look): the kind's icon, and for one call its hint
  // and its result in a few words.
  const kind = kindIcon(runKind(calls));
  const single = others.length === 1 && own.length === 0 ? others[0] : undefined;
  const detail = single ? (titleFor(single, ctx.botId) ?? single.detail) : undefined;
  const meta = single ? resultMeta(single) : undefined;
  return (
    <div className="cl-conv-tools" data-kind="tool" data-tool={runKind(calls)} data-status={status} data-open={expanded || undefined}>
      <button
        type="button"
        className="cl-conv-tools__summary"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        title={expanded ? S.toolHideDetails : S.toolShowDetails}
        onClick={onToggle}
      >
        <span className="cl-conv-tools__icon" data-icon={kind.name} aria-hidden="true">
          {kind.glyph}
        </span>
        <StatusGlyph status={status} />
        {others.length > 0 && <span className="cl-conv-tools__sentence">{toolSentence(others)}</span>}
        {detail !== undefined && detail !== "" && <span className="cl-conv-tools__detail">{detail}</span>}
        {meta !== undefined && <span className="cl-conv-tools__meta">{meta}</span>}
        {own.length > 0 && (
          <span className="cl-conv-tools__chips">
            {own.map((c) => (
              <span key={c.callId} className="cl-conv-chip" data-tool={toolKind(c.name)} data-kind={c.display?.kind} data-status={c.status} title={titleFor(c, ctx.botId)}>
                {c.display?.swatch && /^#[0-9A-Fa-f]{6}$/.test(c.display.swatch) ? <span className="cl-conv-chip__swatch" aria-hidden="true" style={{ background: c.display.swatch }} /> : null}
                {chipText(c)}
              </span>
            ))}
          </span>
        )}
        {computer && <span className="cl-conv-tools__computer">{S.toolOnComputer(computer)}</span>}
        {reviewing && <span className="cl-conv-tools__reviewing">{S.toolReviewing}</span>}
        <span className="cl-conv-chevron" aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {!expanded && failure && <div className="cl-conv-tools__failure">{failure}</div>}
      {!expanded && diffs.length > 0 && (
        <div className="cl-conv-tools__diffs">
          {diffs.map((c) => (
            <DiffChip key={c.callId} call={c} ctx={ctx} />
          ))}
        </div>
      )}
      {expanded && (
        <ol className="cl-conv-tools__calls" id={bodyId}>
          {calls.map((call) => {
            const drawn = ToolResult({ call, agents: ctx.agents });
            const standard = (
              <>
                {drawn ?? <Output call={call} />}
                <DiffChip call={call} ctx={ctx} />
                {!(drawn && toolKind(call.name) === "websearch") && <Sites call={call} ctx={ctx} />}
              </>
            );
            const custom = renderResult?.(call, standard);
            return (
              <li key={call.callId} className="cl-conv-call" data-tool={toolKind(call.name)} data-status={call.status}>
                <div className="cl-conv-call__head">
                  <StatusGlyph status={call.status} />
                  <span className="cl-conv-call__name">{callName(call, ctx.botId)}</span>
                  {titleFor(call, ctx.botId) ? <span className="cl-conv-call__detail">{titleFor(call, ctx.botId)}</span> : null}
                  <CallDetail call={call} ctx={ctx} />
                  {call.computer && !computer && <span className="cl-conv-call__computer">{S.toolOnComputer(call.computer)}</span>}
                  {call.reviewing && <span className="cl-conv-tools__reviewing">{S.toolReviewing}</span>}
                </div>
                {custom === undefined ? standard : <div className="cl-conv-call__custom">{custom}</div>}
              </li>
            );
          })}
        </ol>
      )}
      {apps.map((call) => (
        <div key={call.callId} className="cl-conv-app">
          <AppView call={{ session: ctx.session, callId: call.callId }} />
        </div>
      ))}
    </div>
  );
}
