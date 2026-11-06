// Live gate 5's run of spike S4, against Fish Audio itself, with the owner's own key. Nothing else runs this: the
// tests run the same measurements against the recorded fake (test/s4.test.ts).
//
//   bun plugins/clover/plugins/fish-audio/scripts/s4-live.ts --live [--voice <id>] [--runs <n>] [--paid] [--save <dir>]
//
// It asks for the key with input that isn't shown, or reads it as the first line piped in (a password manager's
// command), so the key never sits in the shell's history or the environment. It is added only to requests for
// https://api.fish.audio (a redirect fails rather than carry it elsewhere) and never printed: the report is the JSON
// on stdout, progress goes to stderr. The first
// audio of each text is saved as WAV, in `--save <dir>` or a new temporary folder, for the owner to listen to; nothing
// is played. The free model costs nothing; `--paid` also measures s2.1-pro, about six cents at the default 5 runs, and
// the round trip's listening costs a fraction of a cent.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcm16ToWav } from "../src/audio";
import { FISH_ORIGIN, realTimer, type FetchLike } from "../src/fish";
import { runS4 } from "../src/s4";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!flag("--live")) {
  console.error("s4-live: this calls Fish Audio with a real key, so it runs only with --live (live gate 5)");
  process.exit(2);
}
/** The key: typed at a prompt that shows nothing, or the first line piped in. */
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) return ((await new Response(Bun.stdin.stream()).text()).split(/\r?\n/)[0] ?? "").trim();
  process.stderr.write("Fish Audio API key (not shown): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve) => {
    let typed = "";
    const done = (key: string) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      resolve(key);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(typed.trim());
        if (ch === "\u0003") return done("");
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const key = await readKey();
if (key === "") {
  console.error("s4-live: no key was given");
  process.exit(2);
}

const runs = value("--runs");
if (runs !== undefined && !(Number.isInteger(Number(runs)) && Number(runs) >= 1 && Number(runs) <= 50)) {
  console.error("s4-live: --runs is a whole number from 1 to 50");
  process.exit(2);
}
const voice = value("--voice");
const saveTo = value("--save") ?? mkdtempSync(join(tmpdir(), "clover-s4-"));
mkdirSync(saveTo, { recursive: true });

const withKey: FetchLike = (url, init = {}) => {
  if (new URL(url).origin !== FISH_ORIGIN) return Promise.reject(new Error(`s4-live only talks to ${FISH_ORIGIN}`));
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: "error" });
};

const report = await runS4({
  fetch: withKey,
  timer: realTimer,
  ...(voice === undefined ? {} : { voice }),
  ...(runs === undefined ? {} : { runs: Number(runs) }),
  comparePaid: flag("--paid"),
  onProgress: (line) => console.error(line),
  onAudio: ({ model, kind, pcm, sampleRate }) => {
    const file = join(saveTo, `${model}-${kind}.wav`);
    writeFileSync(file, pcm16ToWav(pcm, sampleRate));
    console.error(`s4-live: saved ${file}`);
  },
});
console.log(JSON.stringify(report, null, 2).split(key).join("<key>"));
