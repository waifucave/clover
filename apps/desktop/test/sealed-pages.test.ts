// The sealed frames' own pages (`sealed-pages.ts`): one field or one button from the app's own scheme, over the
// `card.*` tokens, with the escapes, and no identifier beyond the frame's own token (spec §5.5).
import { describe, expect, test } from "bun:test";
import { buttonPage, fieldPage, sealedEscape } from "../src/main/sealed-pages";
import type { SealedValue } from "@waifucave/clover-protocol";

const TOKEN = "se_001abcdef";
describe("a sealed field's page", () => {
  const text: Extract<SealedValue, { type: "text" }> = { type: "text", text: "Run a command?" };

  test("the field's frame shows the sealed words, with the card's own tokens in, and nothing out", () => {
    const p = fieldPage({ cardId: "card_0a1b2c3d", token: TOKEN, field: "title", value: text, tokens: { "card.radius": "12px", "plugin.other": "x" } });
    expect(p).toContain("Run a command?");
    expect(p).toContain('--clover-card-radius: 12px;');
    expect(p).not.toContain("plugin.other");
    expect(p).toContain(`data-token="${TOKEN}"`);
    expect(p).not.toContain("cloverSealed.answer"); // a field answers nothing.
  });

  test("code and lists and rows come through their own tags", () => {
    const code: Extract<SealedValue, { type: "code" }> = { type: "code", code: "rm -rf build/", language: "sh" };
    expect(fieldPage({ cardId: "card_x", token: TOKEN, field: "command", value: code })).toContain('<pre class="code"><code>rm -rf build/</code></pre>');
    const list: Extract<SealedValue, { type: "list" }> = { type: "list", items: ["one", "two"] };
    expect(fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: list })).toContain("<li>one</li>");
    const rows: Extract<SealedValue, { type: "rows" }> = { type: "rows", rows: [{ label: "site", value: "ev.example" }] };
    expect(fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows })).toContain("<dt>site</dt><dd>ev.example</dd>");
  });

  test("the page stays text: markup in a field's content is escaped", () => {
    const evil: Extract<SealedValue, { type: "text" }> = { type: "text", text: `<img src=x onerror="alert(1)"><script>bad()</script>` };
    const p = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: evil });
    expect(p).not.toContain("<img");
    expect(p).not.toContain("<script>bad");
    expect(p).toContain("&lt;img src=x");
  });

  test("a control character and a bidirectional mark show as their escapes, and a token's value stays a value", () => {
    expect(sealedEscape("a\u202Eb")).toBe("aU+202Eb");
    expect(sealedEscape("a\u0007b")).toBe("aU+0007b");
    expect(sealedEscape("a\nb")).toBe("a\nb");
    const tricky = fieldPage({ cardId: "card_x", token: TOKEN, field: "title", value: { type: "text", text: "x" }, tokens: { "card.font.family": "a); b { color: red }" } });
    // The value is one custom property's, escaped; nothing in it opens a rule.
    expect(tricky).toContain("--clover-card-font-family: a); b \\7b  color: red \\7d ;");
    expect(tricky).not.toContain("{ color: red }");
  });
});

describe("a sealed button's page", () => {
  test("the card's own label on the button, the option named for the answer, and the visible-only check before it", () => {
    const p = buttonPage({ cardId: "card_0a1b2c3d", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" });
    expect(p).toContain('data-option="allow_once"');
    expect(p).toContain('data-kind="approve"');
    expect(p).toContain(">Allow</span>");
    expect(p).toContain("b.answer()");
    expect(p).toContain("b.visible()");
    expect(p).toContain('data-token="${TOKEN}"'.replace("${TOKEN}", TOKEN));
  });

  test("a deny button takes the deny's own colours, not the approve's", () => {
    const p = buttonPage({ cardId: "card_x", token: TOKEN, option: "deny", label: "Deny", kind: "deny" });
    expect(p).toContain("seal-deny");
    expect(p).toContain('--clover-card-deny-background');
  });

  test("the page says the answer only once: the answering flag holds through the response", () => {
    const p = buttonPage({ cardId: "card_x", token: TOKEN, option: "allow_once", label: "A", kind: "approve" });
    expect(p).toContain("answering = true");
    expect(p).toContain("answering = false"); // a refused answer can try again; one answered, the core's.
  });
});

import { ownCardPage } from "../src/main/sealed-pages";

describe("the app's own fallback card page", () => {
  test("the whole card on one page: its fields in order, the buttons, and the answers on its own tokens", () => {
    const p = ownCardPage({
      cardId: "card_own",
      token: TOKEN,
      origin: "user",
      issuedAt: 0,
      expiresAt: null,
      fields: { title: { type: "text", text: "Run a command?" }, command: { type: "code", code: "rm -rf build/", language: "sh" }, risk: { type: "text", text: "Deletes a folder" } },
      options: [
        { id: "allow_once", kind: "approve", label: "Allow" },
        { id: "always", kind: "approve", label: { en: "Always allow", fr: "Toujours autoriser" } },
        { id: "deny", kind: "deny", label: "Deny" },
      ],
    });
    // The fields in the card's own order, and the buttons beneath.
    const titleAt = p.indexOf('data-name="title"');
    const commandAt = p.indexOf('data-name="command"');
    const riskAt = p.indexOf('data-name="risk"');
    const buttonsAt = p.indexOf('data-option="allow_once"');
    expect(titleAt).toBeGreaterThan(0);
    expect(titleAt).toBeLessThan(commandAt);
    expect(commandAt).toBeLessThan(riskAt);
    expect(buttonsAt).toBeGreaterThan(0);
    expect(p).toContain('data-option="always"');
    expect(p).toContain(">Always allow</span>");
    expect(p).toContain('data-token="' + TOKEN + '"');
    expect(p).toContain("b.answer(button.dataset.option)");
  });
});
