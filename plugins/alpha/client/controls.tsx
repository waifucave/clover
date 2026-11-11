// Alpha's own controls, drawn by her plugin in her own frame where her layout puts them (`bot.controls`): no title bar; her name, how she is, the sidebar's
// button, a handle that drags the window, and her buttons sit in one line of her scene. What they do is the plugin API's `shell.*` (the window's own state
// and acts, each act the user's own press): nothing here is special-cased for Alpha by the app, and another bot's plugin can draw its own the same way.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import { useStageState } from "./stage-store";
import { DARK_SCENES } from "./backdrop";

interface BotRef { id: string; name: string }
const FONT = 'var(--alpha-display, ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", system-ui, sans-serif)';
const WORDS: Record<string, string> = { idle: "Here with you", thinking: "Thinking it over", asleep: "Asleep on another computer", paused: "Paused" };

const CSS = `
html, body { background: transparent !important; margin: 0; overflow: hidden; font-family: var(--clover-font-family, system-ui, sans-serif); color: var(--clover-color-text, #221A33); -webkit-font-smoothing: antialiased; }
.ac { --glass: rgba(255,255,255,.74); --edge: rgba(120,96,200,.22); --ink: #2A2140; --soft: #655C7E; --accent: #6A45D4; --wash: #EFE8FF;
  box-sizing: border-box; height: 64px; display: flex; align-items: center; gap: 10px; padding: 10px 18px 0 12px; user-select: none; }
.ac[data-dark] { --glass: rgba(26,20,50,.66); --edge: rgba(255,255,255,.16); --ink: #F6F1FF; --soft: #CFC5EA; --accent: #D9C8FF; --wash: rgba(255,255,255,.14); }
.ac__btn { all: unset; box-sizing: border-box; width: 38px; height: 38px; border-radius: 999px; display: grid; place-items: center; cursor: pointer; flex: none; color: var(--ink);
  background: var(--glass); border: 1px solid var(--edge); box-shadow: 0 10px 24px -16px rgba(60,36,130,.5); transition: transform .18s ease, background-color .18s ease; }
.ac__btn:hover { background: var(--wash); color: var(--accent); transform: translateY(-1px); }
.ac__btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ac__btn[aria-pressed="true"] { background: var(--wash); color: var(--accent); border-color: var(--accent); }
.ac__btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.ac__who { all: unset; display: flex; align-items: center; gap: 10px; padding: 4px 16px 4px 5px; border-radius: 999px; min-width: 0; cursor: pointer; background: var(--glass); border: 1px solid var(--edge); box-shadow: 0 10px 24px -16px rgba(60,36,130,.5); }
.ac__who:hover { background: var(--wash); }
.ac__who:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ac__face { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; overflow: hidden; background: radial-gradient(circle at 35% 30%, #fff, var(--wash)); box-shadow: 0 0 0 2px var(--accent); color: var(--accent); }
.ac__face img { width: 100%; height: 100%; object-fit: cover; }
.ac__face[data-state="thinking"] { animation: ac-breathe 2.2s ease-in-out infinite; }
@keyframes ac-breathe { 0%,100% { box-shadow: 0 0 0 2px var(--accent); } 50% { box-shadow: 0 0 0 5px var(--wash), 0 0 22px 2px var(--accent); } }
.ac__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ac__name { font: 650 16px/1 ${FONT}; letter-spacing: .01em; color: var(--ink); display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.ac__sig { font-size: 13px; color: var(--accent); display: inline-block; transform: rotate(-8deg); }
.ac__state { font-size: 11.5px; color: var(--soft); display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 34ch; }
.ac__dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: #1F9E7A; }
.ac[data-state="thinking"] .ac__dot { background: var(--accent); animation: ac-pulse 1.1s ease-in-out infinite; }
.ac[data-state="asleep"] .ac__dot, .ac[data-state="paused"] .ac__dot { background: var(--soft); }
@keyframes ac-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.7); } }
.ac__credit { overflow: hidden; text-overflow: ellipsis; }
.ac__drag { flex: 1 1 auto; align-self: stretch; min-width: 24px; cursor: grab; }
.ac__chip { font-size: 11.5px; padding: 5px 11px; border-radius: 999px; color: var(--soft); background: var(--glass); border: 1px solid var(--edge); white-space: nowrap; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
.ac__group { display: flex; gap: 8px; flex: none; }
@media (max-width: 640px) { .ac__chip, .ac__credit { display: none; } .ac__state { max-width: 18ch; } }
@media (prefers-reduced-motion: reduce) { .ac__face, .ac__dot, .ac__btn { animation: none !important; transition: none !important; } }
`;

const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
const SIDEBAR = <Icon><rect x="3.5" y="4.5" width="17" height="15" rx="3.5" /><path d="M9.5 4.5v15" /></Icon>;
const EDIT = <Icon><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Icon>;
const DETAILS = <Icon><rect x="3.5" y="4.5" width="17" height="15" rx="3.5" /><path d="M14.5 4.5v15" /></Icon>;
const GLOBE = <Icon><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5S14.6 18.1 12 20.5M12 3.5C9.4 5.9 8.2 8.7 8.2 12s1.2 6.1 3.8 8.5" /></Icon>;

interface BotNow { state: string; portrait?: string; model: string; credit?: string }

export function AlphaControls({ props }: { props: { bot: BotRef } }) {
  const api = usePluginApi();
  const shell = api.shell;
  const stage = useStageState();
  const [win, setWin] = useState<ShellState | undefined>();
  const [bot, setBot] = useState<BotNow | undefined>();
  const styled = useRef(false);

  useEffect(() => {
    if (styled.current) return;
    styled.current = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.append(el);
  }, []);
  useEffect(() => shell?.watch?.(setWin), [shell]);
  // These controls offer the two handles the window must always have, so the app adds none of its own.
  useEffect(() => {
    void shell?.provide?.(["sidebar", "drag"]).catch(() => undefined);
    return () => void shell?.provide?.([]).catch(() => undefined);
  }, [shell]);
  useEffect(() => {
    let live = true;
    const take = (b: any) => live && setBot({ state: b.state, portrait: b.portrait, model: b.model, ...(typeof b.avatar?.credit === "string" && b.avatar.credit !== "" ? { credit: b.avatar.credit } : {}) });
    void api.bots?.get(props.bot.id).then(take, () => undefined);
    const stop = api.bots?.watch((b: any) => { if (b.id === props.bot.id) take(b); });
    return () => { live = false; stop?.(); };
  }, [api, props.bot.id]);

  const open = new Set(win?.panels.open ?? []);
  const state = bot?.state ?? "idle";
  const run = (p: Promise<void> | undefined) => void p?.catch(() => undefined);
  const drag = (e: { button: number; target: EventTarget }) => { if (e.button === 0 && (e.target as HTMLElement).closest("button") === null) run(shell?.dragWindow?.()); };
  return (
    <div className="ac" data-state={state} data-dark={DARK_SCENES.has(stage.scene) || undefined} onMouseDown={drag}>
      <button type="button" className="ac__btn" aria-label={win?.sidebar.collapsed ? "Show the sidebar" : "Hide the sidebar"} aria-pressed={win ? !win.sidebar.collapsed : undefined} onClick={() => run(shell?.toggleSidebar?.())}>{SIDEBAR}</button>
      <button type="button" className="ac__who" aria-label={`Edit ${props.bot.name}`} title={`Edit ${props.bot.name}`} onClick={() => run(shell?.openBotEditor?.())}>
        <span className="ac__face" data-state={state}>{bot?.portrait ? <img src={bot.portrait} alt="" /> : <span aria-hidden="true">✿</span>}</span>
        <span className="ac__text">
          <span className="ac__name">{props.bot.name}<span className="ac__sig" aria-hidden="true">☘</span></span>
          <span className="ac__state"><i className="ac__dot" />{WORDS[state] ?? state}{bot?.credit ? <span className="ac__credit" title={bot.credit}> · {bot.credit}</span> : null}</span>
        </span>
      </button>
      <div className="ac__drag" aria-hidden="true" />
      {bot ? <span className="ac__chip" title={bot.model}>{bot.model.slice(bot.model.indexOf("/") + 1)}</span> : null}
      <div className="ac__group" role="toolbar" aria-label="Panels">
        <button type="button" className="ac__btn" aria-label="Details" title="Details" aria-pressed={open.has("session")} onClick={() => run(shell?.togglePanel?.("session"))}>{DETAILS}</button>
        <button type="button" className="ac__btn" aria-label="Browser" title="Browser" aria-pressed={open.has("browser")} onClick={() => run(shell?.togglePanel?.("browser"))}>{GLOBE}</button>
      </div>
    </div>
  );
}
