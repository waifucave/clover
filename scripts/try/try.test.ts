// scripts/try: the owner's one-command try (run.sh), its static checks (verify.sh), the acceptance watchdog
// (watch.sh) and the per-step table (table.ts). The shell scripts drive a Developer ID build and a packaged app on the
// owner's Mac, so here only their shape is held: they parse, they name no machine's own paths, and they keep the
// rules a try runs under; the table is tested on run.ts's own output.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatTable, parseRunTable, shownStatus } from "./table";

const DIR = import.meta.dir;
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

const RUN_OUT = `acceptance: step 1: PASS: whatever
| # | step | result | detail
|---|---|---|---
| 1 | first start: the app pairs and finishes setup                     | PASS    | the app paired
| 13 | each boot lists the bundled web tools within 5 s and offers them | PASS    | daemon 1: clover/web/web listed 2 tool(s)
| 14 | the bot's WebSearch reaches the fake search backend; nothing leaves the machine | BLOCKED | a packaged core has no fake search backend (the keyed fetch's test seam is the source daemon's); the run never searches the real web
| 15 | cold start: the app opens first, the daemon after, and the shell fills the window | FAIL | 1 of 1: the shell didn't fill the window
14/15 passed
`;

describe("scripts/try", () => {
  test("the shell scripts parse", () => {
    for (const f of ["run.sh", "verify.sh", "watch.sh"]) {
      const r = spawnSync("bash", ["-n", join(DIR, f)], { encoding: "utf8" });
      expect([f, r.status, r.stderr]).toEqual([f, 0, ""]);
    }
  });

  test("no machine's own paths, no lane's scratch, nothing published, never `open`", () => {
    for (const f of ["run.sh", "verify.sh", "watch.sh"]) {
      const text = read(f);
      expect([f, /\/Users\/|\/home\/|scratchpad|lane-[a-z]-/.test(text)]).toEqual([f, false]);
      expect([f, /\bgh (release|api)\b|notarytool|stapler staple|--publish always|\bopen -a\b|^\s*open\s/m.test(text)]).toEqual([f, false]);
    }
  });

  test("run.sh: the sign-only build and the test twin, from a clean checkout at the named commit, the identity never printed", () => {
    const run = read("run.sh");
    expect(run).toContain("--sign --no-notarize");
    expect(run).toContain("--test-build");
    expect(run).toContain("check the try's commit out first");
    expect(run).toContain("git status --porcelain");
    // The identity is found by team, replaced in every kept line, and handed to the build only in its environment.
    expect(run).toContain("security find-identity -v -p codesigning");
    expect(run).toMatch(/redact \| stamp \| tee/);
    expect(run).not.toMatch(/echo[^\n]*\$ID\b/);
    expect(run).not.toMatch(/echo[^\n]*NODE_AUTH_TOKEN/);
    // Every copy is unregistered and the script reports that none stays registered.
    expect(run).toContain("lsregister");
    expect(run).toContain("none of the try's copies registered with Launch Services");
  });

  test("run.sh: the upgrade pair, from the previous try's commit, on the twins under the watchdog", () => {
    const run = read("run.sh");
    expect(run).toContain("--upgrade-from <previous try's commit>");
    expect(run).toContain('git worktree add --detach "$WORK/old" "$UPWANT"');
    expect(run).toContain('accept "upgrade-old" --keep-state "$UPSTATE"');
    expect(run).toContain('accept "upgrade-new" --upgrade-from "$UPSTATE"');
    // The state dir and the old worktree go with the rest.
    expect(run).toContain('rm -rf "$UPSTATE"');
    expect(run).toContain('git worktree remove --force "$WORK/old"');
    expect(run).toContain("the upgrade pair (");
  });

  test("watch.sh: runs the packaged acceptance on a copy, stops on a keychain prompt, and unregisters the copy", () => {
    const w = read("watch.sh");
    expect(w).toContain("scripts/acceptance/run.ts --app \"$COPY\"");
    expect(w).toContain("pgrep -x SecurityAgent");
    expect(w).toContain("security list-keychains -d user | shasum");
    expect(w).toContain('$LSR -u "$COPY"');
    expect(w).not.toContain("add-trusted-cert");
    // On a prompt it stops only what this run started (its pid and descendants), never every run on the Mac.
    expect(w).not.toMatch(/pgrep -f|pkill|killall/);
    expect(w).toContain('pgrep -P "$1"');
    expect(w).toContain("stop_run");
    expect(w).not.toMatch(/list-keychains[^\n]*-s\b/);
  });

  test("verify.sh: the sign-only mode wants the sign-only mark and no staple, and never an out/dist", () => {
    const v = read("verify.sh");
    expect(v).toContain("CLOVER-SIGN-ONLY-BUILD");
    expect(v).toContain("xcrun stapler validate");
    expect(v).toContain("*/out/dist");
    expect(v).toContain("hdiutil attach -nobrowse -readonly");
  });

  test("the table: a step per row, a run per column, a packaged-only block named as such, and the reasons once", () => {
    const rows = parseRunTable(RUN_OUT);
    expect(rows.map((r) => [r.n, r.status])).toEqual([[1, "PASS"], [13, "PASS"], [14, "BLOCKED"], [15, "FAIL"]]);
    expect(shownStatus(rows[2]!)).toBe("NOT RUN ON PACKAGED");
    expect(shownStatus({ n: 5, name: "x", status: "BLOCKED", detail: "the plugin isn't installed (step 4)" })).toBe("BLOCKED");
    const t = formatTable([{ label: "run1", rows }, { label: "run2", rows }, { label: "run3", rows: undefined }]);
    expect(t).toContain("| step");
    expect(t).toMatch(/\| 14 the bot's WebSearch[^\n]*\| NOT RUN ON PACKAGED \| NOT RUN ON PACKAGED \| NO OUTPUT/);
    expect(t).toContain("step 14 NOT RUN ON PACKAGED: a packaged core has no fake search backend");
    expect(t).toContain("(run1, run2)");
    expect(t).toContain("step 15 FAIL: 1 of 1: the shell didn't fill the window (run1, run2)");
    expect(t).toContain("run3: no run.out table");
  });
});
