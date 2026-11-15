// The load-time client build's child process (`client-builds.ts` starts it, `client-build-run.ts` does the work): it
// reads one job as JSON on stdin and writes one result as one JSON line on stdout. A compiled core carries it prebuilt
// (`clover-plugin-builder.bundle`, `compile:core`); from source it is bundled into the run folder first.
import { runClientBuild, type ClientBuildJob, type ClientBuildResult } from "./client-build-run";

const answer = (r: ClientBuildResult) => process.stdout.write(`${JSON.stringify(r)}\n`);

try {
  const job = JSON.parse(await Bun.stdin.text()) as ClientBuildJob;
  answer(await runClientBuild(job));
} catch (e) {
  answer({ ok: false, message: `the build stopped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 2000) });
}
process.exit(0);
