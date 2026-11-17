// A sealed page never overflows its frame and never shows a scroll bar (lane RT, the CI lane's finding): with classic scroll
// bars (macOS "Show scroll bars: Always", or by default with a mouse that has no scroll surface; GitHub's macOS runner) a button
// page that overflowed its frame by its status line got space-taking bars, the button showed 47.5% of itself, and every
// press was refused `not-visible`: Approve did nothing, anywhere. This lays the pages out in a real Electron (offscreen, never
// shown; test/sealed-layout/main.mjs) at every label length, language, look and font size the cards use, in a frame sized as a
// part sizes it (the page's own report) and an own card window sized as the app sizes it, and measures inside each page, as
// laid out and with classic bars forced on that one document (never a system setting).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as codePages from "../src/main/sealed-pages";
import * as mossPages from "../../moss/src/main/sealed-pages";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.MOSS_UI_TESTS === "1";
const localElectron = process.env.MOSS_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");

function electron(): string {
  if (localElectron !== undefined && localElectron !== "") {
    // A local run's Electron never comes to the front: the background-only copy (scripts/background-electron.ts).
    if (process.platform === "darwin") {
      const v = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", join(dirname(dirname(localElectron)), "Info.plist")], { encoding: "utf8" });
      if (v.status !== 0 || v.stdout.trim() !== "true") throw new Error("MOSS_UI_LOCAL_ELECTRON is not a background-only Electron");
    }
    return localElectron;
  }
  return createRequire(join(root, "package.json"))("electron") as string;
}

const TOKEN = "t".repeat(43);
const LABELS: Record<string, string> = {
  allow: "Allow", deny: "Deny", once: "Allow once", session: "Allow for this session", always: "Always allow", approve: "Approve",
  open: "Open MOSS Code", german: "Für diese Sitzung immer erlauben", japanese: "このセッションでは常に許可する", arabic: "السماح دائمًا لهذه الجلسة",
  emoji: "✅ Allow 🚀", long: "Allow this plugin to read every file in the project folder and the shared notes, for this session only",
  longest: "Allow ".repeat(60).trim(),
};
const FONTS: Record<string, string | undefined> = { default: undefined, small: "11px", large: "40px" };

interface Case { name: string; kind: "button" | "own"; html: string }
function cases(app: "MOSS Code" | "MOSS", { buttonPage, ownCardPage }: typeof codePages): Case[] {
  const out: Case[] = [];
  for (const [ln, label] of Object.entries(LABELS)) {
    for (const [fn, size] of Object.entries(FONTS)) {
      const tokens = size === undefined ? undefined : ({ "card.font.size": size } as Record<string, string>);
      for (const [kind, remember] of [["approve", undefined], ["deny", undefined], ["approve", "always"]] as const) {
        out.push({ name: `button ${kind}${remember ? " always" : ""} "${ln}" font ${fn}`, kind: "button", html: buttonPage({ cardId: "card_x", token: TOKEN, option: "o", label, kind, ...(remember ? { remember } : {}), ...(tokens ? { tokens } : {}) }) });
      }
    }
  }
  for (const look of ["check", "cross", "open"] as const) out.push({ name: `glyph ${look}`, kind: "button", html: buttonPage({ cardId: "card_x", token: TOKEN, option: "o", label: "Allow", kind: look === "cross" ? "deny" : "approve", look }) });
  const options = [{ id: "allow_once", kind: "approve" as const, label: "Allow once" }, { id: "always", kind: "approve" as const, label: "Always allow", remember: "always" as const }, { id: "deny", kind: "deny" as const, label: "Deny" }];
  out.push({ name: "own card, short", kind: "own", html: ownCardPage({ cardId: "card_x", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Run a command?" } }, options }) });
  out.push({ name: "own card, long labels", kind: "own", html: ownCardPage({ cardId: "card_x", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Run a command?" } }, options: options.map((o) => ({ ...o, label: LABELS.long! })) }) });
  // A very long unbroken word (a path, a hash, a URL with no break) in the title, a field and a label: it wraps, never widens the card.
  const word = "x".repeat(600);
  out.push({ name: "own card, a very long unbroken word", kind: "own", html: ownCardPage({ cardId: "card_x", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: `Open ${word}?` }, command: { type: "code", code: `cat /${word}/${word}`, language: "sh" }, detail: { type: "text", text: `https://example.com/${word}` } }, options: options.map((o, i) => (i === 0 ? { ...o, label: word.slice(0, 200) } : o)) }) });
  out.push({ name: "own card, taller than its window", kind: "own", html: ownCardPage({ cardId: "card_x", token: TOKEN, origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Run a command?" }, command: { type: "code", code: Array.from({ length: 120 }, (_, i) => `echo line ${i}`).join("\n"), language: "sh" }, detail: { type: "text", text: "word ".repeat(600) } }, options }) });
  return out.map((c) => ({ ...c, name: `${app}: ${c.name}` }));
}

interface Measured { name: string; classic: boolean; error?: string; frame: { width: number; height: number }; scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; innerWidth: number; innerHeight: number; buttons: { left: number; top: number; right: number; bottom: number }[] }

describe.if(enabled)("a sealed page never overflows its frame and never shows a scroll bar (real Electron, offscreen)", () => {
  test("every button kind, label, language and font size; the own card; with and without classic scroll bars", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-sealed-layout-"));
    try {
      // Both apps' copies of the sealed pages (MOSS keeps its own, apps/moss/src/main/sealed-pages.ts).
      const all = [...cases("MOSS Code", codePages), ...cases("MOSS", mossPages as unknown as typeof codePages)];
      const input = join(dir, "in.json");
      const out = join(dir, "out.json");
      writeFileSync(input, JSON.stringify({ cases: all, own: { width: 440, minHeight: 190, maxHeight: 560 } }));
      const env: NodeJS.ProcessEnv = { ...process.env, MOSS_LAYOUT_IN: input, MOSS_LAYOUT_OUT: out };
      delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(electron(), [`--user-data-dir=${join(dir, "user-data")}`, join(import.meta.dir, "sealed-layout", "main.mjs")], { env, encoding: "utf8", timeout: 240_000 });
      expect(existsSync(out), `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000)).toBe(true);
      const got = JSON.parse(readFileSync(out, "utf8")) as Measured[];
      expect(got).toHaveLength(all.length * 2);
      const faults: string[] = [];
      for (const m of got) {
        const at = `${m.name}${m.classic ? " (classic bars)" : ""}`;
        if (m.error !== undefined) { faults.push(`${at}: ${m.error}`); continue; }
        // No scroll bar takes any room, either way.
        if (m.clientWidth !== m.innerWidth || m.clientHeight !== m.innerHeight) faults.push(`${at}: a scroll bar takes room (client ${m.clientWidth}x${m.clientHeight} of ${m.innerWidth}x${m.innerHeight})`);
        // Nothing overflows sideways.
        if (m.scrollWidth > m.clientWidth) faults.push(`${at}: overflows sideways (${m.scrollWidth} > ${m.clientWidth})`);
        // A button page fits its frame whole; an own card may run taller than its window (the window's own cap), never wider.
        if (!m.name.includes(": own") && m.scrollHeight > m.clientHeight) faults.push(`${at}: overflows its frame (${m.scrollHeight} > ${m.clientHeight}, frame ${m.frame.width}x${m.frame.height})`);
        // Every sealed button shows whole inside the page's visible area.
        for (const b of m.buttons) if (b.left < 0 || b.top < 0 || b.right > m.clientWidth + 0.5 || b.bottom > m.clientHeight + 0.5) faults.push(`${at}: a button isn't whole in view (${JSON.stringify(b)} in ${m.clientWidth}x${m.clientHeight})`);
      }
      expect(faults, faults.slice(0, 30).join("\n")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
