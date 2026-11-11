// What a tool card says in a line and a preview (`card-summary.ts`), and how the sealed pages draw it: the one line,
// real line breaks (never the call's input as escaped JSON), a preview that says where it leaves something out, and
// every word escaped (spec §5.5).
import { describe, expect, test } from "bun:test";
import { alwaysSentence, nameFromId, shortenPath, summarize, underHome } from "../src/main/card-summary";
import { askHtml, colourAlpha, fieldPage, ownCardPage, previewHtml, readable, sealedEscape, summaryFieldPage } from "../src/main/sealed-pages";

const detail = (input: unknown) => ({ type: "code" as const, code: JSON.stringify(input, null, 2), language: "json" });
const card = (what: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  kind: "tool", bot: "alpha",
  fields: { title: { type: "text", text: "Change files" }, what: { type: "text", text: what }, detail: detail(input), computer: { type: "code", code: "Delta" }, ...extra },
});

const HOME = "/Users/k";
describe("the one line", () => {
  test("an edit says who wants to edit which file: the core's resolved path under the home, whole", () => {
    const s = summarize(card("Edit", { file_path: "~/Downloads/story_of_egypt.md", old_string: "a\nb", new_string: "a\nc" }, { paths: { type: "code", code: "/Users/k/Downloads/story_of_egypt.md" } }), "Alpha", HOME)!;
    expect(s).toMatchObject({ who: "Alpha", verb: "edit", target: "~/Downloads/story_of_egypt.md" });
    expect(s.asked).toBeUndefined();
    expect(askHtml(s)).toContain("<b class=\"target\">~/Downloads/story_of_egypt.md</b>");
  });
  test("a link: the model asks for ~/Downloads/photos/config, the core resolved ~/.ssh/config; the line names the resolved file and says what was asked", () => {
    const s = summarize(card("Edit", { file_path: "~/Downloads/photos/config", old_string: "a", new_string: "b" }, { paths: { type: "code", code: "/Users/k/.ssh/config" } }), "Alpha", HOME)!;
    expect(s.target).toBe("~/.ssh/config");
    expect(s.asked).toBe("~/Downloads/photos/config");
    const line = askHtml(s);
    expect(line).toContain("~/.ssh/config");
    expect(line).toContain("(asked as ~/Downloads/photos/config)");
    expect(line).not.toContain("config in photos");
  });
  test("a `..` path: the resolved file is on the line, the raw `..` string beside it", () => {
    const s = summarize(card("Write", { file_path: "/Users/k/Downloads/../.ssh/authorized_keys", content: "x" }, { paths: { type: "code", code: "/Users/k/.ssh/authorized_keys" } }), "Alpha", HOME)!;
    expect(s.target).toBe("~/.ssh/authorized_keys");
    expect(s.asked).toBe("~/Downloads/../.ssh/authorized_keys");
  });
  test("the line never comes from the input's own path: with no resolved path it names none", () => {
    const s = summarize(card("Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }), "Alpha", HOME)!;
    expect(s.target).toBeUndefined();
    expect(askHtml(s)).not.toContain("hosts");
  });
  test("several paths: the count and the first, resolved", () => {
    const s = summarize(card("MultiEdit", { file_path: "/a", edits: [] }, { paths: { type: "code", code: "/Users/k/a.md\n/Users/k/b.md\n/Users/k/c.md" } }), "Alpha", HOME)!;
    expect(s).toMatchObject({ target: "~/a.md", count: 3 });
    expect(askHtml(s)).toContain("3 files, the first");
  });
  test("a long path loses only its middle: the first folders after ~ and the file name stay", () => {
    const long = "/Users/k/Projects/clients/acme/2026/q4/reports/final/drafts/this-is-the-file-name.md";
    const shown = shortenPath(underHome(long, HOME));
    expect(shown.startsWith("~/Projects/clients/")).toBe(true);
    expect(shown.endsWith("drafts/this-is-the-file-name.md")).toBe(true);
    expect(shown).toContain("…");
    expect(shortenPath("~/a/b.md")).toBe("~/a/b.md");
  });
  test("zero-width characters in a name or a command show as their escapes", () => {
    expect(sealedEscape("con\u200Bfig")).toBe("conU+200Bfig");
    for (const c of ["\u200C", "\u200D", "\uFEFF"]) expect(sealedEscape(`a${c}b`)).toContain("U+");
  });
  test("\"always\" is worded from the stored rule: one test per shape, each naming every dimension the rule leaves open", () => {
    const rule = (kind: string, target: string, bot: string, computers: string) => ({ type: "rows" as const, rows: [{ label: "kind", value: kind }, { label: "target", value: target }, { label: "bot", value: bot }, { label: "computers", value: computers }] });
    const withRule = (r: ReturnType<typeof rule>) => ({ fields: { ...card("Edit", {}).fields, rule: r }, bot: "alpha", options: [{ remember: "always" }, {}] });
    // A file rule: the one file (whole, under ~), the bot, the computer.
    const file = alwaysSentence(withRule(rule("file", "/Users/k/Downloads/story.md", "alpha", "Delta")), "Alpha", HOME)!;
    expect(file).toBe("Always allow: edits to ~/Downloads/story.md, for Alpha, on Delta only.");
    // A command rule: the exact command, in any folder.
    const cmd = alwaysSentence(withRule(rule("command", "git status", "alpha", "Delta")), "Alpha", HOME)!;
    expect(cmd).toBe("Always allow: this exact command (git status), in any folder, for Alpha, on Delta only.");
    // A built-in's key alone: every call, whatever it touches.
    expect(alwaysSentence(withRule(rule("tool", "WebFetch", "alpha", "Delta")), "Alpha", HOME)).toBe("Always allow: every WebFetch call, whatever it touches, for Alpha, on Delta only.");
    expect(alwaysSentence(withRule(rule("plugin-tool", "mcp__x__thing", "alpha", "Delta")), "Alpha", HOME)).toBe("Always allow: every call to mcp__x__thing, whatever it is given, for Alpha, on Delta only.");
    expect(alwaysSentence(withRule(rule("other", "some key", "alpha", "Delta")), "Alpha", HOME)).toContain("this exact request (some key)");
    // Several computers are all named; a request naming no bot says exactly that, never "for Alpha".
    expect(alwaysSentence(withRule(rule("tool", "Read", "alpha", "Delta\nStudio")), "Alpha", HOME)).toContain("on Delta, Studio only");
    const none = alwaysSentence({ ...withRule(rule("tool", "Read", "", "Delta")), bot: undefined }, undefined, HOME)!;
    expect(none).toContain("for requests that name no bot");
    expect(none).not.toContain("Alpha");
    // A cut command or request says how much is hidden.
    const long = "x".repeat(100);
    expect(alwaysSentence(withRule(rule("command", long, "alpha", "Delta")), "Alpha", HOME)).toContain(`${"x".repeat(70)}… (30 more characters)`);
    expect(alwaysSentence(withRule(rule("other", long, "alpha", "Delta")), "Alpha", HOME)).toContain("(30 more characters)");
    expect(alwaysSentence(withRule(rule("command", "x".repeat(70), "alpha", "Delta")), "Alpha", HOME)).not.toContain("more characters");
    // A bot with no listed name is its id, capitalised; a card that offers no always, or has no rule, says nothing.
    expect(alwaysSentence(withRule(rule("tool", "Read", "alpha", "Delta")), undefined, HOME)).toContain("for Alpha");
    expect(alwaysSentence({ ...withRule(rule("tool", "Read", "alpha", "Delta")), options: [{}] }, "Alpha", HOME)).toBeUndefined();
    expect(alwaysSentence({ fields: {}, options: [{ remember: "always" }] }, "Alpha", HOME)).toBeUndefined();
    // The summary carries the same sentence.
    expect(summarize({ kind: "tool", ...withRule(rule("file", "/Users/k/a.md", "alpha", "Delta")) }, "Alpha", HOME)!.always).toContain("edits to ~/a.md");
  });
  test("a bot with no known name is its id, capitalised; no bot at all is \"A bot\"", () => {
    expect(summarize(card("Read", { file_path: "/a/b.txt" }))!.who).toBe("Alpha");
    expect(summarize({ kind: "tool", fields: card("Read", {}).fields })!.who).toBe("A bot");
    expect(nameFromId("b_my-helper")).toBe("My helper");
  });
  test("a card that is not a tool call, or names no tool, has no summary", () => {
    expect(summarize({ kind: "plugin-ok", fields: {} })).toBeUndefined();
    expect(summarize({ kind: "tool", fields: {} })).toBeUndefined();
  });
  test("a command is the command, a write is its path and size, another tool is its input as rows", () => {
    const bash = summarize(card("Bash", {}, { command: { type: "code", code: "git status\nls -la", language: "sh" }, detail: undefined }))!;
    expect(bash.verb).toBe("run a command");
    expect(bash.preview).toMatchObject({ kind: "lines", lines: ["git status", "ls -la"], hidden: 0 });
    const write = summarize(card("Write", { file_path: "/p/n.md", content: "one\ntwo\nthree\n" }))!;
    expect(write.preview).toMatchObject({ kind: "lines", label: "3 lines, 14 bytes", hidden: 0 });
    const other = summarize({ kind: "tool", fields: { what: { type: "code", code: "mcp__x__thing" }, detail: detail({ q: "hello", n: 3 }) } })!;
    expect(other.verb).toBe("use mcp__x__thing");
    expect(other.preview).toMatchObject({ kind: "rows", rows: [{ label: "q", value: "hello", cut: false }, { label: "n", value: "3", cut: false }] });
  });
});

describe("the preview", () => {
  test("an edit is a small diff with real line breaks, never the input's escaped JSON", () => {
    const s = summarize(card("Edit", { file_path: "/a/b.md", old_string: "one\ntwo", new_string: "uno\ndos\ntres" }))!;
    const html = previewHtml(s);
    expect(html).toContain('<div class="line del">');
    expect(html).toContain('<div class="line add">');
    expect(html).not.toContain("\\n");
    expect(html).not.toContain("old_string");
    expect(html).not.toContain("&quot;");
    expect(s.shortened).toBe(false);
  });
  test("a long edit shows a few lines, says how many it leaves out, and says it is shortened", () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const s = summarize(card("Edit", { file_path: "/a/b.md", old_string: many, new_string: "x" }))!;
    expect(s.shortened).toBe(true);
    const html = previewHtml(s);
    expect(html).toContain("14 more removed lines");
    expect(html).toContain("Shortened here");
    expect(html).toContain("Show everything");
  });
  test("a clipped input that is no longer JSON is not previewed (the card shows it whole instead)", () => {
    const s = summarize({ kind: "tool", fields: { what: { type: "text", text: "Edit" }, detail: { type: "code", code: '{\n  "file_path": "/a/b.md",\n  "old_string": "abc' } } })!;
    expect(s.preview).toBeUndefined();
  });
  test("every word is escaped", () => {
    const s = summarize(card("Write", { file_path: "/p/<img src=x>.md", content: `<script>bad()</script>‮` }))!;
    const page = summaryFieldPage({ cardId: "card_x", token: "se_1", field: "preview", summary: s });
    expect(page).not.toContain("<script>bad");
    expect(page).toContain("&lt;script&gt;bad()");
    expect(page).toContain("U+202E");
    expect(summaryFieldPage({ cardId: "card_x", token: "se_1", field: "summary", summary: s })).not.toContain("<img");
  });
});

describe("the fallback card", () => {
  const options = [{ id: "approve", kind: "approve" as const, label: "Approve" }, { id: "always", kind: "approve" as const, label: "Always allow", remember: "always" as const }, { id: "deny", kind: "deny" as const, label: "Deny" }];
  test("says the line, the preview and the buttons, with the whole input under \"Show everything\" and no raw JSON in what shows first", () => {
    const c = card("Edit", { file_path: "/Users/k/Downloads/story.md", old_string: "a\nb", new_string: "a\nc" }, { paths: { type: "code", code: "/Users/k/Downloads/story.md" } });
    const page = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: c.fields, options, summary: summarize(c, "Alpha", "/Users/k"), computer: "Delta" });
    const first = page.slice(page.indexOf("<main"), page.indexOf("<details"));
    expect(first).toContain("wants to edit");
    expect(first).toContain("~/Downloads/story.md");
    expect(first).toContain('class="line del"');
    expect(first).not.toContain("old_string");
    expect(page).toContain("<details");
    expect(page).toContain("Show everything this approves");
    // The whole sealed input stays on the card, for whoever opens it.
    expect(page).toContain("old_string");
    // Deny, then Always allow, then Approve last.
    expect(page.indexOf('data-option="deny"')).toBeLessThan(page.indexOf('data-option="always"'));
    expect(page.indexOf('data-option="always"')).toBeLessThan(page.indexOf('data-option="approve"'));
  });
  test("a toggle of \"Show everything\" restarts the wait before a press counts", () => {
    const page = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "T" } }, options });
    expect(page).toContain('document.addEventListener("toggle", moved, true)');
    expect(page).toContain("const moved = () => { openedAt = Date.now(); }");
  });
});

describe("what a decision rests on stays readable", () => {
  const e = { type: "text" as const, text: "Alpha wants to edit ~/.ssh/config" };
  test("a preview that is cut says so first, so nothing can clip the marker", () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const s = summarize(card("Edit", { file_path: "/a/b.md", old_string: many, new_string: many }, { paths: { type: "code", code: "/Users/k/b.md" } }), "Alpha", HOME)!;
    const html = previewHtml(s);
    expect(html.indexOf("Shortened here")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Shortened here")).toBeLessThan(html.indexOf('class="diff"'));
  });
  test("tokens that would hide the words are refused: see-through text, a tiny size", () => {
    const page = fieldPage({ cardId: "card_x", token: "se_001abcdef", field: "summary", value: e, tokens: { "card.text": "#FFFFFF00", "card.muted": "rgba(0,0,0,0.1)", "card.font.size": "1px", "card.approve.text": "#0004" } });
    expect(page).not.toContain("--clover-card-text:");
    expect(page).not.toContain("--clover-card-muted:");
    expect(page).not.toContain("--clover-card-font-size:");
    expect(page).not.toContain("--clover-card-approve-text:");
    const ok = fieldPage({ cardId: "card_x", token: "se_001abcdef", field: "summary", value: e, tokens: { "card.text": "#F2F2F2", "card.font.size": "14px" } });
    expect(ok).toContain("--clover-card-text: #F2F2F2;");
    expect(ok).toContain("--clover-card-font-size: 14px;");
    expect(readable("card.font.size", "40px")).toBe(true);
    expect(readable("card.font.size", "90px")).toBe(false);
  });
  test("the island's line and the fallback's are the same words", () => {
    const c = { ...card("Edit", { file_path: "~/Downloads/photos/config", old_string: "a", new_string: "b" }, { paths: { type: "code", code: "/Users/k/.ssh/config" }, rule: { type: "rows", rows: [{ label: "kind", value: "file" }, { label: "target", value: "/Users/k/.ssh/config" }, { label: "bot", value: "alpha" }, { label: "computers", value: "Delta" }] } }), options: [{ remember: "always" }, {}] };
    const s = summarize(c, "Alpha", HOME)!;
    const island = summaryFieldPage({ cardId: "card_x", token: "se_001abcdef", field: "summary", summary: s });
    const fallback = ownCardPage({
      cardId: "card_x", token: "se_001abcdef", origin: "user", issuedAt: 0, expiresAt: null, fields: c.fields, summary: s, always: s.always,
      options: [{ id: "always", kind: "approve", label: "Always allow", remember: "always" }, { id: "deny", kind: "deny", label: "Deny" }],
    });
    const line = askHtml(s);
    expect(island).toContain(line);
    expect(fallback).toContain(line);
    expect(fallback).toContain("Always allow: edits to ~/.ssh/config, for Alpha, on Delta only.");
  });
});

describe("text colours are an allow-list", () => {
  test("every see-through or unread form is refused for a text colour", () => {
    for (const v of ["transparent", "currentcolor", "currentColor", "var(--x)", "auto", "system", "rgba(0,0,0,0)", "rgb(0,0,0,0)", "rgb(0 0 0 / 0)", "rgb(0 0 0 / 0%)", "hsl(0 0% 0% / 0)", "hsla(0, 0%, 0%, 0)", "hsl(0 0% 0% / 10%)", "#0000", "#00000000", "#0004", "rgb(calc(1) 0 0)", "rgb(0 0)", "inherit", "notacolour", "rgb(0 0 0 / none)"]) {
      expect(readable("card.text", v), v).toBe(false);
      expect(readable("card.muted", v), v).toBe(false);
      expect(readable("card.approve.text", v), v).toBe(false);
    }
  });
  test("readable colours in every syntax are accepted, with the alpha read in each form", () => {
    for (const v of ["#fff", "#FFFFFF", "#ffffffff", "#fffe", "rgb(255,255,255)", "rgba(255, 255, 255, 0.9)", "rgb(255 255 255 / 90%)", "hsl(0 0% 100%)", "hsla(0, 0%, 100%, 1)", "white", "Black"]) expect(readable("card.text", v), v).toBe(true);
    expect(colourAlpha("rgb(1 2 3 / 25%)")).toBeCloseTo(0.25);
    expect(readable("card.background", "transparent")).toBe(true); // a background may be see-through: the host's own surface shows.
  });
  test("a page given a see-through text colour leaves it out", () => {
    for (const v of ["transparent", "rgb(0,0,0,0)", "hsl(0 0% 0% / 0)", "currentcolor"]) {
      const page = fieldPage({ cardId: "card_x", token: "se_001abcdef", field: "summary", value: { type: "text", text: "x" }, tokens: { "card.text": v } });
      expect(page, v).not.toContain("--clover-card-text:");
    }
  });
});

describe("a long path", () => {
  test("never cuts a dot, .git, .app or Library component, and says how many ordinary folders it cut", () => {
    const p = "~/Projects/some-very-long-client-name/another-long-folder/yet-another-folder/.git/modules/x/config";
    const shown = shortenPath(p);
    expect(shown).toContain("/.git/");
    expect(shown).toBe("~/Projects/some-very-long-client-name/…(2 folders)/.git/…(1 folder)/x/config");
    expect(shortenPath("~/Projects/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/Library/cccccccccccccccccccccc/dddd/e.txt")).toContain("/Library/");
    expect(shortenPath("~/Projects/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/Foo.app/cccccccccccccccccccccc/dddd/e.txt")).toContain("/Foo.app/");
    expect(shortenPath("~/Projects/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/repo.git/cccccccccccccccccccccc/dddd/e.txt")).toContain("/repo.git/");
  });
  test("\"asked as\" keeps its marker when it is cut", () => {
    const long = `~/${"d".repeat(120)}/config`;
    const s = summarize(card("Edit", { file_path: long, old_string: "a", new_string: "b" }, { paths: { type: "code", code: "/Users/k/.ssh/config" } }), "Alpha", HOME)!;
    expect(s.asked!.endsWith("…")).toBe(true);
    expect(s.asked!.length).toBe(80);
  });
});
