// Daemons in a test (plan §3): each a real `clover-core` daemon, in this test process, on its own temp home with
// a file secret store in that home — so it reads nothing of the machine's — and a fake app client to drive it.
// Several of them make a cluster; a cluster's daemons are joined by a `HarnessLink`.
//
// THE LINK SEAM: devices talk over one persistent link per pair (spec §8.2), behind lane B's `LinkTransport`
// contract (packages/core/src/contracts/), whose in-memory fake joins daemons in one process. Until B-M0 lands
// that fake, and lane H gives the daemon a link to take, a cluster's daemons run side by side, unlinked
// (`UNLINKED`); `linkTransportFake()` names the gap. A test that needs linked daemons passes `link`, and the
// fake's adapter will implement `HarnessLink` — nothing else in the harness changes.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { FileSecretStore, startDaemon, type RunningDaemon, type SecretStore } from "@waifucave/clover-core";
import { FakeAppClient, type FakeAppClientOptions } from "./app-client";
import { makeTempHome, type TempHome } from "./homes";

/** Settings for a daemon that reaches nothing outside the test: no model provider it could call, titles off. */
export function testDaemonSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    // The SDK's test double, by name, behind a closed loopback port: nothing reaches the network.
    provider: { type: "openai-compatible", model: "winter-test/echo", baseUrl: "http://127.0.0.1:9/v1" },
    titles: { enabled: false },
    ...overrides,
  };
}

export interface HarnessDaemon {
  name: string;
  home: TempHome;
  daemon: RunningDaemon;
  socketPath: string;
  /** The local-client token a fake app client says hello with. */
  token: string;
  /** A fake app client on this daemon, closed with it. */
  connectApp(opts?: Omit<FakeAppClientOptions, "socketPath" | "token">): Promise<FakeAppClient>;
  /** Closes its clients, stops the daemon, removes its home. */
  stop(): Promise<void>;
}

export interface TestDaemonOptions {
  name?: string;
  /** settings.json, written before boot (default: `testDaemonSettings()`). */
  settings?: Record<string, unknown>;
  /** The daemon's secret store (default: a `FileSecretStore` in its home). */
  secrets?: SecretStore;
  /** Anything else `startDaemon` takes. `home` and `secrets` are the harness's. */
  start?: Omit<NonNullable<Parameters<typeof startDaemon>[0]>, "home" | "secrets">;
}

/** One daemon on a fresh temp home. Injecting `secrets` keeps every legacy import and the real Keychain out. */
export async function startTestDaemon(opts: TestDaemonOptions = {}): Promise<HarnessDaemon> {
  const name = opts.name ?? "daemon";
  const home = makeTempHome({ name });
  writeFileSync(join(home.home, "settings.json"), JSON.stringify(opts.settings ?? testDaemonSettings()));
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({
      agentProvider: null,
      ...opts.start,
      home: home.home,
      secrets: opts.secrets ?? new FileSecretStore(join(home.home, "test-secrets")),
    });
  } catch (err) {
    home.cleanup();
    throw err;
  }
  const clients: FakeAppClient[] = [];
  let stopped = false;
  return {
    name,
    home,
    daemon,
    socketPath: daemon.socketPath,
    token: daemon.tokens.harness,
    connectApp: async (clientOpts = {}) => {
      const client = await FakeAppClient.connect({ ...clientOpts, socketPath: daemon.socketPath, token: daemon.tokens.harness });
      clients.push(client);
      return client;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const c of clients) c.close();
      await daemon.stop();
      home.cleanup();
    },
  };
}

/** What joins a cluster's daemons. Lane B's `LinkTransport` fake will provide one (see the header). */
export interface HarnessLink {
  readonly name: string;
  /** Joins the daemons, every pair or as the link decides. */
  join(daemons: readonly HarnessDaemon[]): Promise<void> | void;
  close(): Promise<void> | void;
}

/** No link: the daemons run side by side and never see each other. The default until the fake link lands. */
export const UNLINKED: HarnessLink = { name: "unlinked", join: () => {}, close: () => {} };

/** The fake link from lane B's contracts, once B-M0 lands it; until then a clear refusal, never a silent stand-in. */
export function linkTransportFake(): HarnessLink {
  throw new Error("the fake link is lane B's LinkTransport fake (packages/core/src/contracts/), which lands with B-M0; until then run the daemons UNLINKED or pass a HarnessLink of your own");
}

export interface DaemonCluster {
  daemons: readonly HarnessDaemon[];
  link: HarnessLink;
  /** The daemon called `name`. */
  get(name: string): HarnessDaemon;
  /** Closes the link, then stops every daemon. */
  stop(): Promise<void>;
}

/** Several daemons in this test, each on its own home, joined by `link` (default `UNLINKED`). */
export async function startDaemons(names: readonly string[] | number, opts: { link?: HarnessLink; daemon?: Omit<TestDaemonOptions, "name"> } = {}): Promise<DaemonCluster> {
  const list = typeof names === "number" ? Array.from({ length: names }, (_, i) => `device-${i + 1}`) : [...names];
  if (new Set(list).size !== list.length) throw new Error(`daemon names must be unique: ${list.join(", ")}`);
  const daemons: HarnessDaemon[] = [];
  const link = opts.link ?? UNLINKED;
  try {
    for (const name of list) daemons.push(await startTestDaemon({ ...opts.daemon, name }));
    await link.join(daemons);
  } catch (err) {
    for (const d of daemons.reverse()) await d.stop().catch(() => {});
    throw err;
  }
  return {
    daemons,
    link,
    get: (name) => {
      const d = daemons.find((x) => x.name === name);
      if (d === undefined) throw new Error(`no daemon called ${name} (have ${list.join(", ")})`);
      return d;
    },
    stop: async () => {
      await link.close();
      for (const d of [...daemons].reverse()) await d.stop();
    },
  };
}
