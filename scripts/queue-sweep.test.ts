// The merge queue's sweep (.github/workflows/queue-sweep.yml): its trigger and its one permission, and its step run
// for real under bash against stand-ins for gh and git, so nothing reaches GitHub.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "queue-sweep.yml"), "utf8");
// biome-ignore lint: a parsed workflow
const wf = Bun.YAML.parse(text) as Record<string, any>;
const step = wf.jobs.sweep.steps[0] as { run: string; env: Record<string, string> };

const OWN = "gh-readonly-queue/main/pr-230-aaaa";

/** Runs the step with these runs (`id branch`, per status) and these live branches; what it cancelled, and its log. */
function sweep(opts: { runs: Record<string, string[]>; refs: string[] | null; failList?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "clover-queue-sweep-"));
  const log = join(dir, "cancelled");
  writeFileSync(join(dir, "runs.json"), JSON.stringify(opts.runs));
  writeFileSync(join(dir, "gh"), `#!/bin/bash
if [ "$1 $2" = "api -X" ]; then echo "$4" >> "${log}"; exit 0; fi
${opts.failList ? "exit 1" : ""}
status=$(echo "$2" | sed -n 's/.*status=\\([a-z_]*\\).*/\\1/p')
bun -e "for (const r of (JSON.parse(require('fs').readFileSync('${join(dir, "runs.json")}','utf8'))[process.argv[1]] ?? [])) console.log(r)" "$status"
`);
  writeFileSync(join(dir, "git"), opts.refs === null ? "#!/bin/bash\nexit 128\n" : `#!/bin/bash\n${opts.refs.map((r) => `echo "0123abcd\trefs/heads/${r}"`).join("\n")}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  chmodSync(join(dir, "git"), 0o755);
  const r = spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, REPO: "waifucave/clover", RUN_ID: "999", OWN_BRANCH: OWN, GH_TOKEN: "x" },
  });
  const cancelled = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => /runs\/(\d+)\/cancel/.exec(l)?.[1]) : [];
  return { status: r.status, out: r.stdout + r.stderr, cancelled };
}

describe("the merge queue's sweep", () => {
  test("runs on merge_group only, with actions: write and nothing else", () => {
    expect(Object.keys(wf.on)).toEqual(["merge_group"]);
    expect(wf.permissions).toEqual({ actions: "write" });
    expect(wf.jobs.sweep.permissions).toBeUndefined();
    expect(wf.jobs.sweep.steps).toHaveLength(1);
    expect(text).not.toMatch(/uses:|secrets\./);
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}", RUN_ID: "${{ github.run_id }}", OWN_BRANCH: "${{ github.ref_name }}" });
  });

  test("cancels a queued or running run whose queue ref is gone, and only those", () => {
    const r = sweep({
      runs: {
        in_progress: [`101 ${OWN}`, "102 gh-readonly-queue/main/pr-200-bbbb", "103 gh-readonly-queue/main/pr-201-cccc"],
        queued: ["104 gh-readonly-queue/main/pr-202-dddd", "105 main", "106 lane/m-x"],
      },
      refs: ["main", "lane/m-x", OWN, "gh-readonly-queue/main/pr-201-cccc"],
    });
    expect(r.status).toBe(0);
    expect(r.cancelled.sort()).toEqual(["102", "104"]);
    expect(r.out).toContain("2 stale run(s) cancelled");
  });

  test("never its own run, even listed with a gone ref", () => {
    const r = sweep({ runs: { in_progress: ["999 gh-readonly-queue/main/pr-1-gone"] }, refs: [OWN] });
    expect(r.cancelled).toEqual([]);
  });

  test("cancels nothing when the refs can't be read, or don't hold this event's own ref", () => {
    const runs = { in_progress: ["102 gh-readonly-queue/main/pr-200-bbbb"] };
    expect(sweep({ runs, refs: null }).cancelled).toEqual([]);
    const without = sweep({ runs, refs: ["main"] });
    expect(without.cancelled).toEqual([]);
    expect(without.out).toContain("cancelling nothing");
  });

  test("cancels nothing, and fails, when the runs can't be listed", () => {
    const r = sweep({ runs: {}, refs: [OWN], failList: true });
    expect(r.cancelled).toEqual([]);
    expect(r.status).not.toBe(0);
  });
});
