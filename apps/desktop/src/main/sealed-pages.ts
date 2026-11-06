/** What a sealed frame's own page says. Each card's field and each button is a frame of its own from the app's sealed
 *  scheme (`clover-sealed://<card id>/<element>?<token>`, spec §5.5): the frame inside it is the field's text in the
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

/** The card's own tokens as the page's custom properties: `card.*` alone (§5.5 "sealed frames take only these"). */
function tokenCss(tokens: Readonly<Record<string, TokenValue>> | undefined): string {
  if (tokens === undefined) return "";
  const lines: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!name.startsWith("card.") || typeof value !== "string" || value === "") continue;
    if (!/^card\.[a-z0-9.]*[a-z0-9]$/.test(name)) continue;
    lines.push(`  --clover-${name.replaceAll(".", "-")}: ${cssSafe(value)};`);
  }
  return lines.length === 0 ? "" : `:root {\n${lines.join("\n")}\n}\n`;
}

/** A token's value stays what the store said: quotes and backslashes escaped, so it is a value, never markup, and no
 *  brace opens or closes anything the page's CSS holds. */
function cssSafe(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("<", "\\3c ").replaceAll(">", "\\3e ").replaceAll("{", "\\7b ").replaceAll("}", "\\7d ");
}

/** The sealed text at one line's length: control characters and bidirectional marks visible as their escapes. */
export function sealedEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && ch !== "\n") || code === 0x7f) out += `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else if (isBidirectional(code)) out += `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

function isBidirectional(code: number): boolean {
  return (code >= 0x0590 && code <= 0x05ff) || (code >= 0x200e && code <= 0x202f) || code === 0xfeff || (code >= 0x2060 && code <= 0x206f) || (code >= 0xfff9 && code <= 0xfffc);
}

/** A text field's HTML: its lines in a block that scrolls inside the part's size, in the part's own typography. */
export function fieldPage(input: { cardId: string; token: string; field: string; value: SealedValue; tokens?: Readonly<Record<string, TokenValue>> }): string {
  const body = (() => {
    if (input.value.type === "text") return `<p class="text">${esc(input.value.text)}</p>`;
    if (input.value.type === "code") return `<pre class="code"><code>${esc(input.value.code)}</code></pre>`;
    if (input.value.type === "list") return `<ul class="list">${input.value.items.map((i) => `<li>${esc(i)}</li>`).join("\n")}</ul>`;
    return `<dl class="rows">${input.value.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>`;
  })();
  return page(input, body, `seal-${input.field}`);
}

/** A button's page: the card's own label (its kind's option), with the glyph only as the core draws it, and the
 *  answer's proof path through the preload — never a script of the part's own. Its click counts only while it is
 *  fully visible and uncovered (IOv2 in the page); toggled off, nothing answers. */
export function buttonPage(input: {
  cardId: string; token: string; option: string; label: string; kind: "approve" | "deny";
  tokens?: Readonly<Record<string, TokenValue>>;
}): string {
  const body = `<button type="button" class="seal-button" data-option="${esc(input.option)}" data-kind="${esc(input.kind)}">
  <span class="label">${esc(input.label)}</span>
</button>
<p class="state" data-state="waiting" role="status"></p>`;
  return page(input, body, input.kind === "approve" ? "seal-approve" : "seal-deny", true);
}

function page(input: { cardId: string; token: string; tokens?: Readonly<Record<string, TokenValue>> }, body: string, extraClass: string, script = false): string {
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
  border: 1px solid var(--clover-card-button-radius, transparent);
  border-radius: var(--clover-card-button-radius, 10px);
  background: var(--clover-card-approve-background, var(--clover-color-accent, #977000));
  color: var(--clover-card-approve-text, #fff);
  font: inherit;
  font-weight: 500;
  padding: 6px 14px;
  cursor: pointer;
}
.seal-button:disabled { opacity: 0.5; cursor: wait }
.seal-deny .seal-button { background: var(--clover-card-deny-background, #ededed); color: var(--clover-card-deny-text, #1f1f1f) }
.state { margin: 0; font-size: 0.85em; color: var(--clover-card-muted, #6b6b6b); min-height: 1.2em }
.hidden { visibility: hidden }
</style>
${script
    ? `<script>
// The page answers through the preload, over one channel: answered once, visible-only (the disk's own IOv2 check).
(() => {
  const b = window.cloverSealed;
  if (b === undefined) return;
  let answering = false;
  // The frame's own visibility gate (§5.5): the whole button, at its own size from the CSS, uncovered — Chromium's
  // IOv2 reports whatever wraps it too (a filter, an opacity below 1, or a transform other than a move or an
  // enlargement count as hidden), so a theme's CSS can's hide the button around it.
  let seen = false;
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    seen = e !== undefined && e.isIntersecting === true && e.intersectionRatio === 1 && (e as unknown as { isVisible?: boolean }).isVisible === true;
  }, { threshold: [1], trackVisibility: true, delay: 200 } as never);
  document.addEventListener("DOMContentLoaded", () => {
    const b2 = document.querySelector(".seal-button");
    if (b2 !== null) io.observe(b2);
  });
  const run = (e: unknown) => {
    if (answering || !seen) return;
    if (!(e instanceof PointerEvent) || e.isTrusted !== true) return; // a page-level dispatch is not the user's.
    b.visible().then((ok) => {
      if (ok !== true) return;
      answering = true;
      const state = document.querySelector('.state');
      if (state !== null) state.textContent = "…";
      b.answer().then((r) => {
        if (r.accepted === true) { document.body.dataset.answered = "yes"; answering = false; }
      }).catch(() => { answering = false; });
    });
  };
  document.addEventListener("pointerdown", (e) => run(e), { capture: true });
})();
</script>`
    : ""}
<script>
addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return; // no paste door here: the sealed words are theirs
});
</script>
</head>
<body data-token="${esc(input.token)}">
${body}
</body>
</html>
`;
}

/** The page's text stays text: `&`, `<`, quotes escaped once, and nothing unescapes later. */
function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** A button's own words: the core's own table holds the language they shipped in (§5.5). The card's fields' and
 *  labels' own language is the core's — the envelope of a card's text travels with the card, already said. */
export function labelOf(text: unknown): string {
  if (typeof text === "string") return text;
  if (text !== null && typeof text === "object" && typeof (text as { en?: unknown }).en === "string") return String((text as { en: string }).en);
  return "";
}

/** The app's own fallback card (§5.5): the whole card in one page of the app's own — its sealed fields above its
 *  buttons, in the card's tokens, so a card the parts never placed stands before the user in 2 seconds or none. The
 *  buttons' answers ride the same frame channel as a part's (`clover:sealed-answer`), minted per option with the
 *  `own:button:<option>` element. */
export function ownCardPage(input: {
  cardId: string; token: string; origin: string; issuedAt: number; expiresAt: number | null;
  fields: Readonly<Record<string, unknown>>;
  tokens?: Readonly<Record<string, TokenValue>>;
  options: readonly { id: string; kind: "approve" | "deny"; label: unknown; remember?: "always" }[];
}): string {
  const fields = (CARD_FIELD_ORDER as readonly string[]).filter((name) => {
    const v = input.fields[name] as SealedValue | undefined;
    return v !== undefined && typeof v === "object" && typeof v.type === "string";
  });
  const bits = fields.map((name) => {
    const value = input.fields[name] as SealedValue;
    const body = value.type === "text"
      ? `<p class="text">${esc(value.text)}</p>`
      : value.type === "code"
        ? `<pre class="code"><code>${esc(value.code)}</code></pre>`
        : value.type === "list"
          ? `<ul class="list">${value.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
          : `<dl class="rows">${value.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>`;
    return `<section class="field" data-name="${esc(name)}">${body}</section>`;
  }).join("\n");
  const buttons = input.options.map((o) => `<button type="button" class="seal-button" data-option="${esc(o.id)}" data-kind="${esc(o.kind)}"><span class="label">${esc(labelOf(o.label))}</span></button>`).join("\n");
  const expires = input.expiresAt === null ? "" : "";
  return `<!doctype html>
<html lang="en" class="seal-own">
<head>
<meta charset="utf-8">
${input.tokens === undefined ? "" : `<style>${tokenCss(input.tokens)}</style>`}
<style>
html, body { margin: 0; background: transparent; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--clover-card-text, var(--clover-color-text, #1f1f1f));
  padding: 0 0 14px;
  overflow-wrap: break-word;
}
.field { margin: 0 0 10px }
.field .text { margin: 0; font-weight: 500 }
.field .code { font: var(--clover-card-font-code, 13px / 1.4 monospace); white-space: pre-wrap; overflow-wrap: anywhere }
.list, .rows { margin: 0; padding-inline-start: 1.2em }
.seal-button {
  appearance: none;
  border: none;
  border-radius: var(--clover-card-button-radius, 10px);
  background: var(--clover-card-approve-background, var(--clover-color-accent, #977000));
  color: var(--clover-card-approve-text, #fff);
  font: inherit;
  font-weight: 500;
  padding: 6px 14px;
  margin-right: 8px;
  cursor: pointer;
}
.seal-deny .seal-button { background: var(--clover-card-deny-background, #ededed); color: var(--clover-card-deny-text, #1f1f1f) }
.hidden { visibility: hidden }
</style>
<script>
// The answer, once, over the frame's own channel; the page's own check reads nothing else. The who is the core's; the
// when is the card's (its own expiry for a turn the user didn't start).
(() => {
  const b = window.cloverSealed;
  if (b === undefined) return;
  document.addEventListener("click", (e) => {
    const button = e.target instanceof Element && e.target.closest(".seal-button");
    if (button === null) return;
    e.preventDefault();
    void b.answer(button.dataset.option);
  }, { capture: true });
})();
</script>
</head>
<body data-token="${esc(input.token)}">
${bits}
<div class="buttons">${buttons}</div>
</body>
</html>
`;
}

/** The fields in B's own order (§5.5), read at once. */
export const CARD_FIELD_ORDER = ["title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires"] as const;
