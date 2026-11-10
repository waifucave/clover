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
  return page(input, body, `seal-${input.field}`);
}

/** A button's page: the card's own label (its kind's option), with the glyph only as the core draws it, and the
 *  answer's proof path through the preload — never a script of the part's own. Its click counts only while the whole
 *  button shows, uncovered, at its own visible size (IOv2 in the page; S4's run of it keeps the count honest), and
 *  the answer passes the option (B1: plain JS, the button's own dataset). Nothing in production relaxes `isTrusted`
 *  or the open-delay: a trusted press from the real input path is the only way an answer leaves this page. */
export function buttonPage(input: { cardId: string; token: string; option: string; label: string; kind: "approve" | "deny"; tokens?: Readonly<Record<string, TokenValue>> }): string {
  const body = `<button type="button" class="seal-button" data-option="${esc(input.option)}" data-kind="${esc(input.kind)}">
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
    // A refused answer says so on the card and the button answers again: never a "…" that stays.
    const refused = (r) => { answering = false; document.body.dataset.answered = "no"; if (state !== null) state.textContent = r !== null && typeof r === "object" && r.key === "changed" ? ${JSON.stringify(KEY_CHANGED_TEXT)} : ${JSON.stringify(REFUSED_TEXT)}; };
    b.answer(option).then((r) => {
      if (r !== null && typeof r === "object" && r.accepted === true) { document.body.dataset.answered = "yes"; answering = false; if (state !== null) state.textContent = ""; }
      else refused(r);
    }).catch(() => refused(null));
  }, { capture: true });
})();`;
  return page({ ...input, tokens: input.tokens }, body, input.kind === "approve" ? "seal-approve" : "seal-deny", true, script);
}

/** The app's own fallback card (§5.5): the whole card in one page of the app's own — its sealed fields above its
 *  buttons, in the card's tokens, so a card the parts never placed stands before the user in 2 seconds or none. The
 *  buttons' answers ride the same frame channel as a part's (`clover:sealed-answer`), minted per option with the
 *  `own` element, and their own gates ride this page's checks (S3's fix: a beat after shown, a trusted press in the
 *  button, and about the same visible-and-uncovered run). */
export function ownCardPage(input: {
  cardId: string; token: string; origin: string; issuedAt: number; expiresAt: number | null;
  fields: Readonly<Record<string, unknown>>;
  tokens?: Readonly<Record<string, TokenValue>>;
  options: readonly { id: string; kind: "approve" | "deny"; label: unknown; remember?: "always" }[];
  who?: { bot?: string; pluginId?: string };
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
    return `<section class="field" data-name="${esc(name)}">${body}</section>`;
  }).join("\n");
  const buttons = input.options.map((o) => `<button type="button" class="seal-button" data-option="${esc(o.id)}" data-kind="${esc(o.kind)}"><span class="label">${esc(sealedEscape(labelOf(o.label)))}</span></button>`).join("\n");
  // The card's own who: a plugin's own asking with its name, a bot's with its name, else the core's (the words are
  // said by the core's own strings — the page's own type carries what its table holds). The page's own footer holds
  // what a plugin's own strip would: the asking's own source (§5.5's `source` field rides the card's own table),
  // and the expiry the card says (a turn the user didn't start: denied after, the app's own text).
  // The asking's own who: the card's `source` field says so (a plugin with its id and source; a bot's own). A page's
  // own footer carries it, in the core's own table's words.
  const source = input.fields.source as { type: "text"; text: string } | undefined;
  const who = typeof source?.text === "string" ? input.who?.bot ?? input.who?.pluginId : undefined;
  const footnote = who === undefined ? "" : `<p class="who" data-who="${esc(input.who?.bot !== undefined ? "bot" : "plugin")}">${esc(sealedEscape(who))}</p>`;
  const script = `(() => {
  const b = window.cloverSealed;
  if (b === undefined) return;
  // About a second after the page is shown (showInactive): the 1 s wait restarts when the window is shown or moved,
  // never on mouse movement, and the pointer must have entered the window after it showed, so a timed "click here"
  // prompt can't land on Approve (S3, check 3). The page is placed before it is shown, so shown is load time here.
  let openedAt = Date.now();
  let pointerEntered = false;
  document.addEventListener("pointerover", () => { pointerEntered = true; }, { once: true, passive: true });
  document.addEventListener("mouseover", () => { pointerEntered = true; }, { once: true, passive: true });
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
    const refused = (r) => { document.body.dataset.answered = "no"; if (state !== null) state.textContent = r !== null && typeof r === "object" && r.key === "changed" ? ${JSON.stringify(KEY_CHANGED_TEXT)} : ${JSON.stringify(REFUSED_TEXT)}; };
    void b.answer(b2.dataset.option).then((r) => {
      if (r !== null && typeof r === "object" && r.accepted === true) { document.body.dataset.answered = "yes"; if (state !== null) state.textContent = ""; }
      else refused(r);
    }).catch(() => refused(null));
  }, { capture: true });
})();`;
  return page({ cardId: input.cardId, token: input.token, tokens: input.tokens }, `${bits}
<div class="buttons">${buttons}</div>
<p class="state" data-state="waiting" role="status"></p>${footnote}`, "seal-own", true, script);
}

/** What a card says when its answer didn't go through (the core refused it, or this desktop's answer key isn't
 *  registered yet): the card stays, and its buttons answer again. */
export const REFUSED_TEXT = "Couldn't confirm — try again.";

/** What a card says when Clover holds a different answer key for this desktop than the app has (one made by an
 *  earlier build or another app on this home): trying again can't help, so the card doesn't ask for it. */
export const KEY_CHANGED_TEXT = "Couldn't confirm: this computer's answer key isn't the one Clover has for it, so answers from here can't be checked.";

/** The fields in B's own order (§5.5), read at once. */
export const CARD_FIELD_ORDER = ["title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires"] as const;

function page(input: { cardId: string; token: string; tokens?: Readonly<Record<string, TokenValue>> }, body: string, extraClass: string, script = false, extra = ""): string {
  const style = tokenCss(input.tokens);
  return `<!doctype html>
<html lang="en" class="${extraClass}">
<head>
<meta charset="utf-8">
${style === "" ? "" : `<style>${style}</style>`}
<style>
html, body { margin: 0; background: transparent; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--clover-card-text, var(--clover-color-text, #1f1f1f));
  padding: 0;
  overflow-wrap: break-word;
}
.text { margin: 0 }
.code { margin: 0; overflow: auto; white-space: pre-wrap }
.list, .rows { margin: 0; padding-inline-start: 1.2em }
.seal-button {
 appearance: none;
  border: 1px solid var(--clover-card-button-rim, transparent);
  border-radius: var(--clover-card-button-radius, 10px);
  background: var(--clover-card-approve-background, var(--clover-color-accent, #977000));
  color: var(--clover-card-approve-text, #fff);
  font: inherit;
  font-weight: 500;
  padding: 6px 14px;
  margin-right: 8px;
  cursor: pointer;
}
.seal-button:disabled { opacity: 0.5; cursor: wait }
.seal-deny .seal-button { background: var(--clover-card-deny-background, #ededed); color: var(--clover-card-deny-text, #1f1f1f) }
.state { margin: 0; font-size: 0.85em; color: var(--clover-card-muted, #6b6b6b); min-height: 1.2em }
.hidden { visibility: hidden }
</style>
${script ? `<script>${extra}</script>` : ""}
</head>
<body data-token="${esc(input.token)}">
${body}
</body>
</html>
`;
}

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
