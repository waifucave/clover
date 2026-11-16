// J's macOS audit: a temp-home daemon read the REAL `~/.claude` (the usage readers fell back to the user's home folder).
// Whose apps usage tracking may call is the daemon's `userHome` (`usage/wiring.ts`): the user's home folder only for the
// daemon on its default home, none for any other. A source is a plugin's, run through `api.outside` with the user's own
// access, so a temp-home or test daemon calls NO entry unless a test names it (`injection.sources`, `injection.port`, or
// `$MOSS_USAGE_SOURCES`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { UsagePricer } from "../../src/usage/pricing";
import { createUsageService, type UsageInjection } from "../../src/usage/wiring";
import { fakeClaude, fakeCodex, tempDir } from "./fixtures";
import { sourcePort } from "./sources-harness";
import { UsageDb } from "../../src/usage/db";

const temps: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `moss-usage-home-${name}-`));
  temps.push(d);
  return d;
};
const saved = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined) => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
let daemon: RunningDaemon | undefined;
// The preload says `off`; these tests are about what the daemon does when nothing says so.
beforeEach(() => setEnv("MOSS_USAGE_SOURCES", undefined));
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A usage service whose plugin host is a port over the real source handlers and fake programs; `calls` says what ran. */
function wired(userHome: string | undefined, injection: UsageInjection = {}) {
  const codex = fakeCodex(tempDir("bin"), "ok", { primary: 10, secondary: 20, resetsAtSec: Math.floor((Date.now() + 3_600_000) / 1000) });
  const claude = fakeClaude(tempDir("bin"), "ok");
  const db = new UsageDb(join(temp("db"), "usage.db"));
  const port = sourcePort({ db, pricer: new UsagePricer(), tracking: () => ({}), codexExecutable: () => codex.path, claudeExecutable: () => claude.path });
  const usage = createUsageService({ home: temp("moss"), userHome, settings: () => undefined, injection: { catchUp: false, background: false, ...injection } })!;
  usage.attach({ port });
  return { usage, port, db };
}

describe("usage tracking calls only the sources its daemon's user home allows", () => {
  test("no user home: no entry is called, whatever the plugin host has", async () => {
    const { usage, port } = wired(undefined);
    try {
      expect(usage.sources.entries()).toEqual([]);
      expect((await usage.service.sourcePlan("codex")).source).toBe("not-installed");
      await usage.service.ingest(true);
      expect(port.calls).toEqual([]);
    } finally { usage.close(); }
  });

  test("with a user home every entry may be called (the test above means something)", async () => {
    const { usage, port } = wired(temp("user"));
    try {
      expect(usage.sources.entries().map((e) => e.id)).toEqual(["codex", "claude-code", "antigravity", "opencode"]);
      expect((await usage.service.sourcePlan("codex")).source).toBe("codex-app-server");
      expect(port.calls.some((c) => c.id === "codex" && c.method === "plan")).toBe(true);
    } finally { usage.close(); }
  });

  test("a named source is called without a user home; the others are not", async () => {
    const { usage, port } = wired(undefined, { sources: ["claude-code"] });
    try {
      expect(usage.sources.entries().map((e) => e.id)).toEqual(["claude-code"]);
      expect((await usage.service.sourcePlan("codex")).source).toBe("not-installed");
      expect((await usage.service.sourcePlan("claude-code")).source).toBe("claude-cli");
      expect(port.calls.map((c) => c.id)).not.toContain("codex");
    } finally { usage.close(); }
  });

  test("`sources: null` (the inert daemons) and `MOSS_USAGE_SOURCES=off` call nothing, even with a user home", async () => {
    const inert = wired(temp("user"), { sources: null });
    try {
      expect(inert.usage.sources.entries()).toEqual([]);
      await inert.usage.service.ingest(true);
      expect(inert.port.calls).toEqual([]);
    } finally { inert.usage.close(); }
    setEnv("MOSS_USAGE_SOURCES", "off");
    const off = wired(temp("user"));
    try {
      expect(off.usage.sources.entries()).toEqual([]);
    } finally { off.usage.close(); }
  });

  test("`MOSS_USAGE_SOURCES` names the sources (a comma list) for a daemon spawned as a process", async () => {
    setEnv("MOSS_USAGE_SOURCES", "codex, opencode");
    const { usage } = wired(undefined);
    try {
      expect(usage.sources.entries().map((e) => e.id)).toEqual(["codex", "opencode"]);
    } finally { usage.close(); }
  });

  test("a daemon on a temp home calls nothing outside it", async () => {
    setEnv("MOSS_USAGE_SOURCES", undefined);
    const home = temp("daemon");
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false, links: false,
      parts: { bots: false, node: false },
    });
    expect(daemon.usageSources).toBeDefined();
    expect(daemon.usageSources!.entries()).toEqual([]);
  });
});
