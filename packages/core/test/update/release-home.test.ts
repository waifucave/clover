// RL: the ReleaseHome conformance suite (contracts/conformance/release-home.ts) against the REAL implementation
// (src/update/release-home.ts): records as files under a temp home, the install under the real OS lock, the placement of a
// real (fake) engine binary. The suite's `bundles` and `slowInstallMs` drivers are bridged to the real seams.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppInstallRecord } from "@waifucave/moss-protocol";
import { runReleaseHomeConformance, type ReleaseHomeFactory } from "../../src/contracts/conformance/release-home";
import type { EngineCopy, ReleaseHome } from "../../src/contracts/release-home";
import type { Clock } from "../../src/contracts/clock";
import { engineBinaryPath, placeEngine } from "../../src/update/engine-copy";
import { EngineReleaseHome } from "../../src/update/release-home";

const root = mkdtempSync(join(tmpdir(), "moss-rl-conf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

class Harness implements ReleaseHome {
  readonly bundles = new Set<string>();
  slowInstallMs = 0;
  readonly engine: string;
  readonly #real: EngineReleaseHome;
  constructor(opts: { clock: Clock; engine: string; installed?: EngineCopy }) {
    const home = join(root, `h${n++}`);
    mkdirSync(join(home, "bin"), { recursive: true });
    const source = join(home, "source-core");
    writeFileSync(source, "#!/bin/sh\n");
    if (opts.installed) writeFileSync(join(home, "bin", "engine.json"), JSON.stringify(opts.installed));
    this.engine = opts.engine;
    this.#real = new EngineReleaseHome({
      home, engine: opts.engine, clock: opts.clock,
      exists: (p) => this.bundles.has(p),
      place: (copy) => placeEngine(home, { binary: source }, copy),
      hold: () => this.slowInstallMs > 0 ? new Promise<void>((r) => opts.clock.setTimeout(r, this.slowInstallMs)) : Promise.resolve(),
    });
  }
  judge(c: string | undefined) { return this.#real.judge(c); }
  doorAllows(m: string) { return this.#real.doorAllows(m); }
  record(a: Omit<AppInstallRecord, "record" | "seenAt">) { return this.#real.record(a); }
  apps() { return this.#real.apps(); }
  hostSource() { return this.#real.hostSource(); }
  install(c: EngineCopy) { return this.#real.install(c); }
  installed() { return this.#real.installed(); }
}

runReleaseHomeConformance(((o: ConstructorParameters<typeof Harness>[0]) => new Harness(o)) as unknown as ReleaseHomeFactory);

describe("the real install places the engine where the login item will start it", () => {
  test("a newer copy lands at bin/daemon/moss-core, the old one is kept aside", async () => {
    const { FakeClock } = await import("../../src/contracts/fakes/clock");
    const home = join(root, "placed");
    const src = join(root, "src-core");
    writeFileSync(src, "v1");
    const clock = new FakeClock();
    const h = new EngineReleaseHome({ home, engine: "1.0.0", clock, place: (c) => placeEngine(home, { binary: src }, c) });
    expect((await h.install({ release: "1.0.0", build: "1", from: "/a" })).installed).toBe(true);
    expect(readFileSync(engineBinaryPath(home), "utf8")).toBe("v1");
    writeFileSync(src, "v2");
    expect((await h.install({ release: "1.0.1", build: "1", from: "/b" })).installed).toBe(true);
    expect(readFileSync(engineBinaryPath(home), "utf8")).toBe("v2");
    expect(readFileSync(`${engineBinaryPath(home)}.old`, "utf8")).toBe("v1");
    // The same copy again installs nothing.
    expect((await h.install({ release: "1.0.1", build: "1", from: "/b" })).installed).toBe(false);
    expect(h.installed()).toEqual({ release: "1.0.1", build: "1", from: "/b" });
  });
});
