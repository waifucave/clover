// The middle column (spec §6.10): the selected bot's ONE conversation (item 106), its latest page first; scrolling up
// reads the pages before it from the engine (`bot.conversation`'s `before`), keeping the message under the eye in place. The person's bubbles on the right,
// the bot's on the left, a card per attached file, the cards the router placed in this conversation, and the composer
// ("Message <bot>") with attach and the microphone. The header has the bot's face, its name, its mood in words and the
// button that opens the side panel.
//
// Everything a bot wrote is plain text drawn as React text nodes (with line breaks kept by CSS), never parsed as markup:
// no `dangerouslySetInnerHTML`, no HTML from a message reaches the page.
import { memo, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Face, MoodWords } from "../faces/Face";
import { bridge, shortTime } from "../bridge";
import { CardFrame } from "../cards/CardFrame";
import type { BotRow, CardRow, Message, MossView } from "../../shared/view";
import { statusPhrase } from "../../shared/status-line";

/** How close to the top (in pixels) a scroll starts reading the page before. */
const OLDER_AT = 600;
/** Pages read in a row for one bubble at most, when the engine's pages hold no bubble (only tool events). */
const EMPTY_PAGES_MAX = 20;

export function Conversation(props: { bot: BotRow; cards: CardRow[]; strip?: ReactNode; panelOpen: boolean; onPanel: () => void; talk?: MossView["talk"] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "waiting">("loading");
  const [older, setOlder] = useState<"idle" | "loading" | "start">("idle");
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Where paging back goes on from (the engine's `before`), and whether anything is older. */
  const more = useRef<{ before?: number; hasMore: boolean; loading: boolean; gen: number }>({ hasMore: false, loading: false, gen: 0 });
  /** The scroll height and position before older messages went in above: the same message stays under the eye. */
  const anchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const lastId = useRef<string | undefined>(undefined);
  const id = props.bot.id;
  useEffect(() => {
    let live = true;
    const gen = more.current.gen + 1;
    more.current = { hasMore: false, loading: false, gen };
    anchor.current = undefined;
    lastId.current = undefined;
    setState("loading");
    setOlder("idle");
    setMessages([]);
    void bridge().conversation(id).then((page) => {
      if (!live) return;
      if ("waiting" in page) { setState("waiting"); return; }
      more.current = { ...(page.before !== undefined ? { before: page.before } : {}), hasMore: page.hasMore && page.before !== undefined, loading: false, gen };
      if (!more.current.hasMore) setOlder("start");
      setMessages((now) => merge(page.messages, now));
      setState("ready");
    });
    const off = bridge().onMessage((bot, m) => {
      if (bot !== id) return;
      setMessages((now) => now.some((x) => x.id === m.id) ? now : [...now, m]);
    });
    bridge().markRead(id);
    return () => { live = false; off(); };
  }, [id]);
  /** Reads the page before the oldest message shown and puts it in above, keeping the scroll where it was. */
  const loadOlder = async (): Promise<void> => {
    const m = more.current;
    if (m.loading || !m.hasMore || m.before === undefined) return;
    const gen = m.gen;
    m.loading = true;
    setOlder("loading");
    let before: number | undefined = m.before;
    let hasMore = true;
    let got: Message[] = [];
    for (let i = 0; i < EMPTY_PAGES_MAX && got.length === 0 && hasMore && before !== undefined; i++) {
      const page = await bridge().conversation(id, before);
      if (more.current.gen !== gen) return;
      if ("waiting" in page) break;
      got = [...page.messages, ...got];
      hasMore = page.hasMore && page.before !== undefined && page.before < before;
      before = page.before;
    }
    if (more.current.gen !== gen) return;
    const el = scroller.current;
    anchor.current = el !== null ? { height: el.scrollHeight, top: el.scrollTop } : undefined;
    more.current = { ...(before !== undefined ? { before } : {}), hasMore, loading: false, gen };
    setOlder(hasMore ? "idle" : "start");
    if (got.length > 0) setMessages((now) => merge(got, now));
    else anchor.current = undefined;
  };
  const onScroll = (): void => {
    const el = scroller.current;
    if (el !== null && el.scrollTop < OLDER_AT) void loadOlder();
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (el !== null && a !== undefined) {
      // Older messages went in above: the one that was under the eye stays there.
      anchor.current = undefined;
      el.scrollTop = el.scrollHeight - a.height + a.top;
    } else if (messages.at(-1)?.id !== lastId.current) {
      end.current?.scrollIntoView({ block: "end" });
    }
    lastId.current = messages.at(-1)?.id;
    // A first page too short to scroll can't be scrolled up: the next one is read at once.
    if (el !== null && el.clientHeight > 0 && el.scrollHeight <= el.clientHeight + OLDER_AT && more.current.hasMore) void loadOlder();
  }, [messages]);
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.cards.length]);
  // A card in this conversation grows to its own height once its frame has drawn: keep the end, with the card's
  // buttons, in view.
  // The status line: what the bot is doing while its turn runs. It goes when the turn ends (the feed leaves thinking and
  // working) or when a reply of the bot's arrives (MOSS gets a reply whole, not as it streams), and comes back the next
  // time the feed's state, tool or call changes.
  const bot = props.bot;
  const runKey = `${bot.mood}|${bot.tool ?? ""}|${bot.detail ?? ""}|${bot.title ?? ""}`;
  const runKeyRef = useRef(runKey);
  runKeyRef.current = runKey;
  const [replied, setReplied] = useState<string | undefined>(undefined);
  useEffect(() => {
    setReplied(undefined);
    return bridge().onMessage((b, m) => { if (b === id && m.from === "bot") setReplied(runKeyRef.current); });
  }, [id]);
  const phrase = replied === runKey ? undefined : statusPhrase({ state: bot.mood, ...(bot.tool !== undefined ? { tool: bot.tool } : {}), ...(bot.detail !== undefined ? { detail: bot.detail } : {}), ...(bot.title !== undefined ? { title: bot.title } : {}) });
  const showing = phrase !== undefined;
  useLayoutEffect(() => {
    if (showing) end.current?.scrollIntoView({ block: "end" });
  }, [showing]);
  const cardIds = props.cards.map((c) => c.id).join(",");
  useEffect(() => {
    if (cardIds === "") return;
    return bridge().onCardHeight((id) => {
      if (!cardIds.split(",").includes(id)) return;
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end" }));
    });
  }, [cardIds]);
  return (
    <main className="conversation" data-col="conversation" aria-label={`${props.bot.name}'s conversation`}>
      <header className="conversation__head">
        <Face name={props.bot.name} {...(props.bot.face !== undefined ? { face: props.bot.face } : {})} mood={props.bot.mood} size={36} surface="header" />
        <div className="conversation__who">
          <h1>{props.bot.name}</h1>
          <MoodWords mood={props.bot.mood} />
        </div>
        <button type="button" className={`icon-button${props.panelOpen ? " is-on" : ""}`} aria-label={props.panelOpen ? "Close the side panel" : `Open ${props.bot.name}'s screen and routines`} aria-pressed={props.panelOpen} onClick={props.onPanel}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
        </button>
      </header>
      {props.strip}
      <div className="messages" role="log" aria-live="polite" ref={scroller} onScroll={onScroll} data-older={older} data-count={messages.length}>
        {older === "loading" ? <p className="messages__note" data-older-loading>Reading earlier messages…</p> : null}
        {older === "start" && messages.length > 0 ? <p className="messages__note" data-conversation-start>The start of your conversation with {props.bot.name}.</p> : null}
        {state === "waiting" ? <p className="messages__note">Waiting for the engine to serve {props.bot.name}'s conversation.</p> : null}
        {state === "ready" && messages.length === 0 ? <p className="messages__note">Say hello to {props.bot.name}.</p> : null}
        {messages.map((m, i) => <Bubble key={m.id} m={m} showTime={i === messages.length - 1 || messages[i + 1]?.from !== m.from} {...(m.failed === true && i === messages.length - 1 ? { bot: props.bot.id } : {})} />)}
        {props.cards.map((c) => <CardFrame key={c.id} card={c} />)}
        {phrase !== undefined && props.cards.length === 0 ? <StatusLine phrase={phrase} /> : null}
        <div ref={end} />
      </div>
      <Composer bot={props.bot} {...(props.talk !== undefined ? { talk: props.talk } : {})} />
    </main>
  );
}

/** Older messages before the ones shown, each once (a message that came live while a page was read is not doubled). */
export function merge(older: readonly Message[], now: readonly Message[]): Message[] {
  if (older.length === 0) return now as Message[];
  const seen = new Set(now.map((m) => m.id));
  const add = older.filter((m) => !seen.has(m.id));
  return add.length === 0 ? (now as Message[]) : [...add, ...now];
}

/** One message; drawn again only when it or its neighbours' grouping changes, so a page put in above costs only its own. */
const Bubble = memo(function Bubble(props: { m: Message; showTime: boolean; /** The failed turn's note while it is the last thing: Try again. */ bot?: string }) {
  const m = props.m;
  if (m.from === "note" && props.bot !== undefined) return <FailedNote text={m.text} bot={props.bot} />;
  if (m.from === "note") return <p className={`note${m.routineFailed === true ? " note--failed" : ""}`} data-bubble="note" {...(m.routineFailed === true ? { "data-routine-failed": "" } : {})}>{m.text}</p>;
  return (
    <div className={`bubble-row bubble-row--${m.from}`}>
      {m.files?.map((f, i) => (
        <div key={`${f.name}-${i}`} className="attachment" data-attachment={f.kind}>
          <span className="attachment__icon" aria-hidden="true">
            <svg viewBox="0 0 20 20"><path d="M5 2.5h6.5L15 6v11.5H5z" /><path d="M11.5 2.5V6H15" /></svg>
          </span>
          <span className="attachment__text">
            <span className="attachment__name">{f.name}</span>
            <span className="attachment__kind">{kindOf(f.name)}</span>
          </span>
        </div>
      ))}
      {m.text !== "" ? <div className={`bubble bubble--${m.from}`} data-bubble={m.from}>{m.text}</div> : null}
      {props.showTime ? <span className="bubble__time">{shortTime(m.at)}</span> : null}
    </div>
  );
});

/** The status line: one line of plain words, a soft highlight moving across it. Not a control (no hover, no click, no
 *  focus stop); a polite live status for a screen reader, told at most once every few seconds, not on every change. */
function StatusLine(props: { phrase: string }) {
  const [told, setTold] = useState(props.phrase);
  const last = useRef(0);
  useEffect(() => {
    const t = setTimeout(() => { last.current = Date.now(); setTold(props.phrase); }, Math.max(0, last.current + 4_000 - Date.now()));
    return () => clearTimeout(t);
  }, [props.phrase]);
  return (
    <div className="status-line" data-status-line>
      <span className="status-line__text" aria-hidden="true" data-status-text>{props.phrase}</span>
      <span className="visually-hidden" role="status" aria-live="polite" data-status-told>{told}</span>
    </div>
  );
}

/** A file's kind from its name, in a word ("PDF", "Image", "File"). */
/** A failed turn's note with Try again: one press sends the same words once more; the button goes once they are sent
 *  (the next message is no longer this note). */
function FailedNote(props: { text: string; bot: string }) {
  const [state, setState] = useState<"ready" | "sending" | { why: string }>("ready");
  const again = async (): Promise<void> => {
    setState("sending");
    const r = await bridge().retry(props.bot);
    setState(r.ok ? "sending" : { why: r.why });
  };
  return (
    <div className="note note--failed" data-bubble="note" data-failed>
      <span>{props.text}</span>
      {state === "ready" ? <button type="button" className="text-button" data-try-again onClick={() => void again()}>Try again</button> : null}
      {state === "sending" ? <span className="muted" data-try-again-sending>Sending…</span> : null}
      {typeof state === "object" ? <span className="composer__why" role="status">{state.why}</span> : null}
    </div>
  );
}

export function kindOf(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toLowerCase();
  if (ext === undefined) return "File";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext)) return "Image";
  return ext.toUpperCase();
}

function Composer(props: { bot: BotRow; talk?: MossView["talk"] }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ id: string; name: string }[]>([]);
  const [why, setWhy] = useState<string | undefined>(undefined);
  const [holding, setHolding] = useState(false);
  const send = async (): Promise<void> => {
    const t = text.trim();
    if (t === "" && images.length === 0) return;
    const r = await bridge().send(props.bot.id, t, images.map((i) => i.id));
    if (r.ok) { setText(""); setImages([]); setWhy(undefined); } else setWhy(r.why);
  };
  const attach = async (): Promise<void> => {
    const got = await bridge().pickImages();
    if (got.length > 0) setImages((now) => [...now, ...got].slice(0, 4));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const release = (): void => {
    if (!holding) return;
    setHolding(false);
    bridge().talk("up");
  };
  // Something dropped on the composer: MOSS takes pictures only, through the attach button (main's own dialog, so their
  // bytes never pass through the window); a dropped file or picture is said so, plainly, and nothing is sent.
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const items = [...e.dataTransfer.files];
    if (items.length === 0) return;
    const pictures = items.every((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    setWhy(pictures ? "Dropping isn't supported yet: attach pictures with the paperclip." : "Files aren't supported yet: MOSS sends pictures only (PNG, JPEG or WebP), attached with the paperclip.");
  };
  return (
    <div className="composer" data-composer onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {why !== undefined ? <p className="composer__why" role="status">{why}</p> : null}
      {images.length > 0 ? (
        <div className="composer__files">
          {images.map((i) => (
            <span key={i.id} className="file-chip">
              {i.name}
              <button type="button" aria-label={`Remove ${i.name}`} onClick={() => setImages((now) => now.filter((x) => x.id !== i.id))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer__box">
        <button type="button" className="icon-button" aria-label="Attach pictures" title="Attach pictures" onClick={() => void attach()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.6-5.6a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.2 1.2 0 0 1-1.7-1.7L9.5 4.7" /></svg>
        </button>
        <textarea rows={1} placeholder={`Message ${props.bot.name}`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label={`Message ${props.bot.name}`} />
        <button
          type="button" className={`icon-button mic${holding ? " is-on" : ""}`} aria-label="Hold to talk" aria-pressed={holding}
          // Without a voice plugin's talk command the button stays, dimmed, and says why (voice.ts talkCommandOf).
          title={props.talk?.ready === false ? props.talk.why : "Hold to talk (Ctrl+Shift+Space)"} disabled={props.talk?.ready === false} data-talk={props.talk?.ready === false ? "none" : "ready"}
          onPointerDown={() => { setHolding(true); bridge().talk("down"); }} onPointerUp={release} onPointerLeave={release}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5" /><path d="M3.2 7.5a4.8 4.8 0 0 0 9.6 0M8 12.3v2" /></svg>
        </button>
        <button type="button" className="send" aria-label="Send" disabled={text.trim() === "" && images.length === 0} onClick={() => void send()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
}
