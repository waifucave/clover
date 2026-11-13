// `host.start` (§5.2) over a real plugin registry and a real plugin-host process: a host half that says where it starts
// runs there as soon as it has its OK, with no call; one without waits for its first use; `main` waits for the main
// computer to be known, starts when this computer is the main, and is let go when it stops being it. Temp homes, the
// fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost, type MainHere } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function plugin(home: string, id: string, start?: string): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(start !== undefined ? { start } : {}) },
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  // Its module's own code runs when its host half starts: the line in its log says it did.
  writeFileSync(join(folder, "host", "index.js"), `console.log("${id} is up");\nexport const ping = async () => "pong";\n`);
}

async function until(f: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time");
    await Bun.sleep(20);
  }
}

async function world(ids: Record<string, string | undefined>) {
  const home = mkdtempSync(join(tmpdir(), "clover-b-host-start-"));
  temps.push(home);
  for (const [id, start] of Object.entries(ids)) plugin(home, id, start);
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
  const approve = async (id: string) => {
    const { card } = await opened.registry.installed(id, "app");
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    await until(() => opened.registry.get(id)?.state === "running");
  };
  const logOf = (id: string) => { try { return readFileSync(join(home, "logs", "plugins", `${id}.log`), "utf8"); } catch { return ""; } };
  return { home, opened, approve, logOf, secrets };
}

/** A main computer the test moves. */
function movableMain(here: boolean): MainHere & { move(here: boolean): void } {
  const fns = new Set<() => void>();
  let now = here;
  return {
    runsHere: () => now,
    watch: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    move(h) { now = h; for (const fn of fns) fn(); },
  };
}

describe("host.start", () => {
  test("each and chosen start at once once they have their OK, with no call; a plugin without it waits for its first use", async () => {
    const w = await world({ "svc-each": "each", "svc-chosen": "chosen", lazy: undefined });
    const ph = await startPluginHost({ home: w.home, computer: "Studio", registry: w.opened.registry, secrets: w.secrets });
    try {
      for (const id of ["svc-each", "svc-chosen", "lazy"]) await w.approve(id);
      await until(() => ph.host.status("svc-each").state === "running" && ph.host.status("svc-chosen").state === "running");
      await until(() => w.logOf("svc-each").includes("svc-each is up"));
      expect(ph.host.status("lazy").state).toBe("idle");
      expect(w.logOf("lazy")).not.toContain("lazy is up");
      // A user's stop holds: a later look at what starts here doesn't start it again.
      await ph.host.stop("svc-each", "stopped by the user");
      ph.setMain(undefined);
      await Bun.sleep(200);
      expect(ph.host.status("svc-each").state).toBe("stopped");
    } finally {
      await ph.close();
      w.opened.close();
    }
  }, 60_000);

  test("a plugin already approved starts with the host; main waits for the main computer, starts there and is let go when it moves", async () => {
    const w = await world({ "svc-main": "main", "svc-each": "each" });
    // Approved under a first host, which is closed: the second finds them approved at its start.
    const first = await startPluginHost({ home: w.home, computer: "Studio", registry: w.opened.registry, secrets: w.secrets, main: "later" });
    for (const id of ["svc-main", "svc-each"]) await w.approve(id);
    await first.close();
    const ph = await startPluginHost({ home: w.home, computer: "Studio", registry: w.opened.registry, secrets: w.secrets, main: "later" });
    try {
      await until(() => ph.host.status("svc-each").state === "running");
      // The main isn't known yet: it waits.
      expect(ph.host.status("svc-main").state).toBe("idle");
      const main = movableMain(false);
      ph.setMain(main);
      await Bun.sleep(200);
      expect(ph.host.status("svc-main").state).toBe("idle");
      main.move(true);
      await until(() => ph.host.status("svc-main").state === "running");
      main.move(false);
      await until(() => ph.host.status("svc-main").state === "idle");
      // Still usable here on demand (its first use starts it), as any host half is.
      expect(await ph.host.invoke({ pluginId: "svc-main", handler: "ping", args: null, caller: { kind: "user", client: "app" } })).toBe("pong");
      // No lease at all: this computer is its own main.
      await ph.host.stop("svc-main", "x");
      await ph.host.restart("svc-main");
      main.move(false);
      await until(() => ph.host.status("svc-main").state === "idle");
      ph.setMain(undefined);
      await until(() => ph.host.status("svc-main").state === "running");
    } finally {
      await ph.close();
      w.opened.close();
    }
  }, 60_000);
});
