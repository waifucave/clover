// What a tool card says in a line and a preview (`card-summary.ts`), and how the sealed pages draw it: the one line,
// real line breaks (never the call's input as escaped JSON), a preview that says where it leaves something out, and
// every word escaped (spec §5.5).
import { describe, expect, test } from "bun:test";
import { nameFromId, placeOf, summarize } from "../src/main/card-summary";
import { askHtml, ownCardPage, previewHtml, summaryFieldPage } from "../src/main/sealed-pages";

const detail = (input: unknown) => ({ type: "code" as const, code: JSON.stringify(input, null, 2), language: "json" });
const card = (what: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  kind: "tool", bot: "alpha",
  fields: { title: { type: "text", text: "Change files" }, what: { type: "text", text: what }, detail: detail(input), computer: { type: "code", code: "Delta" }, ...extra },
});

describe("the one line", () => {
  test("an edit says who wants to edit which file, and where", () => {
    const s = summarize(card("Edit", { file_path: "/Users/k/Downloads/story_of_egypt.md", old_string: "a\nb", new_string: "a\nc" }, { paths: { type: "code", code: "/Users/k/Downloads/story_of_egypt.md" } }), "Alpha")!;
    expect(askHtml(s)).toContain("Alpha");
    expect(s).toMatchObject({ who: "Alpha", verb: "edit", target: "story_of_egypt.md", where: "Downloads" });
  });
  test("a bot with no known name is its id, capitalised; no bot at all is \"A bot\"", () => {
    expect(summarize(card("Read", { file_path: "/a/b.txt" }))!.who).toBe("Alpha");
    expect(summarize({ kind: "tool", fields: card("Read", {}).fields })!.who).toBe("A bot");
    expect(nameFromId("b_my-helper")).toBe("My helper");
    expect(placeOf("/x/y/z.txt")).toEqual({ name: "z.txt", folder: "y" });
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
    const c = card("Edit", { file_path: "/Users/k/Downloads/story.md", old_string: "a\nb", new_string: "a\nc" });
    const page = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: c.fields, options, summary: summarize(c, "Alpha"), computer: "Delta" });
    const first = page.slice(page.indexOf("<main"), page.indexOf("<details"));
    expect(first).toContain("wants to edit");
    expect(first).toContain("story.md");
    expect(first).toContain("Downloads");
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
