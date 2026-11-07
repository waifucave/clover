// M-M2 on a real daemon (temp home, file secret store, no app): `update.status` answers over a Clover connection
// with the idle gate's verdict, and a lane's busy source registered on `updateGate` shows in it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_VERSION, startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { cloverCall } from "../../src/ipc/clover-client";

describe("update.status on a running daemon", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  test("idle with nothing running; a lane's registered work makes it busy; apply then waits", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-update-boot-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false });
    const call = (method: string) => cloverCall(daemon!.socketPath, { role: "cli", token: daemon!.tokens.harness, clientName: "update-test" }, method, {});
    expect(daemon.updateGate.names()).toEqual(["turns", "agents", "approvals", "questions", "elicitations", "workflows"]);
    expect(await call("update.status")).toEqual({ current: CORE_VERSION, channel: "latest", ready: false, idle: true, busy: [] });
    expect(await call("update.apply")).toEqual({ at: "now" });
    // Closed for the restart: no new turn starts until it reopens (here, by hand; in life, the restart or its timer).
    expect(daemon.updateGate.closed).toBe(true);
    daemon.updateGate.reopen();
    const off = daemon.updateGate.register({ name: "routines", count: () => 1 });
    expect(await call("update.status")).toMatchObject({ idle: false, busy: ["routines:1"] });
    expect(await call("update.apply")).toEqual({ at: "when-idle" });
    expect(daemon.updateGate.closed).toBe(false);
    off();
  });
});
