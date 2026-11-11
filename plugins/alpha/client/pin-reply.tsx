// The pin under each of Alpha's replies (her `ui` entry on the conversation's list spot `conversation.message.extra`,
// for her own bot only): pressing it hands the reply's text to her server (`host.call("pinReply")`), which pins its first
// sentence to her stage the way her `pin_note` tool pins a note; the user unpins it on the stage as ever. A small pin,
// the size and colour of the conversation's own copy and speak buttons; a refusal (her stage is full) shows in a word.
import { useEffect, useRef, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { pinnableText } from "./reply-item";

const CSS = `
html, body { background: transparent !important; margin: 0; }
.apin { display: inline-flex; align-items: center; gap: 6px; font: 12px/1.2 var(--clover-font-family, system-ui, sans-serif); color: var(--clover-color-text-muted, #655C7E); }
.apin__b { width: 30px; height: 28px; border-radius: 8px; display: grid; place-items: center; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
.apin__b:hover { background: var(--clover-color-control, rgba(127,127,127,.12)); }
.apin__b:focus-visible { outline: 2px solid var(--clover-color-accent, #7651DD); outline-offset: 1px; }
.apin__b svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.apin[data-state="pinned"] .apin__b { color: var(--clover-color-success, #1F7A5E); }
`;

export function AlphaPinReply({ props }: { props: { bot?: { id: string; name: string }; item?: unknown } }) {
  const api = usePluginApi();
  const [state, setState] = useState<"idle" | "busy" | "pinned" | "refused">("idle");
  const [said, setSaid] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const text = pinnableText(props.item);
  // Her own bot only (the manifest's `when.bot` says so too).
  if (props.bot?.id !== "alpha" || text === undefined) return null;
  const pin = async () => {
    if (state === "busy") return;
    setState("busy");
    const r = (await api.host.call("pinReply", { v: 1, text: text.slice(0, 20_000) }).catch(() => ({ ok: false, said: "Her stage couldn't take it just now." }))) as { ok?: unknown; said?: unknown };
    const ok = r?.ok === true;
    setState(ok ? "pinned" : "refused");
    setSaid(ok ? "Pinned to her stage" : typeof r?.said === "string" ? r.said : "Not pinned.");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setState("idle"); setSaid(""); }, ok ? 2_000 : 5_000);
  };
  return (
    <span className="apin" data-state={state}>
      <style>{CSS}</style>
      <button type="button" className="apin__b" title="Pin to her stage" aria-label="Pin this reply to Alpha's stage" disabled={state === "busy"} onClick={() => void pin()}>
        {state === "pinned"
          ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3H7l3-3z" /><path d="M12 12v8" /></svg>}
      </button>
      <span role="status" aria-live="polite">{state === "refused" ? said : state === "pinned" ? <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{said}</span> : null}</span>
    </span>
  );
}
