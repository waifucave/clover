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

/** A token's value stays what the store said: quotes and backslashes escaped, so it is a value, never markup. */
function cssSafe(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("<", "\\3c ").replaceAll(">", "\\3e ");
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
export function fieldPage(input: { cardId: string; token: string; field: string; value: { type: "text"; text: string } | { type: "code"; code: string; language?: string } | { type: "list"; items: readonly string[] } | { type: "rows"; rows: readonly { label: string; value: string }[] }; tokens?: Readonly<Record<string, TokenValue>>; brand: { font: string; size: string; line: string; accent: string; text: string; family: string } }): string {
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
  brand: { font: string; size: string; line: string; accent: string; text: string; family: string };
  risk?: { channelMs: number; overMs: number };
}): string {
  const body = `<button type="button" class="seal-button" data-option="${esc(input.option)}" data-kind="${esc(input.kind)}">
  <span class="label">${esc(input.label)}</span>
</button>
<p class="state" data-state="waiting" role="status"></p>`;
  return page({ ...input, tokens: input.tokens }, body, input.kind === "approve" ? "seal-approve" : "seal-deny", true);
}

function page(input: { brand: { font: string; size: string; line: string; accent: string; text: string; family: string }; token: string; tokens?: Readonly<Record<string, TokenValue>> }, body: string, extraClass: string, script = false): string {
  const style = tokenCss(input.tokens);
  return `<!doctype html>
<html lang="en" class="${extraClass}">
<head>
<meta charset="utf-8">
${style === "" ? "" : `<style>${style}</style>`}
<style>
html, body { margin: 0; background: transparent; }
body {
  font-family: ${cssSafe(input.brand.family)}, -apple-system, "Segoe UI", sans-serif;
  font-size: ${cssSafe(input.brand.size)};
  line-height: ${cssSafe(input.brand.line)};
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
  background: ${input.brand.accent};
  color: var(--clover-card-button-text, #fff);
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
  const run = () => {
    if (answering) return;
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
  document.addEventListener("pointerdown", run, { capture: true });
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
