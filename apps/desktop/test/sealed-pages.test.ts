// The sealed frames' own pages (`sealed-pages.ts`): one field or one button from the app's own scheme, over the
// `card.*` tokens, with the escapes, and no identifier beyond the frame's own token (spec §5.5).
import { describe, expect, test } from "bun:test";
import { SEALED_PRESS_WORDS, buttonPage, fieldPage, sealedEscape } from "../src/main/sealed-pages";
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
    expect(sealedEscape("a\u061Cb")).toBe("aU+061Cb");
    expect(fieldPage({ cardId: "card_escape", token: TOKEN, field: "title", value: { type: "text", text: "a\u202E" }, tokens: { "card.radius": "12px" } })).toContain("aU+202E");
    expect(sealedEscape("a\u0007b")).toBe("aU+0007b");
    expect(sealedEscape("a\nb")).toBe("a\nb");
    const tricky = fieldPage({ cardId: "card_x", token: TOKEN, field: "title", value: { type: "text", text: "x" }, tokens: { "card.font.family": "a); b { color: red }", "card.radius": "12px" } });
    // The token's value goes in only when it parses as its grammar's own run: a `;`'s own injection is dropped (S1).
    expect(tricky).not.toContain("--clover-card-font-family:");
    expect(tricky).toContain("--clover-card-radius: 12px;");
    expect(tricky).not.toContain("{ color: red }");
  });
});

describe("a sealed button's page", () => {
  test("the card's own label on the button, the option named for the answer, and the visible-only check before it", () => {
    const p = buttonPage({ cardId: "card_0a1b2c3d", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" });
    expect(p).toContain('data-option="allow_once"');
    expect(p).toContain('data-kind="approve"');
    expect(p).toContain(">Allow</span>");
    expect(p).toContain("b.answer(option)");
        expect(p).toContain('data-token="${TOKEN}"'.replace("${TOKEN}", TOKEN));
  });

  test("its size is said when the button has one and said again as it changes; a reading of no size is never said", () => {
    const p = buttonPage({ cardId: "card_0a1b2c3d", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" });
    expect(p).toContain("if (q.width <= 0 || q.height <= 0) return;");
    expect(p).toContain("new ResizeObserver(send).observe(r)");
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
    expect(p).toContain("b.answer(b2.dataset.option)");
  });

  test("the page's inline script parses: plain script alone, never the author's types (a `as` or `: string` in it kills the page's own listeners at parse)", () => {
    const pages = [
      buttonPage({ cardId: "card_x", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" }),
      buttonPage({ cardId: "card_x", token: TOKEN, option: "deny", label: "Deny", kind: "deny" }),
      ownCardPage({
        cardId: "card_own",
        token: TOKEN,
        origin: "user",
        issuedAt: 0,
        expiresAt: null,
        fields: { title: { type: "text", text: "Run a command?" } },
        options: [
          { id: "allow_once", kind: "approve", label: "Allow" },
          { id: "deny", kind: "deny", label: "Deny" },
        ],
      }),
    ];
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      const script = p.match(/<script>([\s\S]*)<\/script>/);
      expect(script, "a sealed page with answers carries its script").not.toBeNull();
      expect(() => new Function(script![1]!), "the inline script parses as plain script").not.toThrow();
    }
  });
});

import { KEY_CHANGED_TEXT, KEY_FAULT_TEXT, REFUSED_TEXT } from "../src/main/sealed-pages";
describe("a refused answer shows on the card", () => {
  test("the button page and the fallback card say so and answer again; neither leaves a lasting \"…\"", () => {
    const b = buttonPage({ cardId: "card_x", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" });
    expect(b).toContain(JSON.stringify(REFUSED_TEXT));
    expect(b).toContain(JSON.stringify(KEY_CHANGED_TEXT));
    expect(b).toContain(JSON.stringify(KEY_FAULT_TEXT));
    expect(b).toMatch(/answering = false; document\.body\.dataset\.answered = "no"/);
    const own = ownCardPage({
      cardId: "card_x", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "T" } },
      options: [{ id: "allow_once", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
    });
    expect(own).toContain(JSON.stringify(REFUSED_TEXT));
    expect(own).toContain('<p class="state" data-state="waiting" role="status"></p>');
  });
});

describe("every press a sealed page sees is told to the app, in one word of a fixed set", () => {
  const said = (page: string): string[] => page.split("\n").filter((l) => /\bsay\(/.test(l) && !/const say =/.test(l)).flatMap((l) => [...l.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
  const button = buttonPage({ cardId: "card_x", token: TOKEN, option: "allow_once", label: "Allow", kind: "approve" });
  test("the button page says received, untrusted, answering and why it was not ready, and no other word", () => {
    const words = new Set(said(button));
    for (const w of ["received", "untrusted", "answering", "not-visible", "opening", "settling"]) expect(words.has(w)).toBe(true);
    for (const w of words) expect(SEALED_PRESS_WORDS).toContain(w);
    expect(button).toContain("b.pressed?.(w)");
  });
  test("the fallback card's page says it too", () => {
    const own = ownCardPage({ cardId: "card_x", token: TOKEN, origin: "x", issuedAt: 1, expiresAt: null, fields: {}, options: [{ id: "allow_once", kind: "approve", label: { type: "text", text: "Allow" } }] } as never);
    const words = new Set(said(own));
    for (const w of ["received", "untrusted", "no-pointer", "opening"]) expect(words.has(w)).toBe(true);
    for (const w of words) expect(SEALED_PRESS_WORDS).toContain(w);
  });
});

describe("the Review on the app's own card page (the owner's ruling, 2026-11-13)", () => {
  const base = {
    cardId: "card_okreview", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null,
    fields: { title: { type: "text", text: "Tarot" }, detail: { type: "list", items: ["It adds: tools."] } },
    options: [{ id: "approve", kind: "approve" as const, label: "Approve" }, { id: "deny", kind: "deny" as const, label: "Deny" }],
  };

  test("a plugin's OK or update card offers a Review beside its fields, not among the sealed buttons; any other card doesn't", () => {
    const p = ownCardPage({ ...base, reviewable: true });
    expect(p).toContain('class="review-button"');
    expect(p).toContain("it doesn&#39;t answer this card");
    // Its control isn't a sealed button: it answers nothing.
    expect(p.match(/class="seal-button"/g)?.length).toBe(2);
    expect(p.indexOf('class="review"')).toBeLessThan(p.indexOf('class="own-foot"'));
    expect(ownCardPage(base)).not.toContain('class="review-button"');
  });

  test("its report goes in as text, never markup, and only from the app's own fetch", () => {
    const p = ownCardPage({ ...base, reviewable: true });
    const script = p.slice(p.indexOf("const section = document.querySelector(\".review\")"));
    expect(script).toContain("report.textContent = typeof r.report");
    expect(script).not.toContain("innerHTML");
    expect(script).toContain("b.review()");
    // The click must be the user's own.
    expect(script).toContain("if (!e.isTrusted) return;");
    // A heading over the report, so its text can't pass for the card's own lines; the note names where the files go.
    expect(p).toContain("A model&#39;s reading of the plugin&#39;s files");
    expect(script).toContain("Review sends this plugin's files to {model}.");
    expect(script).toContain("b.review(true)");
    // A peek refused before the window binds the page's channel is asked again.
    expect(script).toContain("setTimeout(() => peek(n + 1), 400)");
  });

  test("the script is in the head, so the Review wires its elements only once the body is parsed", () => {
    const p = ownCardPage({ ...base, reviewable: true });
    expect(p.indexOf("<script>")).toBeLessThan(p.indexOf("<body"));
    expect(p).toContain('addEventListener("DOMContentLoaded", wireReview)');
  });
});
