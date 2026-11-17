// `moss-core engine install` (src/update/engine-install-command.ts) against a temp home and a stand-in engine (a script that
// says which release it is): it places the running engine and its tree, only when newer, and says which binary to start.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngineInstall } from "../../src/update/engine-install-command";
import { engineBinaryPath } from "../../src/update/engine-copy";

const root = mkdtempSync(join(tmpdir(), "moss-rl-eic-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
let running = false;

function app(release: string): { exec: string; bundle: string } {
  const bundle = join(root, `app${n++}`);
  const resources = join(bundle, "resources");
  mkdirSync(join(resources, "daemon"), { recursive: true });
  mkdirSync(join(resources, "plugins", "p"), { recursive: true });
  const exec = join(resources, "daemon", "moss-core");
  writeFileSync(exec, `#!/bin/sh\necho "moss ${release}"\n`);
  chmodSync(exec, 0o755);
  writeFileSync(join(resources, "plugins", "p", "f"), release);
  return { exec, bundle };
}
async function run(home: string, a: { exec: string; bundle: string }, release: string, extra: string[] = []) {
  const out: string[] = [], err: string[] = [];
  const code = await runEngineInstall(["--app", a.bundle, ...extra], { home, execPath: a.exec, release, platform: "linux", engineRunning: async () => running, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.map((l) => JSON.parse(l)), err };
}

describe("engine install", () => {
  test("places the running engine and its tree, and names the binary to start", async () => {
    const home = join(root, "h1");
    const a = app("1.0.0");
    const r = await run(home, a, "1.0.0", ["--build", "7"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toEqual({ installed: true, binary: engineBinaryPath(home), release: "1.0.0", build: "7" });
    expect(readFileSync(join(home, "bin", "plugins", "p", "f"), "utf8")).toBe("1.0.0");
  });

  test("a second app on the same release and build doesn't replace it; a newer one does; an older one only connects", async () => {
    const home = join(root, "h2");
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "7"])).out[0].installed).toBe(true);
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "7"])).out[0]).toMatchObject({ installed: false, release: "1.0.0", build: "7" });
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "12"])).out[0]).toMatchObject({ installed: true, build: "12" });
    expect((await run(home, app("1.1.0"), "1.1.0")).out[0]).toMatchObject({ installed: true, release: "1.1.0" });
    expect((await run(home, app("1.0.0"), "1.0.0", ["--build", "99"])).out[0]).toMatchObject({ installed: false, release: "1.1.0" });
    expect(readFileSync(engineBinaryPath(home), "utf8")).toContain("moss 1.1.0");
  });

  test("an engine that is already running is never swapped under: nothing is placed, and it says it was deferred", async () => {
    const home = join(root, "h5");
    await run(home, app("1.0.0"), "1.0.0");
    running = true;
    try {
      const r = await run(home, app("2.0.0"), "2.0.0");
      expect(r.out[0]).toMatchObject({ installed: false, deferred: true, release: "1.0.0" });
      expect(readFileSync(engineBinaryPath(home), "utf8")).toContain("moss 1.0.0");
      expect(readFileSync(join(home, "bin", "plugins", "p", "f"), "utf8")).toBe("1.0.0");
    } finally { running = false; }
  });

  test("an engine that doesn't say it is its release is never placed", async () => {
    const home = join(root, "h3");
    const a = app("1.0.0");
    const r = await run(home, a, "2.0.0");
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("not release 2.0.0");
    expect(existsSync(engineBinaryPath(home))).toBe(false);
  });

  test("running from the home's own copy installs nothing; bad arguments are refused", async () => {
    const home = join(root, "h4");
    await run(home, app("1.0.0"), "1.0.0");
    const own = { exec: engineBinaryPath(home), bundle: join(root, "x") };
    expect((await run(home, own, "1.0.0")).out[0]).toMatchObject({ installed: false });
    const out: string[] = [], err: string[] = [];
    expect(await runEngineInstall(["--app", "relative"], { home, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(2);
    expect(await runEngineInstall([], { home, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(2);
  });
});
