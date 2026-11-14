// The plugins' lines, drawn by the island (`island.line`, model/lines.ts): an icon from the island's own set, the line's
// words, whose it is (the plugin, and the bot when the line names one) and an optional progress bar. The island sets all
// of it: a sender gives words and numbers, never markup, colours, sizes or places.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { LINE_CLOSED_POLL_MS, LINE_POLL_MS, LineBoard, lineSource, type Line, type LineDeps, type LineEntry, type LinePoll } from "../model/lines";
import { t } from "../strings";
import { Glyph } from "./glyphs";

/** What the island reads from the plugin API to ask for lines: the entries of `island.line` and a call of an entry's handler.
 *  `watch` tells it when plugins are added, turned off or removed; `watchWork` when a bot starts or stops work (a plugin's
 *  line often follows a turn). Either wakes it: it asks again at once, senders that had gone quiet included. */
export interface LineSource {
  entries: LineDeps["entries"];
  call: LineDeps["call"];
  watch?(listener: () => void): () => void;
  watchWork?(listener: () => void): () => void;
}

/** When lines are asked for: `open` (the open island's Needs you tab is up, `LINE_POLL_MS`), `closed` (the closed strip may
 *  show one, `LINE_CLOSED_POLL_MS`), or `off` (nothing is asked, nothing runs). */
export type LineMode = "off" | "open" | "closed";

const within = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });

const NONE: LinePoll = { lines: [], more: 0 };
/** Bots change often while they work; one ask follows a burst of them. */
const WAKE_DEBOUNCE_MS = 300;

/** The lines now, asked for only in `open` or `closed` mode and gone the moment it is `off`. The entries of the point are kept
 *  until the registry says they changed, so with no plugin filling it nothing is asked and no timer runs; a sender that keeps
 *  answering nothing is left alone until something wakes it (`LineBoard`). Idle cost when `off`: nothing. */
export function useLines(source: LineSource | undefined, mode: LineMode): LinePoll {
  const [poll, setPoll] = useState<LinePoll>(NONE);
  const kept = useRef<{ entries?: Promise<LineEntry[]> }>({});
  const board = useMemo(() => {
    if (source === undefined) return undefined;
    kept.current = {};
    const entries = () => {
      const have = kept.current.entries ?? (kept.current.entries = source.entries());
      have.catch(() => { if (kept.current.entries === have) kept.current.entries = undefined; });
      return have;
    };
    return new LineBoard({ entries, call: source.call, now: () => performance.now(), within });
  }, [source]);
  useEffect(() => {
    if (board === undefined || mode === "off") {
      setPoll((p) => (p === NONE || (p.lines.length === 0 && p.more === 0) ? p : NONE));
      return;
    }
    const every = mode === "open" ? LINE_POLL_MS : LINE_CLOSED_POLL_MS;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      let idle = false;
      try {
        const next = await board.poll();
        idle = board.entryCount === 0;
        if (live) setPoll((p) => (sameLines(p, next) ? p : next));
      } catch {
        if (live) setPoll(NONE);
      } finally {
        running = false;
        if (live) {
          clearTimeout(timer);
          // No plugin fills the point: no timer at all; a change of the registry (`watch`) is what starts the asking again.
          if (again) timer = setTimeout(() => void run(), 0);
          else if (!idle) timer = setTimeout(() => void run(), every);
          again = false;
        }
      }
    };
    board.wake();
    void run();
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const wake = (registry: boolean) => {
      if (registry) kept.current.entries = undefined;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => { board.wake(); void run(); }, registry ? 0 : WAKE_DEBOUNCE_MS);
    };
    const stops = [source?.watch?.(() => wake(true)), source?.watchWork?.(() => wake(false))];
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(wakeTimer);
      for (const stop of stops) stop?.();
    };
  }, [board, mode, source]);
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

/** The first line on the closed strip, below it: the island's own small pill (the sender's name, its words, an icon and a
 *  progress bar). It is drawn only while nothing waits and Clover's window is not in front; a click opens the island on
 *  Needs you, as the strip does. It never takes the keyboard focus, never makes a sound and never moves. */
export function StripLine({ line, left, top, width, height, botName, onOpen }: { line: Line; left: number; top: number; width: number; height: number; botName?: (id: string) => string | undefined; onOpen?: () => void }): ReactElement {
  const percent = line.progress === undefined ? undefined : Math.round(line.progress * 100);
  return (
    <button
      type="button"
      className="clv-stripline"
      style={{ left: `calc(50% + ${left}px)`, top, width, height }}
      tabIndex={-1}
      aria-label={t("clover.island.stripLine", { from: lineSource(line, botName), text: line.text })}
      data-plugin={line.pluginId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
    >
      <span className="clv-line-icon">{line.icon !== undefined ? <Glyph name={line.icon} /> : null}</span>
      <span className="clv-line-from">{lineSource(line, botName)}</span>
      <span className="clv-line-text">{line.text}</span>
      {percent !== undefined ? (
        <span className="clv-line-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("clover.island.lineProgress", { percent })}>
          <span style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </button>
  );
}
