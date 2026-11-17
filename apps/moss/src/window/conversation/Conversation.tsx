// The middle column (spec §6.10): the selected bot's ONE conversation (item 106). The person's bubbles on the right,
// the bot's on the left, a card per attached file, the cards the router placed in this conversation, and the composer
// ("Message <bot>") with attach and the microphone. The header has the bot's face, its name, its mood in words and the
// button that opens the side panel.
//
// Everything a bot wrote is plain text drawn as React text nodes (with line breaks kept by CSS), never parsed as markup:
// no `dangerouslySetInnerHTML`, no HTML from a message reaches the page.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Face, MoodWords } from "../faces/Face";
import { bridge, shortTime } from "../bridge";
import { CardFrame } from "../cards/CardFrame";
import type { BotRow, CardRow, Message } from "../../shared/view";

export function Conversation(props: { bot: BotRow; cards: CardRow[]; strip?: ReactNode; panelOpen: boolean; onPanel: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "waiting">("loading");
  const end = useRef<HTMLDivElement>(null);
  const id = props.bot.id;
  useEffect(() => {
    let live = true;
    setState("loading");
    setMessages([]);
    void bridge().conversation(id).then((page) => {
      if (!live) return;
      if ("waiting" in page) { setState("waiting"); return; }
      setMessages(page.messages);
      setState("ready");
    });
    const off = bridge().onMessage((bot, m) => {
      if (bot !== id) return;
      setMessages((now) => now.some((x) => x.id === m.id) ? now : [...now, m]);
    });
    bridge().markRead(id);
    return () => { live = false; off(); };
  }, [id]);
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, props.cards.length]);
  return (
    <main className="conversation" data-col="conversation" aria-label={`${props.bot.name}'s conversation`}>
      <header className="conversation__head">
        <Face name={props.bot.name} {...(props.bot.face !== undefined ? { face: props.bot.face } : {})} mood={props.bot.mood} size={36} surface="header" />
        <div className="conversation__who">
          <h1>{props.bot.name}</h1>
          <MoodWords mood={props.bot.mood} {...(props.bot.tool !== undefined ? { tool: props.bot.tool } : {})} />
        </div>
        <button type="button" className={`icon-button${props.panelOpen ? " is-on" : ""}`} aria-label={props.panelOpen ? "Close the side panel" : `Open ${props.bot.name}'s screen and routines`} aria-pressed={props.panelOpen} onClick={props.onPanel}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
        </button>
      </header>
      {props.strip}
      <div className="messages" role="log" aria-live="polite">
        {state === "waiting" ? <p className="messages__note">Waiting for the engine to serve {props.bot.name}'s conversation.</p> : null}
        {state === "ready" && messages.length === 0 ? <p className="messages__note">Say hello to {props.bot.name}.</p> : null}
        {messages.map((m, i) => <Bubble key={m.id} m={m} showTime={i === messages.length - 1 || messages[i + 1]?.from !== m.from} />)}
        {props.cards.map((c) => <CardFrame key={c.id} card={c} />)}
        <div ref={end} />
      </div>
      <Composer bot={props.bot} />
    </main>
  );
}

function Bubble(props: { m: Message; showTime: boolean }) {
  const m = props.m;
  if (m.from === "note") return <p className="note" data-bubble="note">{m.text}</p>;
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
}

/** A file's kind from its name, in a word ("PDF", "Image", "File"). */
export function kindOf(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toLowerCase();
  if (ext === undefined) return "File";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext)) return "Image";
  return ext.toUpperCase();
}

function Composer(props: { bot: BotRow }) {
  const [text, setText] = useState("");
  const [why, setWhy] = useState<string | undefined>(undefined);
  const [holding, setHolding] = useState(false);
  const send = async (): Promise<void> => {
    const t = text.trim();
    if (t === "") return;
    const r = await bridge().send(props.bot.id, t);
    if (r.ok) { setText(""); setWhy(undefined); } else setWhy(r.why);
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
  return (
    <div className="composer" data-composer>
      {why !== undefined ? <p className="composer__why" role="status">{why}</p> : null}
      <div className="composer__box">
        <button type="button" className="icon-button" aria-label="Attach" title="Attach">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.6-5.6a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.2 1.2 0 0 1-1.7-1.7L9.5 4.7" /></svg>
        </button>
        <textarea rows={1} placeholder={`Message ${props.bot.name}`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label={`Message ${props.bot.name}`} />
        <button
          type="button" className={`icon-button mic${holding ? " is-on" : ""}`} aria-label="Hold to talk" title="Hold to talk (Ctrl+Shift+Space)" aria-pressed={holding}
          onPointerDown={() => { setHolding(true); bridge().talk("down"); }} onPointerUp={release} onPointerLeave={release}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5" /><path d="M3.2 7.5a4.8 4.8 0 0 0 9.6 0M8 12.3v2" /></svg>
        </button>
        <button type="button" className="send" aria-label="Send" disabled={text.trim() === ""} onClick={() => void send()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
}
