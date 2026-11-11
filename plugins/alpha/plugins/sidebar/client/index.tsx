// Alpha's sidebar: a child plugin of hers that fills the shell's `sidebar` spot only while her tab shows (`when.bot`), in its own frame. It reads the bots
// (`bots`) and where the window is (`shell.state`, the app buttons with `shell.apps`) and moves around the window with `shell.go`, `shell.openSettings` and
// `shell.toggleSidebar`: each a press of the user's own, none of it special to Alpha. The app draws the card it sits in (its width, corners and inset are her theme's
// shape tokens); this draws what is inside.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import type { ShellApp, ShellState } from "@waifucave/clover-plugin-sdk";

interface BotRow { id: string; name: string; state: string; portrait?: string }
const FONT = 'var(--alpha-display, ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", system-ui, sans-serif)';

const CSS = `
html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; font-family: var(--clover-font-family, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
.as { --ink: #2A2140; --soft: #5C5278; --accent: #6A45D4; --wash: rgba(255,255,255,.7); --line: rgba(120,96,200,.2);
  box-sizing: border-box; height: 100vh; display: flex; flex-direction: column; padding: 46px 12px 12px; color: var(--ink); user-select: none; }
.as[data-dark] { --ink: #F3EEFF; --soft: #B3A9D2; --accent: #D9C8FF; --wash: rgba(255,255,255,.12); --line: rgba(255,255,255,.16); }
.as__brand { display: flex; align-items: center; gap: 8px; padding: 0 8px 14px; font: 650 15px/1 ${FONT}; letter-spacing: .02em; }
.as__brand i { font-style: normal; color: var(--accent); transform: rotate(-8deg); display: inline-block; }
.as__switch { display: flex; gap: 3px; padding: 3px; border-radius: 999px; background: var(--wash); border: 1px solid var(--line); margin-bottom: 16px; }
.as__switch button { flex: 1; }
:where(.as) button { all: unset; box-sizing: border-box; cursor: pointer; }
.as button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.as__opt { display: flex; align-items: center; justify-content: center; gap: 6px; height: 30px; border-radius: 999px; font-size: 12.5px; color: var(--soft); }
.as__opt[aria-checked="true"] { background: var(--accent); color: #fff; }
.as[data-dark] .as__opt[aria-checked="true"] { color: #1A1030; }
.as__scroll { flex: 1; min-height: 0; overflow-y: auto; margin: 0 -4px; padding: 0 4px; scrollbar-width: none; }
.as__h { margin: 14px 8px 6px; font: 600 10.5px/1 ${FONT}; letter-spacing: .18em; text-transform: uppercase; color: var(--soft); }
.as__row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 0 10px; height: 42px; border-radius: 16px; color: var(--ink); font: 550 14px/1 ${FONT}; transition: background-color .18s ease, transform .18s ease; }
.as__row:hover { background: var(--wash); transform: translateX(2px); }
.as__row[aria-current="page"] { background: var(--wash); box-shadow: inset 0 0 0 1.5px var(--accent); }
.as__av { width: 26px; height: 26px; border-radius: 50%; flex: none; display: grid; place-items: center; overflow: hidden; font-size: 12px; background: radial-gradient(circle at 35% 30%, #fff, var(--wash)); color: var(--accent); box-shadow: 0 0 0 1.5px var(--line); }
.as__av img { width: 100%; height: 100%; object-fit: cover; }
.as__name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as__dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #1F9E7A; }
.as__dot[data-state="thinking"] { background: var(--accent); animation: as-pulse 1.1s ease-in-out infinite; }
.as__dot[data-state="asleep"], .as__dot[data-state="paused"] { background: var(--soft); }
@keyframes as-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.7); } }
.as__glyph { width: 26px; height: 26px; flex: none; display: grid; place-items: center; color: var(--accent); }
.as__glyph svg, .as__foot svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.as__foot { display: flex; align-items: center; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line); margin-top: 8px; }
.as__foot .as__row { flex: 1; }
.as__tool { width: 38px; height: 38px; border-radius: 14px; display: grid; place-items: center; color: var(--soft); flex: none; }
.as__tool:hover { background: var(--wash); color: var(--accent); }
.as[data-rail] { padding: 46px 8px 12px; align-items: center; }
.as[data-rail] .as__scroll { margin: 0; padding: 0; width: 100%; }
.as[data-rail] .as__row { justify-content: center; padding: 0; }
.as[data-rail] .as__foot { flex-direction: column; border-top: 0; }
@media (prefers-reduced-motion: reduce) { .as__row, .as__dot { transition: none !important; animation: none !important; } }
`;

const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
const PLUG = <Icon><path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4" /></Icon>;
const GEAR = <Icon><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></Icon>;
const FOLD = <Icon><rect x="3.5" y="4.5" width="17" height="15" rx="3.5" /><path d="M9.5 4.5v15" /></Icon>;
const APP = <Icon><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></Icon>;

/** Dark when the tab's own surface token is: the window's appearance reaches this frame as tokens. */
function useDark(): boolean {
  const read = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--clover-color-surface").trim();
    const m = /^#([0-9a-f]{6})/i.exec(v);
    if (m === null) return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    const n = parseInt(m[1]!, 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.5;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setDark((d) => { const n = read(); return n === d ? d : n; }), 1000);
    return () => clearInterval(t);
  }, []);
  return dark;
}

const initial = (name: string) => (name.trim()[0] ?? "·").toUpperCase();

export function AlphaSidebar() {
  const api = usePluginApi();
  const shell = api.shell;
  const [bots, setBots] = useState<BotRow[]>([]);
  const [win, setWin] = useState<ShellState | undefined>();
  const [apps, setApps] = useState<readonly ShellApp[]>([]);
  const styled = useRef(false);
  const dark = useDark();

  useEffect(() => {
    if (styled.current) return;
    styled.current = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.append(el);
  }, []);
  useEffect(() => shell?.watch?.(setWin), [shell]);
  useEffect(() => { void shell?.apps?.().then(setApps, () => undefined); }, [shell, win?.tab.kind]);
  useEffect(() => {
    let live = true;
    const row = (b: any): BotRow => ({ id: b.id, name: typeof b.name === "string" ? b.name : b.id, state: b.state ?? "idle", ...(b.portrait ? { portrait: b.portrait } : {}) });
    void api.bots?.list().then((l) => live && setBots(l.map(row)), () => undefined);
    const stop = api.bots?.watch((b: any) => setBots((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? row(b) : x)) : [...list, row(b)])));
    return () => { live = false; stop?.(); };
  }, [api]);

  const rail = win?.sidebar.collapsed === true;
  const run = (p: Promise<void> | undefined) => void p?.catch(() => undefined);
  const onBot = win?.tab.kind === "bot" ? win.tab.id : undefined;
  return (
    <nav className="as" aria-label="Sidebar" data-rail={rail || undefined} data-dark={dark || undefined}>
      {!rail && <div className="as__brand"><i aria-hidden="true">☘</i>Clover</div>}
      <div className="as__switch" role="radiogroup" aria-label="Bots or code" style={rail ? { flexDirection: "column", width: "100%" } : undefined}>
        <button type="button" role="radio" aria-checked="true" className="as__opt" title="Bots" aria-label="Bots">{rail ? "✿" : "Bots"}</button>
        <button type="button" role="radio" aria-checked="false" className="as__opt" title="Code" aria-label="Code" onClick={() => run(shell?.go?.({ side: "code" }))}>{rail ? "</>" : "Code"}</button>
      </div>
      <div className="as__scroll">
        {!rail && <div className="as__h">Bots</div>}
        {bots.map((b) => (
          <button key={b.id} type="button" className="as__row" aria-current={onBot === b.id ? "page" : undefined} aria-label={b.name} title={b.name} onClick={() => run(shell?.go?.({ bot: b.id }))}>
            <span className="as__av">{b.portrait ? <img src={b.portrait} alt="" /> : initial(b.name)}</span>
            {!rail && <span className="as__name">{b.name}</span>}
            {!rail && <i className="as__dot" data-state={b.state} />}
          </button>
        ))}
        {!rail && apps.length > 0 && <div className="as__h">Apps</div>}
        {apps.map((a) => (
          <button key={a.id} type="button" className="as__row" aria-current={win?.tab.kind === "app" && win.tab.id === a.id ? "page" : undefined} aria-label={a.title} title={a.title} onClick={() => run(shell?.go?.({ app: a.id }))}>
            <span className="as__glyph">{a.icon ? <img src={a.icon} alt="" width={17} height={17} /> : APP}</span>
            {!rail && <span className="as__name">{a.title}</span>}
          </button>
        ))}
      </div>
      <div className="as__foot">
        <button type="button" className="as__row" aria-label="Plugins" title="Plugins" onClick={() => run(shell?.go?.({ page: "plugins" }))}>
          <span className="as__glyph">{PLUG}</span>{!rail && <span className="as__name">Plugins</span>}
        </button>
        <button type="button" className="as__tool" aria-label="Settings" title="Settings" onClick={() => run(shell?.openSettings?.())}>{GEAR}</button>
        {!rail && <button type="button" className="as__tool" aria-label="Fold the sidebar" title="Fold the sidebar" onClick={() => run(shell?.toggleSidebar?.())}>{FOLD}</button>}
      </div>
    </nav>
  );
}
