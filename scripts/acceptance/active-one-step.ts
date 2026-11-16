// P4 on the app (the owner's general capability, 2026-11-15: "the active one"), a window row: a point that takes one
// filler at a time. A folder plugin declares `acc-deck.mode` (`oneAtATime`, titled "Acceptance deck mode"), and three
// folder plugins fill it, none bundled, so the default is the first installed. Its host half reads the active one
// (`points.active`) and keeps what `points.onActive` heard; a filler's host half reads it too. Settings › Plugins draws one
// picker titled by the point's title, the user's press picks the second, the declarer hears it; the second turned off,
// the first stands in (the row says so, the daemon tells the user once), and turned on again it is the one again. Kept
// apart from ui-steps.ts so the fixtures and the verdict are unit-tested.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ACTIVE_POINT = "acc-deck.mode";
export const ACTIVE_TITLE = "Acceptance deck mode";
export const ACTIVE_IDS = { deck: "acc-deck", one: "acc-deck-one", two: "acc-deck-two", three: "acc-deck-three" } as const;
export const ACTIVE_NAMES = { one: "First deck mode", two: "Second deck mode", three: "Third deck mode" } as const;
/** An entry's ref as the fixture's host halves say it. */
export const refText = (pluginId: string, entryId: string) => `${pluginId}/${entryId}`;

/** Every host half: `active` says which entry is active now and what `onActive` heard since it started. */
const HOST = [
  "// The acceptance run's P4 fixture (written by the run).",
  "let api;",
  "const heard = [];",
  `const say = (a) => (a ? \`\${a.pluginId}/\${a.entryId}\` : "none");`,
  `export async function start(a) { api = a; api.points.onActive(${JSON.stringify(ACTIVE_POINT)}, (x) => heard.push(say(x))); }`,
  "export async function stop() {}",
  `export async function active() { return { active: say(await api.points.active(${JSON.stringify(ACTIVE_POINT)})), heard }; }`,
  "",
].join("\n");

const COMMAND = { name: "active", description: "Says which deck mode is active and what it heard", handler: "active", args: { type: "object", additionalProperties: false } };

function write(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(join(dir, "host"), { recursive: true });
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(dir, "host", "index.js"), HOST);
  return dir;
}

/** The declarer and its three fillers, as folders under `root`, in the order the row installs them. */
export function writeActiveOne(root: string): { deck: string; one: string; two: string; three: string } {
  const engines = { moss: "^1.0.0" };
  const host = { entry: "host/index.js", runtime: "bun" };
  const deck = write(join(root, ACTIVE_IDS.deck), {
    manifest: 1, id: ACTIVE_IDS.deck, name: "Acceptance deck", version: "1.0.0", engines,
    host: { ...host, declares: { [ACTIVE_POINT]: { shape: "list", oneAtATime: true, title: ACTIVE_TITLE, fields: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }, doc: "A deck mode: one is used at a time." } } },
    contributes: { commands: [COMMAND] },
  });
  const filler = (key: "one" | "two" | "three") => write(join(root, ACTIVE_IDS[key]), {
    manifest: 1, id: ACTIVE_IDS[key], name: `Acceptance ${ACTIVE_NAMES[key].toLowerCase()}`, version: "1.0.0", engines, host,
    contributes: { commands: [COMMAND], [ACTIVE_POINT]: [{ id: key, name: ACTIVE_NAMES[key] }] },
  });
  return { deck, one: filler("one"), two: filler("two"), three: filler("three") };
}

/** What the row saw at each stage. */
export interface ActiveSeen {
  /** The declarer's `active` before any pick, the picker's title and options (name and pressed) as drawn. */
  before: string;
  picker: { title: string; options: [string, boolean][] } | undefined;
  /** After the user's press on the second: the declarer's answer and what it heard, and the second filler's own. */
  picked: { active: string; heard: string[] };
  fillerSees: string;
  /** The second turned off: the declarer's answer, the row's note, the daemon's notice line. */
  off: { active: string; note: string; notice: boolean };
  /** Turned on again. */
  back: string;
}

/** What is wrong with what the row saw; empty when the default was the first installed, the picker was titled by the
 *  point's title with the three fillers and the active one pressed, the user's press made the second active (heard by the
 *  declarer, read by the filler), the second off let the first stand in with the note and one notice, and turned on
 *  again the second was the one. */
export function activeWrong(s: ActiveSeen): string[] {
  const wrong: string[] = [];
  const one = refText(ACTIVE_IDS.one, "one");
  const two = refText(ACTIVE_IDS.two, "two");
  if (s.before !== one) wrong.push(`before any pick the active one was ${s.before}, not the first installed (${one})`);
  if (s.picker === undefined) wrong.push(`Settings drew no picker titled "${ACTIVE_TITLE}"`);
  else {
    const names = s.picker.options.map(([n]) => n);
    if (JSON.stringify(names) !== JSON.stringify([ACTIVE_NAMES.one, ACTIVE_NAMES.two, ACTIVE_NAMES.three])) wrong.push(`the picker offered ${names.join(", ") || "nothing"}`);
    if (s.picker.options.find(([, on]) => on)?.[0] !== ACTIVE_NAMES.one) wrong.push("the picker didn't show the first as the one in use");
  }
  if (s.picked.active !== two) wrong.push(`after the press the active one was ${s.picked.active}, not ${two}`);
  if (!s.picked.heard.includes(two)) wrong.push(`the declarer's onActive didn't hear the pick (${s.picked.heard.join(", ") || "nothing"})`);
  if (s.fillerSees !== two) wrong.push(`the second filler read ${s.fillerSees}, not itself`);
  if (s.off.active !== one) wrong.push(`with the second off the active one was ${s.off.active}, not the first standing in`);
  if (!s.off.note.includes(`so ${ACTIVE_NAMES.one} is used for now`)) wrong.push(`the picker didn't say the first stands in (${s.off.note || "no note"})`);
  if (!s.off.notice) wrong.push("the daemon didn't tell the user the second stopped and the first took its place");
  if (s.back !== two) wrong.push(`turned on again, the active one was ${s.back}, not the user's pick`);
  return wrong;
}
