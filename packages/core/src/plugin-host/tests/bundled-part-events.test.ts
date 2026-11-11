// Every core event a bundled part listens for, it can hear (§5.5): the event is a core event sent to a `layer`, the
// part's own grant (its manifest's capabilities, which a bundled plugin's OK grants) holds the capability the event
// needs, and its area is one the SDK subscribes the part's connection to. A part that listens for an event it can't
// hear waits for nothing, silently (the plugin index's card notes did): this walk fails instead.
//
// What a part listens for is read from its client code (not its tests or gallery):
// * `useCore().on(type)`: every string literal naming a core event in a file that uses `useCore`; `on` subscribes an
//   area only for the SDK's `EVENT_AREAS`, so the event must be there too;
// * the SDK's hooks and watchers that listen for one: `useApprovals` (card_pending, card_resolved), `api.bots.watch`
//   (bot_changed), `api.computers.watch` (computer_changed), `api.devices.watch` (device_changed), `api.settings.watch`
//   (plugin_changed).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_EVENTS } from "@waifucave/clover-protocol";
import { EVENT_AREAS } from "../../../../plugin-sdk/src/ui/event-areas";

const PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins");

/** Parts that listen for an event they can't hear today, each with the lane fixing it: the walk must find exactly
 *  these, so a fix removes its entry and a new gap fails the test. No manifest gains a grant here: a grant to a bundled
 *  part is a who-may-see change, decided by the controller.
 *  - `clover/plugin-index`: its card notes and resolved cards need `plugins.install` and `approvals` (lane B's events
 *    head grants them and removes those two lines); `plugin_changed`, `plugin_found` and `plugin_removed` go to the app
 *    and the CLI only (lane B is wiring the registry's transitions to events gated for layers).
 *  The SDK's `api.settings.watch` hears `plugin_changed` too, so it never fires in any part until then; no bundled part
 *  uses it now. */
const KNOWN: Record<string, string[]> = {};

const SKIP_DIRS = new Set(["test", "tests", "gallery", "node_modules", "host", "server", "stdio", "dist", "out", "fixtures", "bot", "skills", "agents", "locales"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !(name === "plugins" && existsSync(join(dir, "clover.json")))) out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every bundled plugin with a client: the `clover` tree's parts and Alpha's. */
function parts(): { id: string; dir: string; capabilities: string[] }[] {
  const out: { id: string; dir: string; capabilities: string[] }[] = [];
  const add = (id: string, dir: string) => {
    const file = join(dir, "clover.json");
    if (!existsSync(file)) return;
    const m = JSON.parse(readFileSync(file, "utf8")) as { client?: unknown; capabilities?: string[] };
    if (m.client !== undefined) out.push({ id, dir, capabilities: m.capabilities ?? [] });
    const kids = join(dir, "plugins");
    if (existsSync(kids)) for (const k of readdirSync(kids)) add(`${id}/${k}`, join(kids, k));
  };
  add("clover", join(PLUGINS, "clover"));
  add("alpha", join(PLUGINS, "alpha"));
  return out;
}

const WATCHERS: [RegExp, string[]][] = [
  [/\buseApprovals\(/, ["card_pending", "card_resolved"]],
  [/\.bots\??\.watch\??\(/, ["bot_changed"]],
  [/\.computers\??\.watch\??\(/, ["computer_changed"]],
  [/\.devices\??\.watch\??\(/, ["device_changed"]],
  [/\.settings\??\.watch\??\(/, ["plugin_changed"]],
  [/\.points\??\.watch\??\(/, ["plugin_point_changed"]],
];

/** What a part listens for: each event, and whether it is heard through `useCore().on` (which needs `EVENT_AREAS`). */
function listened(dir: string): Map<string, { viaOn: boolean }> {
  const out = new Map<string, { viaOn: boolean }>();
  const names = new Set(CLOVER_EVENTS.keys());
  for (const file of sources(dir)) {
    const text = readFileSync(file, "utf8");
    if (/\buseCore\(/.test(text) && /\.on\(/.test(text)) {
      for (const m of text.matchAll(/["'`]([a-z][a-z_]+)["'`]/g)) if (names.has(m[1]!) || /_(changed|removed|found|note|pending|resolved)$/.test(m[1]!)) out.set(m[1]!, { viaOn: true });
    }
    for (const [re, events] of WATCHERS) if (re.test(text)) for (const e of events) if (!out.has(e)) out.set(e, { viaOn: false });
  }
  return out;
}

/** Why a part can't hear `type`, or undefined when it can. */
function cannotHear(part: { id: string; capabilities: string[] }, type: string, viaOn: boolean): string | undefined {
  const spec = CLOVER_EVENTS.get(type);
  if (spec === undefined) return `${type}: no such core event`;
  if (spec.scope !== "core") return `${type}: a ${spec.scope} event, not sent as core.event`;
  if (!spec.roles.includes("layer")) return `${type}: not sent to a layer`;
  if (spec.capability !== undefined && !part.capabilities.includes(spec.capability)) return `${type}: needs ${spec.capability}, which ${part.id}'s manifest doesn't list`;
  if (viaOn && EVENT_AREAS[type] === undefined) return `${type}: useCore().on never subscribes its area (not in the SDK's EVENT_AREAS)`;
  return undefined;
}

describe("the bundled parts' events", () => {
  const all = parts();

  test("the walk finds the parts, and what they listen for", () => {
    expect(all.length).toBeGreaterThan(15);
    expect(all.some((p) => p.id === "alpha")).toBe(true);
    // The island listens for cards; the plugin index for its card notes.
    expect([...listened(all.find((p) => p.id === "clover/island")!.dir).keys()]).toContain("card_pending");
    expect([...listened(all.find((p) => p.id === "clover/plugin-index")!.dir).keys()]).toContain("plugin_card_note");
  });

  test("each part hears every event it listens for (the known exceptions listed with their lane)", () => {
    const failing: Record<string, string[]> = {};
    for (const part of all) {
      const why = [...listened(part.dir)].map(([type, { viaOn }]) => cannotHear(part, type, viaOn)).filter((w): w is string => w !== undefined).sort();
      if (why.length > 0) failing[part.id] = why;
    }
    expect(failing).toEqual(KNOWN);
  });
});
