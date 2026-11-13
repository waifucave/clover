// The class behind "Your answer didn't go through": a bundled part's client calls a layer method that names a capability
// (`capabilityRefusal`, auth/clover-caller.ts), and its manifest's OK doesn't list it. A static walk: for every bundled
// plugin under plugins/clover/plugins/*, plugins/clover and plugins/alpha, the methods its client code names (a method's
// wire name as a string, or an SDK member that calls one) against the manifest's `capabilities`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLOVER_METHODS } from "@waifucave/clover-protocol";

const ROOT = resolve(import.meta.dir, "../../..");

/** The SDK's `usePluginApi` members that call one layer method each (packages/plugin-sdk/src/ui/index.tsx). */
const MEMBERS: Record<string, string[]> = {
  "conversation.list": ["session.list"], "conversation.get": ["session.get"], "conversation.answer": ["session.answer"],
  "conversation.history": ["session.history"], "conversation.follow": ["session.attach", "session.detach"],
  "bots.list": ["bot.list"], "bots.get": ["bot.get"], "bots.watch": [],
  "computers.list": ["computer.list"], "computers.get": ["computer.get"],
  "devices.list": ["device.list"],
  "approvals.pending": ["card.pending"], "approvals.watch": ["card.pending"],
  "browser.tabs": ["browser.tabs"], "browser.open": ["browser.open"], "browser.close": ["browser.close"], "browser.navigate": ["browser.navigate"],
  "browser.show": ["browser.show"], "browser.hide": ["browser.hide"], "browser.screenshot": ["browser.screenshot"], "browser.cdp": ["browser.cdp"],
};

const plugins = (): { id: string; dir: string }[] => {
  const out = [{ id: "clover", dir: join(ROOT, "plugins/clover") }, { id: "alpha", dir: join(ROOT, "plugins/alpha") }];
  const base = join(ROOT, "plugins/clover/plugins");
  for (const d of readdirSync(base)) out.push({ id: `clover/${d}`, dir: join(base, d) });
  const sub = join(ROOT, "plugins/alpha/plugins");
  if (existsSync(sub)) for (const d of readdirSync(sub)) out.push({ id: `alpha/${d}`, dir: join(sub, d) });
  return out.filter((p) => existsSync(join(p.dir, "clover.json")));
};

const sources = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "test" || name === "tests" || name === "gallery" || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

/** The client code of a plugin: the folder of its `client.entry` (and `tab`, Alpha's own layer parts). */
const clientFiles = (dir: string): string[] => {
  const m = JSON.parse(readFileSync(join(dir, "clover.json"), "utf8")) as { client?: { entry?: string } };
  const roots = new Set<string>();
  if (m.client?.entry !== undefined) roots.add(join(dir, dirname(m.client.entry)));
  if (existsSync(join(dir, "client"))) roots.add(join(dir, "client"));
  return [...roots].filter((r) => existsSync(r)).flatMap(sources);
};

/** Each capability-named layer method a plugin's client code calls, with where. */
export function walk(dir: string): { method: string; capability: string; file: string }[] {
  const found = new Map<string, { method: string; capability: string; file: string }>();
  for (const file of clientFiles(dir)) {
    const text = readFileSync(file, "utf8");
    const add = (method: string): void => {
      const spec = CLOVER_METHODS.get(method);
      if (spec?.capability === undefined || spec.capability === "call:*" || !spec.roles.includes("layer")) return;
      if (!found.has(method)) found.set(method, { method, capability: spec.capability, file: file.slice(ROOT.length + 1) });
    };
    // A method's wire name as the first argument of a call on the plugin's own connection (`call("x", …)`, `api("x")`), not a label
    // in a table, and not `core.call`: the clover tree's `useCore` is the user's call, which no capability gate judges.
    for (const m of text.matchAll(/(?<!core\??\.)(?:call|request|invoke|api|ask)\w*\s*(?:<[^()]*>)?\(\s*["'`]([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)+)["'`]/g)) if (CLOVER_METHODS.has(m[1]!)) add(m[1]!);
    // An SDK member that calls one (`api.conversation.answer(…)`, through `conv`, the usual name for `api.conversation`).
    for (const m of text.matchAll(/\b(conv|conversation|bots|computers|devices|approvals|browser)\??\.([a-zA-Z]+)\??\.?\(/g)) for (const method of MEMBERS[`${m[1] === "conv" ? "conversation" : m[1]}.${m[2]}`] ?? []) add(method);
  }
  return [...found.values()];
}

describe("a bundled part's manifest lists the capability of each layer method its client calls", () => {
  test("the walk finds the conversation part's session.answer (the case that was refused)", () => {
    const conv = plugins().find((p) => p.id === "clover/conversation")!;
    expect(walk(conv.dir).map((c) => c.method)).toContain("session.answer");
  });

  for (const p of plugins()) {
    test(`${p.id}`, () => {
      const manifest = JSON.parse(readFileSync(join(p.dir, "clover.json"), "utf8")) as { capabilities?: string[] };
      const listed = manifest.capabilities ?? [];
      const missed = walk(p.dir).filter((c) => !listed.includes(c.capability)).map((c) => `${c.method} needs ${c.capability} (${c.file})`);
      expect(missed).toEqual([]);
    });
  }
});
