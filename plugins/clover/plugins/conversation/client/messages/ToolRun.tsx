import { useId, type ReactNode } from "react";
import type { MessageContext, MessageSpotProps } from "../context";
import { clip, firstLine, hostOf } from "../format";
import { IconChevron } from "../icons";
import { StatusGlyph } from "../parts";
import { Link } from "../Link";
import { safeAsset } from "../links";
import { AppView } from "../sdk";
import { S } from "../strings";
import { ToolResult, shortPath, writeVerb } from "../result";
import { isOwnTool, runStatus, sharedComputer, splitPluginTool, toolSentence, toolWords } from "../tool-phrases";
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

/** The call's name: a bot's own plugin's tools by words alone, another plugin's with its name after. */
function callName(call: ToolCall, botId: string): string {
  const plugin = splitPluginTool(call.name);
  if (!plugin) return call.name;
  return isOwnTool(call.name, botId) ? toolWords(call.name) : `${toolWords(call.name)} (${plugin.namespace})`;
}

/** One own-plugin call as a chip: the tool's own one-line answer when it gave one ("Scene: starry night"), else its name in words. */
function chipText(call: ToolCall): string {
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
        <StatusGlyph status={status} />
        {others.length > 0 && <span className="cl-conv-tools__sentence">{toolSentence(others)}</span>}
        {own.length > 0 && (
          <span className="cl-conv-tools__chips">
            {own.map((c) => (
              <span key={c.callId} className="cl-conv-chip" data-tool={toolKind(c.name)} data-status={c.status}>{chipText(c)}</span>
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
            const drawn = ToolResult({ call });
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
