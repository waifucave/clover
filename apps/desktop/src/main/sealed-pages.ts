/** What a sealed frame's own page says. Each card's field and each button is a frame of its own from the app's sealed
 *  scheme (`clover-sealed://<card id>/<element>?<token>`, spec §5.5): the field inside it is the field's text in the
 *  part's own `card.*` tokens, or a button with the card's own label. The page carries everything the user sees; the
 *  plugin's page carries the frames alone, and what it says next to them is the plugin's own words, on its own OK.
 *  An escaped control character and a bidirectional mark show as visible escapes (§5.5 "Wherever a sealed field is
 *  drawn"), and a field too long for its space is offered by the frame's own scroll, never cut silently. Pure: the
 *  tests drive all of it under Bun.
 *
 * What may never be here: a plugin's own text next to the sealed words, a field's content in a script, or an
 * identifier another frame could use (the token is the frame's own; the scheme's other requests carry it in the URL,
 * where a parsable page sees only its own). */

import type { TokenValue } from "@waifucave/clover-plugin-sdk";
import type { SealedValue } from "./sealed";
import type { CardSummary, PreviewBlock } from "./card-summary";

/** The card's own tokens as the page's custom properties: `card.*` alone (§5.5 "sealed frames take only these"), and
 *  only values of the kinds the catalog lets a card take. Anything else — tags, `/*` comments, `url(`/`var(`, values
 *  with `;`, `!important` — is dropped: a value goes in, no other CSS does (S1's fix). */
function tokenCss(tokens: Readonly<Record<string, TokenValue>> | undefined): string {
  if (tokens === undefined) return "";
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(tokens)) {
    if (!name.startsWith("card.") || !/^card\.[a-z0-9.]*[a-z0-9]$/.test(name)) continue;
    if (typeof raw !== "string" || raw === "" || raw.length > 400) continue;
    const value = cssSafe(raw);
    if (value === undefined) continue;
    lines.push(`  --clover-${name.replaceAll(".", "-")}: ${value};`);
  }
  return lines.length === 0 ? "" : `:root {\n${lines.join("\n")}\n}\n`;
}

const FONT_VALUE_ALLOWED = /^[a-z0-9"' ,_-]+$/i;

/** A token's value stays what the store said: one grammar's run (a colour, a measure, a simple name), escaped's only
 *  quotes out; anything whose shape is anything else (a `;`, a `-movement`, a `url(`, a `var(` — those are CSS that
 *  isn't the property's own) never lands. */
function cssSafe(text: string): string | undefined {
  if (text.includes(";") || text.includes("/*") || text.includes("!") || text.includes("$") || text.includes("`")) return undefined;
  if (/\burl\s*\(|\bvar\s*\(|\battr\s*\(|\bimage-|@|\\/i.test(text)) return undefined;
  if (/^(?:\.\d|\d+%?)(?:e-?\d+)?%?$|^\d*(?:\.\d+)?(?:px|em|rem|ch|sq|vh|vw|vmin|vmax|s|ms|deg|grad|rad|fr|turn)$/i.test(text.trim())) return text.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
  if (/^(?:rgba?|hsla?)\(\s*[-+0-9.,%\s/]+\)$/i.test(text)) return text;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(text)) return text;
  if (FONT_VALUE_ALLOWED.test(text)) return text;
  return undefined;
}

/** The sealed text at one line's length: control characters and bidirectional marks visible as their escapes. The
 *  set is the core's own (`http-read.ts`: C0 and C1 controls but tab, newline and carriage return, the bidi marks and
 *  overrides, U+061C), plus U+2028 and U+2029 — never Hebrew (0x0590-0x05FF), never dashes, curly quotes, bullets or
 *  the ellipsis (U+2010-2027). */
export function sealedEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x2028 || code === 0x2029) {
      out += `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

/** A text field's HTML: its lines in a block that scrolls inside the part's size, in the part's own typography. */
export function fieldPage(input: { cardId: string; token: string; field: string; value: SealedValue; tokens?: Readonly<Record<string, TokenValue>> }): string {
  const body = (() => {
    if (input.value.type === "text") return `<p class="text">${esc(sealedEscape(input.value.text))}</p>`;
    if (input.value.type === "code") return `<pre class="code"><code>${esc(sealedEscape(input.value.code))}</code></pre>`;
    if (input.value.type === "list") return `<ul class="list">${input.value.items.map((i) => `<li>${esc(sealedEscape(i))}</li>`).join("")}</ul>`;
    return `<dl class="rows">${input.value.rows.map((r) => `<dt>${esc(sealedEscape(r.label))}</dt><dd>${esc(sealedEscape(r.value))}</dd>`).join("")}</dl>`;
  })();
  return page(input, body, `seal-${input.field}`, true, SIZE_SCRIPT);
}

/** A field page tells its own frame how tall its words are (`postMessage`, numbers only), so the part's frame fits the
 *  words and nothing sealed is cut unseen; the document that placed the frame learns a size, never a word. */
const SIZE_SCRIPT = `(() => {
  const send = () => { try { parent.postMessage({ cloverSealedSize: { height: Math.ceil(document.body.getBoundingClientRect().height) } }, "*"); } catch (e) { /* no parent */ } };
  addEventListener("DOMContentLoaded", () => { new ResizeObserver(send).observe(document.body); send(); });
  addEventListener("load", send);
})();`;

/** What the app says about a tool card in a line (`field:summary`) or a short preview (`field:preview`), composed from
 *  the card's own sealed fields (card-summary.ts) and drawn here, in the card's tokens, like any sealed field. */
export function summaryFieldPage(input: { cardId: string; token: string; field: "summary" | "preview"; summary: CardSummary; tokens?: Readonly<Record<string, TokenValue>> }): string {
  const body = input.field === "summary" ? `<p class="ask">${askHtml(input.summary)}</p>` : previewHtml(input.summary);
  return page(input, body, `seal-${input.field}`, true, SIZE_SCRIPT);
}

/** "Alpha wants to edit story.md in Downloads": the file and the place set apart, every word escaped. */
export function askHtml(s: CardSummary): string {
  const e = (t: string) => esc(sealedEscape(t));
  return `<span class="by">${e(s.who)}</span> wants to ${e(s.verb)}${s.target !== undefined ? ` <b class="target">${e(s.target)}</b>` : ""}${s.where !== undefined ? ` in <span class="where">${e(s.where)}</span>` : ""}${s.note !== undefined ? ` <span class="note">${e(s.note)}</span>` : ""}`;
}

/** A preview's block: a small diff with real line breaks, a command, the start of a file or a few rows. Where it leaves
 *  something out it says so, in its own line; the card's "show everything" holds the rest. */
export function previewHtml(s: CardSummary): string {
  const p = s.preview;
  if (p === undefined) return "";
  const e = (t: string) => esc(sealedEscape(t));
  const more = (n: number, what: string) => (n > 0 ? `<p class="more">… ${n} more ${what}${n === 1 ? "" : "s"}</p>` : "");
  const shortened = s.shortened ? `<p class="more shortened">Shortened here. Show everything to see all of it before you decide.</p>` : "";
  const block = ((): string => {
    switch (p.kind) {
      case "diff": {
        const lines = [
          ...p.removed.map((l) => `<div class="line del"><span class="sign">−</span><span class="text">${e(l)}</span></div>`),
          ...p.added.map((l) => `<div class="line add"><span class="sign">+</span><span class="text">${e(l)}</span></div>`),
        ].join("");
        const extra = more(p.hiddenRemoved, "removed line") + more(p.hiddenAdded, "added line");
        const edits = p.edits !== undefined && p.edits > 1 ? `<p class="more">The first of ${p.edits} changes. ${p.edits - 1} more in everything below.</p>` : "";
        return `<div class="diff" role="group" aria-label="The change">${lines || `<p class="more">Nothing is replaced.</p>`}</div>${extra}${edits}`;
      }
      case "lines": {
        const label = p.label !== undefined ? `<p class="label-line">${e(p.label)}</p>` : "";
        const lines = p.lines.map((l) => `<div class="line"><span class="text">${e(l)}</span></div>`).join("");
        return `${label}<div class="${p.mono ? "codeblock" : "plainblock"}">${lines}</div>${more(p.hidden, "line")}`;
      }
      case "rows": {
        const rows = p.rows.map((r) => `<div class="row"><span class="k">${e(r.label)}</span><span class="v">${e(r.value)}</span></div>`).join("");
        return `<div class="rowsblock">${rows}</div>${more(p.hidden, "more field")}`;
      }
    }
  })();
  return `${block}${shortened}`;
}

/** A button's page: the card's own label (its kind's option), with the glyph only as the core draws it, and the
 *  answer's proof path through the preload — never a script of the part's own. Its click counts only while the whole
 *  button shows, uncovered, at its own visible size (IOv2 in the page; S4's run of it keeps the count honest), and
 *  the answer passes the option (B1: plain JS, the button's own dataset). Nothing in production relaxes `isTrusted`
 *  or the open-delay: a trusted press from the real input path is the only way an answer leaves this page. */
export function buttonPage(input: { cardId: string; token: string; option: string; label: string; kind: "approve" | "deny"; look?: "label" | "check" | "cross" | "open"; remember?: "always"; tokens?: Readonly<Record<string, TokenValue>> }): string {
  const glyph = input.look !== undefined && input.look !== "label" ? GLYPHS[input.look] : undefined;
  const body = `<button type="button" class="seal-button${glyph !== undefined ? " glyph" : ""}${input.remember === "always" ? " quiet" : ""}" data-option="${esc(input.option)}" data-kind="${esc(input.kind)}" aria-label="${esc(sealedEscape(input.label))}">${glyph ?? ""}
  <span class="label">${esc(sealedEscape(input.label))}</span>
</button>
<p class="state" data-state="waiting" role="status"></p>`;
  const script = `(() => {
  const b = window.cloverSealed;
  if (b === undefined) return;
  let answering = false;
  // The whole button, uncovered (IOv2), since enough time to have been seen (S4).
  let visible = false;
  let visibleAt = 0;
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    if (e === undefined) return;
    const whole = e.intersectionRatio >= 1;
    const enough = e.target instanceof HTMLElement && e.target.getBoundingClientRect().width >= 24 && e.target.getBoundingClientRect().height >= 24;
    const seen = whole === true && e.isVisible === true && enough === true;
    if (seen && !visible) visibleAt = Date.now();
    visible = seen;
    // Report visibility to the main process so it can disarm the fallback once all of a card's buttons show (S1).
    if (b !== undefined) b.visible?.(seen);
  }, { threshold: [0, 0.25, 0.5, 0.75, 1], trackVisibility: true, delay: 200 });
  window.addEventListener("DOMContentLoaded", () => {
    const b2 = document.querySelector(".seal-button");
    if (b2 !== null) io.observe(b2);
  });
  // The button's own size, for a part that gives a labelled button the room it takes (numbers only).
  const send = () => { const r = document.querySelector(".seal-button"); if (r === null) return; const q = r.getBoundingClientRect(); try { parent.postMessage({ cloverSealedSize: { width: Math.ceil(q.width), height: Math.ceil(q.height) } }, "*"); } catch (e) { /* no parent */ } };
  window.addEventListener("DOMContentLoaded", send);
  window.addEventListener("load", send);
  // A click inside the button only, the renderer's own handed-over press (a page's own dispatch's isTrusted reads
  // false), after enough time visible and a beat after the page was shown. isTrusted and the 400 ms open-delay are
  // never relaxed: only a real input event from Chromium's own input path counts.
  const openedAt = Date.now();
  window.addEventListener("pointerdown", (e) => {
    if (answering || !visible) return;
    if (!e.isTrusted) return;
    const closest = e.target instanceof Element ? e.target.closest(".seal-button") : null;
    if (closest === null) return;
    if (Date.now() - openedAt < 400) return;
    if (Date.now() - visibleAt < 500) return;
    const option = closest ? closest.dataset.option : null;
    if (typeof option !== "string" || option === "") return;
    answering = true;
    const state = document.querySelector(".state");
    if (state !== null) state.textContent = "…";
    document.body.dataset.answering = "yes";
    // A refused answer says so on the card and the button answers again: never a "…" that stays.
    const refused = (r) => { answering = false; document.body.dataset.answered = "no"; delete document.body.dataset.answering; const said = r !== null && typeof r === "object" && r.key === "changed" ? ${JSON.stringify(KEY_CHANGED_TEXT)} : r !== null && typeof r === "object" && r.key === "fault" ? ${JSON.stringify(KEY_FAULT_TEXT)} : ${JSON.stringify(REFUSED_TEXT)}; if (state !== null) state.textContent = said; closest.title = said; };
    b.answer(option).then((r) => {
      if (r !== null && typeof r === "object" && r.accepted === true) { document.body.dataset.answered = "yes"; delete document.body.dataset.answering; answering = false; if (state !== null) state.textContent = ""; }
      else refused(r);
    }).catch(() => refused(null));
  }, { capture: true });
})();`;
  return page({ ...input, tokens: input.tokens }, body, input.kind === "approve" ? "seal-approve" : "seal-deny", true, script);
}

/** A glyph button's mark, drawn by the core: ✓ approves, ✕ denies, ↗ opens a link. */
const GLYPHS = {
  check: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.6l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  open: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
} as const;

/** The app's own fallback card (§5.5): the whole card in one page of the app's own, so a card the parts never placed
 *  stands before the user in 2 seconds or none. A tool call says in one line who wants to do what to what, a short
 *  preview of the change, and its buttons; the whole of what the card holds (every sealed field, verbatim) is one
 *  press away under "Show everything this approves", and a preview that leaves anything out says so. Any other card
 *  shows its fields in the core's own order. The buttons' answers ride the same frame channel as a part's
 *  (`clover:sealed-answer`), minted per option with the `own` element, and their own gates ride this page's checks
 *  (S3's fix: a beat after shown, a trusted press in the button, and about the same visible-and-uncovered run). */
export function ownCardPage(input: {
  cardId: string; token: string; origin: string; issuedAt: number; expiresAt: number | null;
  fields: Readonly<Record<string, unknown>>;
  tokens?: Readonly<Record<string, TokenValue>>;
  options: readonly { id: string; kind: "approve" | "deny"; label: unknown; remember?: "always" }[];
  who?: { bot?: string; pluginId?: string };
  /** What the app says of a tool call in a line and a preview (card-summary.ts); absent for any other card. */
  summary?: CardSummary;
  computer?: string | null;
}): string {
  // The fields in the core's own order (§5.5), read at once.
  const fields = CARD_FIELD_ORDER.filter((name) => {
    const v = input.fields[name] as SealedValue | undefined;
    return v !== undefined && typeof v === "object" && typeof v.type === "string";
  });
  const bits = fields.map((name) => {
    const value = input.fields[name] as SealedValue;
    const sealedNow = (text: string): string => sealedEscape(text);
    const body = value.type === "text"
      ? `<p class="text">${esc(sealedNow(value.text))}</p>`
      : value.type === "code"
        ? `<pre class="code"><code>${esc(sealedNow(value.code))}</code></pre>`
        : value.type === "list"
          ? `<ul class="list">${value.items.map((i) => `<li>${esc(sealedNow(i))}</li>`).join("")}</ul>`
          : `<dl class="rows">${value.rows.map((r) => `<dt>${esc(sealedNow(r.label))}</dt><dd>${esc(sealedNow(r.value))}</dd>`).join("")}</dl>`;
    return `<section class="field" data-name="${esc(name)}"><h3 class="fname">${esc(FIELD_TITLES[name] ?? name)}</h3>${body}</section>`;
  }).join("\n");
  // Deny first, then an "always" approve, then the plain approve last, where the eye ends.
  const ordered = [
    ...input.options.filter((o) => o.kind === "deny"),
    ...input.options.filter((o) => o.kind === "approve" && o.remember === "always"),
    ...input.options.filter((o) => o.kind === "approve" && o.remember !== "always"),
  ];
  const buttons = ordered.map((o) => `<button type="button" class="seal-button" data-option="${esc(o.id)}" data-kind="${esc(o.kind)}"${o.remember === "always" ? ' data-remember="always"' : ""}><span class="label">${esc(sealedEscape(labelOf(o.label)))}</span></button>`).join("\n");
  // The card's own who: a plugin's own asking with its name, a bot's with its name, else the core's (the words are
  // said by the core's own strings — the page's own type carries what its table holds). The page's own footer holds
  // what a plugin's own strip would: the asking's own source (§5.5's `source` field rides the card's own table),
  // and the expiry the card says (a turn the user didn't start: denied after, the app's own text).
  // The asking's own who: the card's `source` field says so (a plugin with its id and source; a bot's own). A page's
  // own footer carries it, in the core's own table's words.
  const source = input.fields.source as { type: "text"; text: string } | undefined;
  const who = typeof source?.text === "string" ? input.who?.bot ?? input.who?.pluginId : undefined;
  const footnote = who === undefined ? "" : `<p class="who" data-who="${esc(input.who?.bot !== undefined ? "bot" : "plugin")}">${esc(sealedEscape(who))}</p>`;
  const titleField = input.fields.title as SealedValue | undefined;
  const title = titleField?.type === "text" ? titleField.text : undefined;
  const sub = [title, input.computer ?? undefined].filter((t): t is string => typeof t === "string" && t !== "").map((t) => esc(sealedEscape(t))).join(" · ");
  const head = input.summary !== undefined
    ? `<p class="ask">${askHtml(input.summary)}</p>${sub === "" ? "" : `<p class="sub">${sub}</p>`}`
    : `<p class="ask">${title !== undefined ? esc(sealedEscape(title)) : "A request"}</p>${input.computer ? `<p class="sub">${esc(sealedEscape(input.computer))}</p>` : ""}`;
  // A summarised card keeps its fields behind one control; any other card shows them.
  const all = input.summary !== undefined
    ? `<details class="all"><summary>Show everything this approves</summary>\n${bits}\n</details>`
    : bits;
  const preview = input.summary !== undefined ? previewHtml(input.summary) : "";
  const script = `(() => {
  const b = window.cloverSealed;
  if (b === undefined) return;
  // About a second after the page is shown (showInactive): the 1 s wait restarts when the window is shown or moved,
  // never on mouse movement, and the pointer must have entered the window after it showed, so a timed "click here"
  // prompt can't land on Approve (S3, check 3). The page is placed before it is shown, so shown is load time here.
  // It restarts too when the card's own layout moves (its "show everything" opened or closed, the window resized), so
  // a button never lands under the pointer a moment after the page moved it there.
  let openedAt = Date.now();
  let pointerEntered = false;
  const moved = () => { openedAt = Date.now(); };
  document.addEventListener("toggle", moved, true);
  window.addEventListener("resize", moved);
  document.addEventListener("pointerover", () => { pointerEntered = true; }, { once: true, passive: true });
  document.addEventListener("mouseover", () => { pointerEntered = true; }, { once: true, passive: true });
  // The page's own height, for the window that holds it (numbers only).
  const size = () => { try { b.size?.(Math.ceil(document.documentElement.scrollHeight)); } catch (e) { /* no window to tell */ } };
  addEventListener("DOMContentLoaded", () => { new ResizeObserver(size).observe(document.body); size(); });
  addEventListener("load", size);
  document.addEventListener("click", (e) => {
    if (!pointerEntered) return;
    if (Date.now() - openedAt < 1000) return;
    if (!e.isTrusted) return;
    const b2 = e.target !== null && e.target instanceof Element ? e.target.closest(".seal-button") : null;
    if (b2 === null) return;
    e.preventDefault();
    const state = document.querySelector(".state");
    if (state !== null) state.textContent = "…";
    // A refused answer says so on the card, and its buttons answer again.
    const refused = (r) => { document.body.dataset.answered = "no"; if (state !== null) state.textContent = r !== null && typeof r === "object" && r.key === "changed" ? ${JSON.stringify(KEY_CHANGED_TEXT)} : r !== null && typeof r === "object" && r.key === "fault" ? ${JSON.stringify(KEY_FAULT_TEXT)} : ${JSON.stringify(REFUSED_TEXT)}; };
    void b.answer(b2.dataset.option).then((r) => {
      if (r !== null && typeof r === "object" && r.accepted === true) { document.body.dataset.answered = "yes"; if (state !== null) state.textContent = ""; }
      else refused(r);
    }).catch(() => refused(null));
  }, { capture: true });
})();`;
  return page({ cardId: input.cardId, token: input.token, tokens: input.tokens }, `<main class="own">
<header class="own-head">${SHIELD}<div class="own-words">${head}</div></header>
${preview}
${all}
<div class="own-foot"><div class="buttons">${buttons}</div>
<p class="state" data-state="waiting" role="status"></p>${footnote}</div>
</main>`, "seal-own", true, script);
}

/** The words that head each sealed field on the card's own page. */
const FIELD_TITLES: Record<string, string> = {
  title: "What", what: "Tool", command: "Command", computer: "Computer", risk: "Risk", reason: "Why", source: "From", host: "Site",
  paths: "Files", detail: "Everything it sends", expires: "Expires",
};

const SHIELD = `<svg class="shield" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M8 1.5l5 1.8v4.2c0 3-2.1 5.2-5 6.5-2.9-1.3-5-3.5-5-6.5V3.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/** What a card says when its answer didn't go through (the core refused it, or this desktop's answer key isn't
 *  registered yet): the card stays, and its buttons answer again. */
export const REFUSED_TEXT = "Couldn't confirm — try again.";

/** What a card says when Clover holds a different answer key for this desktop than the app has (one made by an
 *  earlier build or another app on this home): trying again can't help, so the card doesn't ask for it. */
export const KEY_CHANGED_TEXT = "Couldn't confirm: this computer's answer key isn't the one Clover has for it, so answers from here can't be checked.";

/** What a card says when Clover couldn't take this desktop's answer key at all (its answers told nothing, again and
 *  again): reconnecting starts a fresh registration, so the card says that may help. */
export const KEY_FAULT_TEXT = "Couldn't confirm: Clover couldn't take this computer's key. Reconnecting may help: a reconnect registers it again.";

/** The fields in B's own order (§5.5), read at once. */
export const CARD_FIELD_ORDER = ["title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires"] as const;

function page(input: { cardId: string; token: string; tokens?: Readonly<Record<string, TokenValue>> }, body: string, extraClass: string, script = false, extra = ""): string {
  const style = tokenCss(input.tokens);
  return `<!doctype html>
<html lang="en" class="${extraClass}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
${style === "" ? "" : `<style>${style}</style>`}
<style>${PAGE_CSS}</style>
${script ? `<script>${extra}</script>` : ""}
</head>
<body data-token="${esc(input.token)}">
${body}
</body>
</html>
`;
}

/** The sealed pages' look: the card's own tokens first (a part's), then Clover's own base theme (light and dark) where
 *  a token is not given, so a frame or the fallback card reads like the rest of the app. A diff's colours are the text
 *  colour mixed toward the mark's own, so they hold on the island's black as on a window's white. */
const PAGE_CSS = `
:root {
  color-scheme: light dark;
  --seal-surface: #FFFFFF; --seal-raised: #F7F7F7; --seal-hairline: #DCDCDC; --seal-text: #1F1F1F; --seal-muted: #6B6B6B;
  --seal-control: #EDEDED; --seal-accent: #4180E3; --seal-accent-text: #FFFFFF;
  --seal-mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --seal-surface: #202020; --seal-raised: #2A2A2A; --seal-hairline: #3F3F3F; --seal-text: #F2F2F2; --seal-muted: #9E9E9E; --seal-control: #3B3B3B; }
}
html, body { margin: 0; background: transparent; }
body {
  font-family: var(--clover-card-font-family, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", "Noto Sans", Ubuntu, Cantarell, sans-serif);
  font-size: var(--clover-card-font-size, 14px);
  line-height: 1.38;
  color: var(--clover-card-text, var(--seal-text));
  padding: 0;
  overflow-wrap: anywhere;
}
.text { margin: 0 }
.code { margin: 0; overflow: auto; white-space: pre-wrap; font-family: var(--seal-mono); font-size: 0.93em }
.list, .rows { margin: 0; padding-inline-start: 1.2em }
.ask { margin: 0; font-weight: 600 }
.ask .target { font-weight: 700 }
.ask .by { font-weight: 700 }
.ask .where, .ask .note { color: var(--clover-card-muted, var(--seal-muted)); font-weight: 500 }
.diff, .codeblock, .plainblock, .rowsblock { margin: 0; font-family: var(--seal-mono); font-size: 0.93em; line-height: 1.45; border-radius: 8px; padding: 6px 8px; background: color-mix(in srgb, var(--clover-card-text, var(--seal-text)) 8%, transparent); }
.plainblock { font-family: inherit }
.line { display: flex; gap: 6px; white-space: pre-wrap; overflow-wrap: anywhere }
.line .sign { flex: none; width: 1ch; opacity: 0.8 }
.line.del { color: color-mix(in srgb, var(--clover-card-text, var(--seal-text)) 45%, #E5484D); background: color-mix(in srgb, #E5484D 14%, transparent) }
.line.add { color: color-mix(in srgb, var(--clover-card-text, var(--seal-text)) 45%, #30A46C); background: color-mix(in srgb, #30A46C 14%, transparent) }
.rowsblock { font-family: inherit }
.row { display: flex; gap: 8px; }
.row .k { flex: none; color: var(--clover-card-muted, var(--seal-muted)) }
.row .v { min-width: 0; font-family: var(--seal-mono) }
.label-line { margin: 0 0 4px; color: var(--clover-card-muted, var(--seal-muted)); font-size: 0.9em }
.more { margin: 4px 0 0; color: var(--clover-card-muted, var(--seal-muted)); font-size: 0.9em }
.more.shortened { font-style: italic }
.seal-button {
  appearance: none;
  border: 1px solid var(--clover-card-button-rim, transparent);
  border-radius: var(--clover-card-button-radius, 10px);
  background: var(--clover-card-approve-background, var(--seal-accent));
  color: var(--clover-card-approve-text, var(--seal-accent-text));
  font: inherit;
  font-weight: 500;
  padding: 6px 14px;
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
}
.seal-button.glyph { box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; min-width: 24px; min-height: 24px; padding: 0; border-radius: 50% }
.seal-button.glyph .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
.seal-button.glyph svg { display: block }
body[data-answering="yes"] .seal-button.glyph { opacity: 0.6 }
body[data-answered="no"] .seal-button.glyph { outline: 2px solid #E5484D; outline-offset: -2px }
body:has(.seal-button.glyph) { overflow: hidden }
body:has(.seal-button.glyph) .state { display: none }
.seal-button:disabled { opacity: 0.5; cursor: wait }
.seal-button.quiet { background: color-mix(in srgb, var(--clover-card-text, var(--seal-text)) 14%, transparent); color: var(--clover-card-text, var(--seal-text)) }
.seal-title body, .seal-computer body, .seal-expires body, .seal-source body { font-size: 0.87em; font-weight: 600; color: var(--clover-card-muted, var(--seal-muted)) }
.seal-deny .seal-button { background: var(--clover-card-deny-background, var(--seal-control)); color: var(--clover-card-deny-text, var(--seal-text)) }
.state { margin: 0; font-size: 0.85em; color: var(--clover-card-muted, var(--seal-muted)); min-height: 1.2em }
.hidden { visibility: hidden }
/* The app's own card. */
.seal-own body, body:has(.own) { background: var(--seal-surface) }
.own { box-sizing: border-box; min-height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 0 }
.own-head { display: flex; gap: 10px; align-items: flex-start }
.own-head .shield { flex: none; margin-top: 2px; color: #C27C00 }
@media (prefers-color-scheme: dark) { .own-head .shield { color: #ECD575 } }
.own-words { min-width: 0 }
.own .ask { font-size: 1.07em }
.own .sub { margin: 2px 0 0; color: var(--seal-muted); font-size: 0.9em }
.own .field { margin: 0 0 10px }
.own .fname { margin: 0 0 2px; font-size: 0.78em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--seal-muted) }
.own details.all { border-top: 1px solid var(--seal-hairline); padding-top: 8px }
.own details.all > summary { cursor: pointer; color: var(--seal-muted); font-size: 0.92em; margin-bottom: 8px }
.own-foot { position: sticky; bottom: 0; margin: auto -16px 0; padding: 10px 16px 12px; background: var(--seal-surface); border-top: 1px solid var(--seal-hairline) }
.own .buttons { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end }
.own .seal-button[data-kind="deny"] { background: var(--seal-control); color: var(--seal-text) }
.own .seal-button[data-remember="always"] { background: var(--seal-control); color: var(--seal-text) }
.own .who { margin: 6px 0 0; font-size: 0.85em; color: var(--seal-muted) }
`;

/** A button's own words: the core's own table holds the language they shipped in (§5.5). The card's fields' and
 *  labels' own language is the core's — the envelope of a card's text travels with the card, already said. */
export function labelOf(text: unknown): string {
  if (typeof text === "string") return text;
  if (text !== null && typeof text === "object" && typeof (text as { en?: unknown }).en === "string") return String((text as { en: string }).en);
  return "";
}

/** The page's text stays text: `&`, `<`, quotes escaped once, and nothing unescapes later. */
function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
