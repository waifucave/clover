// The plugins' lines, drawn by the island (`island.line`, model/lines.ts): an icon from the island's own set, the line's
// words, whose it is (the plugin, and the bot when the line names one) and an optional progress bar. The island sets all
// of it: a sender gives words and numbers, never markup, colours, sizes or places.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { LINE_POLL_MS, LineBoard, lineSource, type Line, type LineDeps, type LinePoll } from "../model/lines";
import { t } from "../strings";
import { Glyph } from "./glyphs";

/** What the island reads from the plugin API to ask for lines: the entries of `island.line` and a call of an entry's handler.
 *  `watch` tells it when plugins are added, turned off or removed (it asks again at once). */
export interface LineSource {
  entries: LineDeps["entries"];
  call: LineDeps["call"];
  watch?(listener: () => void): () => void;
}

const within = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });

const NONE: LinePoll = { lines: [], more: 0 };

/** The lines now: asked for while `active` (the open island's Needs you tab is up), again every `LINE_POLL_MS` and when the
 *  entries change, and gone the moment it is not. Idle cost when not active: nothing. */
export function useLines(source: LineSource | undefined, active: boolean): LinePoll {
  const [poll, setPoll] = useState<LinePoll>(NONE);
  const board = useMemo(() => (source === undefined ? undefined : new LineBoard({ entries: source.entries, call: source.call, now: () => performance.now(), within })), [source]);
  const ask = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (board === undefined || !active) {
      setPoll((p) => (p === NONE || (p.lines.length === 0 && p.more === 0) ? p : NONE));
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const next = await board.poll();
        if (live) setPoll((p) => (sameLines(p, next) ? p : next));
      } catch {
        if (live) setPoll(NONE);
      } finally {
        running = false;
        if (live) {
          clearTimeout(timer);
          timer = setTimeout(() => void run(), again ? 0 : LINE_POLL_MS);
          again = false;
        }
      }
    };
    ask.current = () => void run();
    void run();
    const stop = source?.watch?.(() => ask.current());
    return () => {
      live = false;
      clearTimeout(timer);
      stop?.();
    };
  }, [board, active, source]);
  return poll;
}

function sameLines(a: LinePoll, b: LinePoll): boolean {
  return a.more === b.more && a.lines.length === b.lines.length && a.lines.every((l, i) => {
    const o = b.lines[i]!;
    return l.key === o.key && l.text === o.text && l.icon === o.icon && l.progress === o.progress && l.bot === o.bot;
  });
}

export interface LinesProps {
  poll: LinePoll;
  /** A bot's name for its id, when the app knows it. */
  botName?: (id: string) => string | undefined;
}

export function LineRows({ poll, botName }: LinesProps): ReactElement | null {
  if (poll.lines.length === 0) return null;
  return (
    <div className="clv-lines" role="list" aria-label={t("clover.island.lines")}>
      {poll.lines.map((line) => (
        <LineRow key={line.key} line={line} botName={botName} />
      ))}
      {poll.more > 0 ? <div className="clv-lines-more">{t("clover.island.linesMore", { count: poll.more })}</div> : null}
    </div>
  );
}

function LineRow({ line, botName }: { line: Line; botName?: (id: string) => string | undefined }): ReactElement {
  const percent = line.progress === undefined ? undefined : Math.round(line.progress * 100);
  return (
    <div className="clv-line" role="listitem" data-plugin={line.pluginId}>
      <span className="clv-line-icon">{line.icon !== undefined ? <Glyph name={line.icon} /> : null}</span>
      <span className="clv-line-from">{lineSource(line, botName)}</span>
      <span className="clv-line-text">{line.text}</span>
      {percent !== undefined ? (
        <span className="clv-line-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("clover.island.lineProgress", { percent })}>
          <span style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </div>
  );
}

