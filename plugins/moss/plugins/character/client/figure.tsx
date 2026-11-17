// The figure, wherever this plugin shows it (a panel beside a session, a window on the screen): one figure at a time,
// drawn by the renderer of its format through this plugin's own UI spot `moss.character.renderer`, keyed by format.
//
// * The renderer is sent `{ mount, cue }` and sends back `{ mount, names?, box? }` (point messages on that spot); each
//   drawing has its own `mount`, so two places showing the figure never take each other's words.
// * A controller (a plugin with an entry in `moss.character.figure`) sends cues; each is judged here against what the
//   renderer declared (`moss.character.formats`) and the names its model has, answered `{ result }`, and played when it
//   can be. What the model has and where the figure stands go to the controllers as they change (`{ catalogue, box }`).
// * The activity feed moves it (`mood.ts`): the session it is shown beside, or on the screen the most recent change
//   among sessions (and bots, when the person lets it follow them).
// * In a test or acceptance build its root carries what it follows (`data-activity`) and the last cue it sent.
import type { PointMessage } from "@waifucave/moss-plugin-sdk";
import { Spot, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { FIGURE_POINT, RENDERER_SPOT, useFigure, useSetting, type FigureChoice, type FormatDecl } from "./choice";
import { boxOrDefault, catalogueOf, cleanFigureBox, cleanFigureCue, cleanFigureNames, judgeCue, type FigureBox, type FigureCue, type FigureNames, type FigureReport } from "./figure-cues";
import { cuesFor, followed, merge, type ActivityView } from "./mood";
import { S } from "./strings";

declare const __MOSS_TEST_BUILD__: string | false | undefined;
declare const __MOSS_ACCEPTANCE_BUILD__: string | false | undefined;
const marked = (): boolean => (typeof __MOSS_TEST_BUILD__ === "string" && __MOSS_TEST_BUILD__ !== "") || (typeof __MOSS_ACCEPTANCE_BUILD__ === "string" && __MOSS_ACCEPTANCE_BUILD__ !== "");

/** How the figure is framed, as the renderer's `framing` prop: the theme's `--moss-avatar-framing` (`full`, `bust`,
 *  `waist`), `--moss-avatar-crop` (0.2 to 1) and `--moss-avatar-headroom` (0 to 0.6; 0.03 when it says none), each only
 *  when valid. CSS variables do not cross into a renderer's own frame, so they are read here and handed over as data. */
export interface FigureFraming { mode?: "full" | "bust" | "waist"; crop?: number; headroom?: number }

export function readFraming(style: { getPropertyValue(name: string): string }): FigureFraming | undefined {
  const mode = style.getPropertyValue("--moss-avatar-framing").trim();
  const num = (n: string): number => Number.parseFloat(style.getPropertyValue(n));
  const show = num("--moss-avatar-crop");
  const headroom = num("--moss-avatar-headroom");
  const out: FigureFraming = {
    ...(mode === "full" || mode === "bust" || mode === "waist" ? { mode } : {}),
    ...(Number.isFinite(show) && show >= 0.2 && show <= 1 ? { crop: show, headroom: Number.isFinite(headroom) && headroom >= 0 && headroom <= 0.6 ? headroom : 0.03 } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function useFraming(el: HTMLElement | null): FigureFraming | undefined {
  const [framing, setFraming] = useState<FigureFraming | undefined>(undefined);
  useEffect(() => {
    if (!el || typeof getComputedStyle !== "function") return;
    const read = () => setFraming((was) => {
      const now = readFraming(getComputedStyle(el));
      return JSON.stringify(was) === JSON.stringify(now) ? was : now;
    });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return framing;
}

/** The activity feed this figure follows: the kinds it reads, kept current. */
function useActivity(bots: boolean): ActivityView[] {
  const api = usePluginApi();
  const [all, setAll] = useState<ActivityView[]>([]);
  useEffect(() => {
    let live = true;
    const kinds = bots ? (["sessions", "bots"] as const) : (["sessions"] as const);
    const stops: (() => void)[] = [];
    for (const kind of kinds) {
      void api.activity?.list(kind).then((list) => live && setAll((was) => (list as unknown as ActivityView[]).reduce(merge, was)), () => undefined);
      const stop = api.activity?.watch(kind, (a) => live && setAll((was) => merge(was, a as unknown as ActivityView)));
      if (stop !== undefined) stops.push(stop);
    }
    return () => { live = false; for (const s of stops) s(); };
  }, [api, bots]);
  return all;
}

/** The renderer drawing this mount: what it reported (its names and box), and how to send it a cue. */
function useRendererLink(mount: string, format: FormatDecl | undefined): { report: FigureReport | undefined; cue(c: FigureCue): void } {
  const api = usePluginApi();
  const [names, setNames] = useState<FigureNames | undefined>(undefined);
  const [box, setBox] = useState<FigureBox | undefined>(undefined);
  const renderer = format?.renderer;
  useEffect(() => {
    setNames(undefined);
    setBox(undefined);
    if (renderer === undefined) return;
    return api.points.onMessage(RENDERER_SPOT, (m: PointMessage) => {
      const v = m.value as { mount?: unknown; names?: unknown; box?: unknown } | null;
      if (m.from !== renderer || v === null || typeof v !== "object" || v.mount !== mount) return;
      if (v.names === null) setNames(undefined);
      else if (v.names !== undefined) { const n = cleanFigureNames(v.names); if (n !== undefined) setNames((was) => (JSON.stringify(was) === JSON.stringify(n) ? was : n)); }
      if (v.box === null) setBox(undefined);
      else if (v.box !== undefined) { const b = cleanFigureBox(v.box); if (b !== undefined) setBox((was) => (JSON.stringify(was) === JSON.stringify(b) ? was : b)); }
    });
  }, [api, mount, renderer]);
  const report = useMemo<FigureReport | undefined>(() => (format === undefined ? undefined : { format: format.format, renderer: format.renderer, capabilities: format.capabilities, ...(names !== undefined ? { names } : {}), ...(box !== undefined ? { box } : {}) }), [format, names, box]);
  return {
    report,
    cue: (c) => {
      if (renderer !== undefined) void api.points.send(RENDERER_SPOT, { mount, cue: c }, { to: renderer }).catch(() => undefined);
    },
  };
}

export function Figure({ place, session }: { place: "panel" | "screen"; session?: string }) {
  const api = usePluginApi();
  const { shown, formats, ready } = useFigure();
  const format = shown === undefined ? undefined : formats.find((f) => f.format === shown.format);
  const mount = useMemo(() => `${place}-${Math.random().toString(36).slice(2, 10)}`, [place]);
  const link = useRendererLink(mount, format);
  const reportRef = useRef(link.report);
  reportRef.current = link.report;
  const cueRef = useRef(link.cue);
  cueRef.current = link.cue;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const framing = useFraming(el);
  const [lastCue, setLastCue] = useState<string | undefined>(undefined);
  const send = (c: FigureCue) => {
    cueRef.current(c);
    if (marked()) setLastCue(JSON.stringify(c));
  };

  // Controllers: their cues judged and played, each answered; what the figure has goes to them as it changes.
  useEffect(() => api.points.onMessage(FIGURE_POINT, (m: PointMessage) => {
    const raw = m.value as { cue?: unknown; id?: unknown } | null;
    const id = typeof raw?.id === "string" && raw.id.length <= 64 ? raw.id : undefined;
    const answer = (result: unknown) => void api.points.send(FIGURE_POINT, { ...(id !== undefined ? { id } : {}), result }, { to: m.from }).catch(() => undefined);
    const cue = cleanFigureCue(raw?.cue ?? raw);
    if (cue === undefined) return answer({ ok: false, reason: "invalid", message: "a cue is an expression, a motion, an outfit part with on or off, the pace, or a point to look at" });
    const no = judgeCue(reportRef.current, cue);
    if (no !== undefined) return answer(no);
    send(cue);
    answer({ ok: true });
  }), [api]);
  const catalogue = useMemo(() => JSON.stringify({ catalogue: catalogueOf(link.report) ?? null, box: boxOrDefault(link.report?.box) ?? null }), [link.report]);
  useEffect(() => {
    void api.points.send(FIGURE_POINT, JSON.parse(catalogue)).catch(() => undefined);
  }, [api, catalogue]);

  // The activity feed: the session beside it, or on the screen the latest change (bots too, when the person allows).
  const followBots = useSetting<boolean>("followBots") !== false && place === "screen";
  const activity = useActivity(followBots);
  const now = followed(activity, place === "panel" ? session : undefined);
  const state = now?.state;
  const names = link.report?.names;
  const canPace = format?.capabilities.includes("pace") === true;
  useEffect(() => {
    if (state === undefined || format === undefined) return;
    for (const c of cuesFor(state, names, canPace)) send(c);
    // A new state (or a model that loaded) plays its cues once.
  }, [state, names, canPace, format]);

  if (!ready) return null;
  const portrait = shown?.portrait === undefined ? undefined : <img className="cl-figure__portrait" src={shown.portrait} alt="" />;
  return (
    <div ref={setEl} className="cl-figure" data-place={place} data-format={shown?.format} data-activity={marked() ? (state ?? "") : undefined} data-figure-cue={marked() ? lastCue : undefined}>
      {shown === undefined
        ? <p className="cl-figure__empty" role="status">{S.noFigure}</p>
        : <Spot name={RENDERER_SPOT} spotKey={shown.format} props={figureProps(mount, shown, framing)} fallback={portrait ?? <p className="cl-figure__empty" role="status">{S.noRenderer(shown.format)}</p>} fill />}
    </div>
  );
}

function figureProps(mount: string, c: FigureChoice, framing: FigureFraming | undefined): Record<string, unknown> {
  return { mount, src: c.src, file: c.src, format: c.format, name: c.name, ...(c.portrait !== undefined ? { portrait: c.portrait } : {}), ...(framing !== undefined ? { framing } : {}) };
}
