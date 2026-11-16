// F1 (the owner's ruling of 2026-11-15: no infrastructure in the core or the app that only one plugin uses): voice is MOSS
// Voice's, a plugin built on general capabilities, and nothing of the platform names it. No file, protocol method,
// capability, core point, plugin API call, device turn or code identifier of the core, the app, the plugin SDK or the protocol
// says "voice"; prose may (a doc string, an error's words). The scan reads the sources, not the tests, with each exemption
// named and why.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MOSS_METHODS } from "@waifucave/moss-protocol";
import { API_CALLS, CAPABILITIES, CORE_CONTRIBUTION_KEYS, CORE_POINTS, DEVICE_TURNS, LISTENER_ARGS } from "@waifucave/moss-plugin-sdk";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DIRS = ["packages/core/src", "apps/desktop/src", "packages/plugin-sdk/src", "packages/protocol/src"] as const;
const VOICE = /voice/i;

/** A relative path with `/` between its parts, whatever the OS: the exemptions below name files that way. */
const slashed = (p: string): string => p.split(sep).join("/");

/** Files that may name it, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  "packages/core/src/migration/settings-moved-to-plugins.ts": "the one-time move's data rows: where a home's old voice settings were, and MOSS Voice's keys they move to",
  "packages/plugin-sdk/src/manifest/schema.ts": "the `contributes.bot.voice` shim: an old manifest's field, accepted and ignored",
  "packages/plugin-sdk/src/manifest/validate.ts": "the same shim's `bot_voice` warning, which says where a bot's default voice goes now",
  "apps/desktop/src/layer/moss/ids.ts": "the build's own bundled plugins, by id",
  "apps/desktop/src/layer/moss/index.ts": "the build's own bundled plugins' code, by id",
  "packages/core/src/runtime-sdk/host/run-home/settings.ts": "the agent runtime's own settings keys (its `voice`, `voiceEnabled`), not MOSS's",
  "apps/desktop/src/main/browser/screen-reader.ts": "macOS's VoiceOver, a screen reader",
  "packages/core/src/identity/wordlist.ts": "a list of words for names, one of which is the word itself",
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir })) {
    if (/(^|\/)(tests?|__tests__|node_modules|fixtures|conformance)\//.test(slashed(f)) || /\.test\.tsx?$/.test(f)) continue;
    out.push(join(dir, f));
  }
  return out;
}

/** A source split into its code (comments and strings blanked) and its string literals (a template's whole text as one). */
function split(src: string): { code: string; strings: string[] } {
  let code = "";
  const strings: string[] = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      strings.push(src.slice(i + 1, j));
      code += " ";
      i = j + 1;
    } else {
      code += c;
      i++;
    }
  }
  return { code, strings };
}

describe("nothing of the platform names voice", () => {
  test("no file is named for it", () => {
    const named = DIRS.flatMap((d) => sources(join(ROOT, d))).map((f) => slashed(relative(ROOT, f))).filter((f) => VOICE.test(f));
    expect(named).toEqual([]);
  });

  test("no protocol method, capability, core point, manifest key, plugin API call or device turn", () => {
    const names = [
      ...[...MOSS_METHODS.keys()].map((m) => `method ${m}`),
      ...CAPABILITIES.map((c) => `capability ${c.name}`),
      ...CORE_POINTS.map((p) => `core point ${p.name}`),
      ...CORE_CONTRIBUTION_KEYS.map((k) => `manifest key ${k}`),
      ...Object.keys(API_CALLS).map((k) => `API call ${k}`),
      ...Object.keys(LISTENER_ARGS).map((k) => `listener ${k}`),
      ...DEVICE_TURNS.map((t) => `turn ${t.name}`),
    ];
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => VOICE.test(n))).toEqual([]);
  });

  for (const dir of DIRS) {
    test(`no identifier or name-like string in ${dir}`, () => {
      const files = sources(join(ROOT, dir));
      expect(files.length).toBeGreaterThan(10);
      const hits: string[] = [];
      for (const f of files) {
        const at = slashed(relative(ROOT, f));
        if (EXEMPT[at] !== undefined) continue;
        const { code, strings } = split(readFileSync(f, "utf8"));
        for (const id of code.match(/[A-Za-z_$][\w$]*/g) ?? []) if (VOICE.test(id)) hits.push(`${at}: identifier ${id}`);
        // A string with no space is a name (a method, a key, a path, an id); prose has spaces and may say it.
        for (const s of strings) if (!/\s/.test(s) && VOICE.test(s)) hits.push(`${at}: "${s.slice(0, 80)}"`);
      }
      expect(hits).toEqual([]);
    });
  }

  test("each exemption is still needed (it names it)", () => {
    for (const [at, why] of Object.entries(EXEMPT)) expect({ at, why, names: VOICE.test(readFileSync(join(ROOT, at), "utf8")) }).toEqual({ at, why, names: true });
  });
});
