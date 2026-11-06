// Opt-in (`CLOVER_K_LIVE=1`): the real client against the real agents installed on this computer, Cursor's CLI and
// Antigravity CLI. For each: `detect` (its real path, version and, for Antigravity, its signer), then `initialize` and
// `session/new` with the real bridge, until the bridge has said hello from inside the agent's own process tree; then
// stop. It sends no prompt, so no model is called. Like spike S5, it leaves a session in each agent's own store; it
// changes no setting (no model is chosen) and never signs in.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { AcpAgentBackend } from "../backend";
import { bridgeCloverParts } from "../bridge/handlers";
import { serveClover } from "../testing/clover-endpoint";
import { bridgeCommand } from "../bridge/main";
import { BRIDGE_ENV } from "../bridge/server";
import { BridgeTokens } from "../bridge/tokens";
import { BRIDGE_OWN_TOOLS } from "../bridge/tools";
import { bundledBackends } from "../testing/bundled-backends";

// The bundled backends' rows, as their plugins hold them.
const ROWS = bundledBackends();
const QUIRKS = Object.fromEntries(Object.entries(ROWS).map(([id, r]) => [id, r.quirks]));
import { waitFor } from "./world";

setDefaultTimeout(120_000);
const live = process.env["CLOVER_K_LIVE"] === "1" && process.platform === "darwin";
const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-live-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!live)("the real agents (opt-in)", () => {
  for (const id of Object.keys(QUIRKS)) {
    test(`${id}: detected, started with the bridge, the bridge's hello accepted from its tree, stopped`, async () => {
      const clock = new FakeClock();
      const tokens = new BridgeTokens();
      let toolsAsked = 0;
      const sock = join("/tmp", `ck-live-${process.pid}-${id}.sock`);
      const endpoint = serveClover(sock, bridgeCloverParts(tokens, {
          sessionInfo: () => ({}),
          tools: async () => {
            toolsAsked++;
            return { tools: [...BRIDGE_OWN_TOOLS], instructions: "Clover's bridge (a protocol check; no task)." };
          },
          call: async () => ({ content: [], isError: true }),
          sendMessage: async () => {},
          glossary: async () => ({ results: [], loaded: [] }),
      }));
      const backend = new AcpAgentBackend({ id, pluginId: `clover/agent-${id}`, quirks: QUIRKS[id]!, clock, wire: () => ({ launched: (pid) => tokens.bind("live", pid) }) });
      const d = await backend.detect();
      console.log(`${id}: ${JSON.stringify({ path: d.path, version: d.version, identityOk: d.identityOk, versionOk: d.versionOk })}`);
      if (!d.installed) return;
      expect(d.identityOk).toBe(true);
      const work = join(root, id);
      mkdirSync(work, { recursive: true });
      const token = tokens.mint("live");
      const fence = new FakeFence({ home: root, cloverHome: join(root, ".clover") }).policy();
      const s = await backend.start({
        sessionId: "live", root: work, fence,
        bridge: { name: "clover", ...bridgeCommand(), env: { [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "live", [BRIDGE_ENV.socket]: sock }, tools: BRIDGE_OWN_TOOLS.map((t) => t.name) },
      });
      try {
        expect(s.agentSessionId.length).toBeGreaterThan(0);
        expect(s.state()).toBe("ready");
        await waitFor(() => toolsAsked > 0, "the bridge's hello and its tools/list or initialize", 60_000);
        console.log(`${id}: session ready; the bridge connected from the agent's tree; config ${JSON.stringify(s.configOptions().map((c) => c.id))}`);
      } finally {
        await s.stop();
        tokens.revokeAll();
        endpoint.close();
      }
    });
  }
});
