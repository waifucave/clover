// Alpha's own pieces of her tab, as a plugin's client components: her header (portrait, name, how she is, the model as a
// quiet chip) and the stage's side widgets (what she is doing now, a pinned note, today's tally). They read only
// through the plugin API (`bots`, `conversation`, her stage's store) and draw in the tab's own tokens, in her scene's two
// moods; nothing here is special-cased for Alpha by the app.
import { useEffect, useMemo, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { useStageState } from "./stage-store";
import { AlphaScene, DARK_SCENES } from "./backdrop";
export { AlphaScene };
const AlphaSceneInner = ({ bot }: { bot: BotRef }) => <AlphaScene props={{ bot }} />;

interface BotRef { id: string; name: string }
interface BotNow { name: string; portrait?: string; model: string; state: string; mainSession: string }

const FONT = 'var(--alpha-display, ui-rounded, "SF Pro Rounded", system-ui, sans-serif)';

const CSS = `
html, body { background: transparent !important; } body { margin: 0; font-family: var(--clover-font-family, system-ui, sans-serif); color: var(--clover-color-text, #221A33); -webkit-font-smoothing: antialiased; }
.ah { position: relative; z-index: 1; display: flex; align-items: center; gap: 14px; padding: 14px 22px 10px; min-height: 52px; box-sizing: border-box; }
.ah__face { width: 44px; height: 44px; border-radius: 50%; flex: none; position: relative; display: grid; place-items: center;
  background: radial-gradient(circle at 35% 30%, #fff, var(--clover-color-accent-soft, #EFE8FF)); box-shadow: 0 0 0 2px var(--clover-color-accent, #7651DD), 0 6px 18px -6px var(--clover-color-accent, #7651DD); overflow: hidden; }
.ah__face img { width: 100%; height: 100%; object-fit: cover; }
.ah__face[data-state="thinking"] { animation: ah-breathe 2.2s ease-in-out infinite; }
@keyframes ah-breathe { 0%,100% { box-shadow: 0 0 0 2px var(--clover-color-accent, #7651DD), 0 6px 18px -6px var(--clover-color-accent, #7651DD); } 50% { box-shadow: 0 0 0 5px var(--clover-color-accent-soft, #EFE8FF), 0 0 26px 2px var(--clover-color-accent, #7651DD); } }
.ah__name { font: 650 22px/1 ${FONT}; letter-spacing: -0.01em; display: flex; align-items: baseline; gap: 8px; }
.ah__sig { font-size: 15px; color: var(--clover-color-accent-text, #6A45D4); transform: translateY(-1px) rotate(-8deg); display: inline-block; }
.ah__state { font-size: 12.5px; color: var(--clover-color-text-muted, #655C7E); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
.ah__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--clover-color-success, #1F7A5E); }
.ah[data-state="thinking"] .ah__dot { background: var(--clover-color-accent, #7651DD); animation: ah-pulse 1.1s ease-in-out infinite; }
.ah[data-state="asleep"] .ah__dot, .ah[data-state="paused"] .ah__dot { background: var(--clover-color-text-placeholder, #766D90); }
@keyframes ah-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.7); } }
.ah[data-dark] .ah__name, .ah[data-dark] .ah__state { color: #F6F1FF; } .ah[data-dark] .ah__chip { color: #E9E2FB; background: rgba(255,255,255,.14); } .ah[data-dark] .ah__sig { color: #D9C8FF; }
.ah__fill { flex: 1; }
.ah__chip { font-size: 11.5px; padding: 4px 10px; border-radius: 999px; color: var(--clover-color-text-muted, #655C7E); background: var(--clover-color-control, #ECE5FA); letter-spacing: 0.01em; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .ah__face, .ah__dot { animation: none !important; } }

.aw { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 18px 4px 6px; box-sizing: border-box; }
.aw__card { flex: 1 1 150px; min-width: 0; border-radius: 18px; padding: 10px 14px 11px; box-sizing: border-box;
  background: var(--alpha-glass, color-mix(in srgb, var(--clover-color-float, #fff) 74%, transparent)); border: 1px solid var(--alpha-glass-edge, color-mix(in srgb, var(--clover-color-hairline-raised, #D9CEF0) 70%, transparent));
  box-shadow: 0 10px 30px -14px var(--alpha-shadow, rgba(70,40,140,.35)); }
.aw__card--wide { flex: 2 1 220px; }
.aw__label { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--clover-color-text-muted, #655C7E); display: flex; align-items: center; gap: 6px; }
.aw__live { width: 6px; height: 6px; border-radius: 50%; background: var(--clover-color-accent, #7651DD); animation: ah-pulse 1.2s ease-in-out infinite; }
.aw__now { font: 600 14px/1.25 ${FONT}; margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.aw__glyph { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; font-size: 14px; flex: none; background: var(--clover-color-accent-soft, #EFE8FF); color: var(--clover-color-accent-text, #6A45D4); }
.aw__sub { font-size: 12px; color: var(--clover-color-text-muted, #655C7E); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aw__bar { height: 4px; border-radius: 2px; background: var(--clover-color-control, #ECE5FA); margin-top: 8px; overflow: hidden; }
.aw__bar > i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--clover-color-accent, #7651DD), var(--clover-color-success, #1F7A5E)); }
.aw__note { font: italic 500 14px/1.35 var(--alpha-serif, ui-serif, "New York", Georgia, serif); margin-top: 6px; }
.aw__card--note { transform: rotate(var(--tilt, 0deg)); background: var(--alpha-glass, color-mix(in srgb, var(--clover-color-float, #fff) 74%, transparent)); border-left: 4px solid var(--clover-color-accent, #7651DD); animation: aw-pin .5s cubic-bezier(.2,1.4,.4,1) both; }
@keyframes aw-pin { from { transform: translateY(-10px) rotate(calc(var(--tilt, 0deg) * 3)); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .aw__card--note { animation: none; } }
.aw[data-dark] .aw__card { background: rgba(26,20,50,.62); border-color: rgba(255,255,255,.16); color: #F4EFFF; } .aw[data-dark] .aw__label, .aw[data-dark] .aw__sub, .aw[data-dark] .aw__tally span { color: #CFC5EA; } .aw[data-dark] .aw__note { color: #F4EFFF; } .aw[data-dark] .aw__glyph { background: rgba(255,255,255,.14); color: #E4D8FF; }
.aw__tally { display: flex; gap: 14px; margin-top: 6px; }
.aw__tally b { display: block; font: 650 19px/1 ${FONT}; }
.aw__tally span { font-size: 10.5px; color: var(--clover-color-text-muted, #655C7E); }
.aw__card[data-attention] { border-color: var(--clover-color-accent, #7651DD); box-shadow: 0 0 0 3px color-mix(in srgb, var(--clover-color-accent, #7651DD) 22%, transparent), 0 10px 30px -14px var(--alpha-shadow, rgba(70,40,140,.35)); }
`;

function useStyle() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.append(el);
    return () => el.remove();
  }, []);
}

function useBot(ref: BotRef): BotNow | undefined {
  const api = usePluginApi();
  const [bot, setBot] = useState<BotNow | undefined>();
  useEffect(() => {
    let live = true;
    const take = (b: any) => live && setBot({ name: b.name, portrait: b.portrait, model: b.model, state: b.state, mainSession: b.mainSession });
    void api.bots?.get(ref.id).then(take, () => undefined);
    const stop = api.bots?.watch((b: any) => { if (b.id === ref.id) take(b); });
    return () => { live = false; stop?.(); };
  }, [api, ref.id]);
  return bot;
}

const STATE_WORDS: Record<string, string> = { idle: "Here with you", thinking: "Thinking it over", asleep: "Asleep on another computer", paused: "Paused" };

export function AlphaHeader({ props }: { props: { bot: BotRef } }) {
  useStyle();
  const bot = useBot(props.bot);
  const state = bot?.state ?? "idle";
  const stage = useStageState();
  return (
    <>
    <AlphaSceneInner bot={props.bot} />
    <header className="ah" data-state={state} data-dark={DARK_SCENES.has(stage.scene) || undefined}>
      <div className="ah__face" data-state={state}>{bot?.portrait ? <img src={bot.portrait} alt="" /> : <span aria-hidden="true">✿</span>}</div>
      <div>
        <div className="ah__name">{props.bot.name}<span className="ah__sig" aria-hidden="true">☘</span></div>
        <div className="ah__state"><span className="ah__dot" />{STATE_WORDS[state] ?? state}</div>
      </div>
      <div className="ah__fill" />
      {bot ? <span className="ah__chip" title={bot.model}>{bot.model.slice(bot.model.indexOf("/") + 1)}</span> : null}
    </header>
    </>
  );
}

interface Seen { tool?: { name: string; detail: string; status: string; title?: string }; tools: number; replies: number; waiting: boolean; files: number }

const GLYPH: Record<string, string> = { write: "✎", edit: "✎", read: "❒", bash: "›_", websearch: "⌕", webfetch: "⤓", agent: "✦" };
const NOW: Record<string, string> = { write: "Writing", edit: "Editing", read: "Reading", bash: "Running a command", websearch: "Searching the web", webfetch: "Reading a page", agent: "Handing off" };
const kind = (n: string) => (/^mcp__[a-z0-9-]+__(.+)$/.exec(n)?.[1] ?? n).toLowerCase();

function foldEvents(events: Record<string, unknown>[]): Seen {
  const seen: Seen = { tools: 0, replies: 0, waiting: false, files: 0 };
  const pending = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "tool_call": {
        seen.tools++;
        let detail = "";
        try { const a = JSON.parse(String(e.argsJson ?? "{}")); detail = String(a.file_path ?? a.command ?? a.query ?? a.url ?? "").split("/").slice(-2).join("/"); } catch { /* none */ }
        // A title only from her own plugin's tools (here it is her own widget); another plugin's never stands in for Clover's wording.
        const own = /^mcp__alpha(-[a-z0-9-]+)?__/.test(String(e.name ?? ""));
        const title = own && typeof e.displayTitle === "string" ? e.displayTitle.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 60) : "";
        seen.tool = { name: kind(String(e.name ?? "")), detail, status: "running", ...(title ? { title } : {}) };
        break;
      }
      case "tool_result":
        if (seen.tool) seen.tool.status = e.isError === true ? "failed" : "done";
        if (e.fileDiff) seen.files++;
        break;
      case "assistant_message": seen.replies++; break;
      case "card_pending": case "card_requested": pending.add(String((e.card as any)?.id ?? "")); break;
      case "card_resolved": pending.delete(String((e.cardId ?? (e.card as any)?.id) ?? "")); break;
      case "turn_completed": if (seen.tool?.status === "running") seen.tool.status = "done"; break;
    }
  }
  seen.waiting = pending.size > 0;
  return seen;
}

export function AlphaWidgets({ props }: { props: { bot: BotRef } }) {
  useStyle();
  const api = usePluginApi();
  const bot = useBot(props.bot);
  const [seen, setSeen] = useState<Seen>({ tools: 0, replies: 0, waiting: false, files: 0 });
  const stage = useStageState();
  const session = bot?.mainSession;
  useEffect(() => {
    if (!session) return;
    let live = true;
    const all: Record<string, unknown>[] = [];
    const refresh = () => live && setSeen(foldEvents(all));
    void api.conversation.history(session, { limit: 300 }).then((h: any) => { all.push(...(h.events as Record<string, unknown>[]).slice().sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))); refresh(); }, () => undefined);
    const stop = api.conversation.follow(session, (e: Record<string, unknown>) => { all.push(e); refresh(); });
    return () => { live = false; stop(); };
  }, [api, session]);
  const tool = seen.tool;
  const running = bot?.state === "thinking" || tool?.status === "running";
  const now = useMemo(() => {
    if (seen.waiting) return { glyph: "✋", title: "Waiting for you", sub: "I need a yes before I go on" };
    const act = stage.activity;
    if (act?.kind === "celebrate") return { glyph: "✿", title: "Celebrating", sub: "That went well" };
    if (tool && running) return { glyph: GLYPH[tool.name] ?? "✦", title: tool.title ?? NOW[tool.name] ?? `Using ${tool.name.replace(/_+/g, " ")}`, sub: tool.detail || "" };
    if (act?.kind === "thinking") return { glyph: "…", title: "Thinking it over", sub: "" };
    if (act?.kind === "tool") return { glyph: "✦", title: "Working", sub: act.label };
    if (tool?.status === "failed") return { glyph: "!", title: "That one did not work", sub: tool.detail };
    if (tool) return { glyph: "✓", title: "All caught up", sub: `Last: ${(NOW[tool.name] ?? tool.name).toLowerCase()} ${tool.detail}`.trim() };
    return { glyph: "☘", title: "Ready when you are", sub: "Ask me anything" };
  }, [seen, tool, running, stage.activity]);
  const day = stage.tally;
  const counts = { replies: day?.turns ?? seen.replies, tools: day?.tools ?? seen.tools };
  return (
    <aside className="aw" aria-label="Alpha, live" data-mood={stage.mood} data-dark={DARK_SCENES.has(stage.scene) || undefined}>
      <div className="aw__card aw__card--wide" data-attention={seen.waiting || undefined}>
        <div className="aw__label">{running || seen.waiting ? <span className="aw__live" /> : null}Right now</div>
        <div className="aw__now"><span className="aw__glyph" aria-hidden="true">{now.glyph}</span><span>{now.title}</span></div>
        {now.sub ? <div className="aw__sub">{now.sub}</div> : null}
        {running ? <div className="aw__bar" aria-hidden="true"><i style={{ width: "62%" }} /></div> : null}
      </div>
      {stage.pinned.map((p, i) => (
        <div key={p.id} className="aw__card aw__card--wide aw__card--note" style={{ ["--tilt" as string]: `${i % 2 === 0 ? -0.8 : 0.9}deg` }}>
          <div className="aw__label"><span aria-hidden="true">✎</span>Pinned</div><div className="aw__note">{p.text}</div>
        </div>
      ))}
      <div className="aw__card">
        <div className="aw__label">Today</div>
        <div className="aw__tally"><div><b>{counts.replies}</b><span>replies</span></div><div><b>{counts.tools}</b><span>tool calls</span></div><div><b>{seen.files}</b><span>files touched</span></div></div>
      </div>
    </aside>
  );
}
