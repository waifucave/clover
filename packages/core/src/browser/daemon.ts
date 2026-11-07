// The browser as the daemon puts it together (lane C's or E's composition calls this once at start):
//
//   const browser = startBrowser({ computer, home, app: () => pair.browserPort(), headless: !hasDisplay, emit, ... });
//   ipc.serve("browser.*", (caller, p) => browser.service.<method>(browserCallerOf(caller, toolCall), …));
//   settings.on("browser.proxy" / a bot's LAN setting, () => browser.configure({ proxy, lanBots }));
//   fence.deny(browser.filterPorts());  // lane C: the filter's listeners, denied to fenced commands
//   on quit: await browser.shutdown();
//
// On a desktop the tabs live in the app (`app` is the pair's `AppTabPort`); where no app runs at all (a server, a cloud
// computer), in Chrome for Testing's headless shell (`headless/`), whose traffic goes through this process's own
// network filter. A desktop whose app is closed has no browser until the pair starts the app again; it never falls back
// to the headless shell.
import { join } from "node:path";
import type { DeviceRegistry } from "../contracts/device-registry";
import type { BrowserNetworkConfig } from "./contract";
import { HeadlessBrowser, type HeadlessBrowserOptions } from "./headless";
import { bunRun } from "./headless/browser";
import { NetworkFilter } from "./network";
import { PeerOwner, processTree } from "./peer-owner";
import { serveBrowserPeers, type BrowserPeers } from "./peers";
import { BrowserService, type AppTabPort, type BrowserEvent, type PersonsBrowserGrants } from "./service";
import type { StreamChunk } from "./contract";

export interface StartBrowserOptions {
  computer: string;
  /** The Clover home; the headless shell keeps its install and profiles under `<home>/browser/`. */
  home: string;
  /** The app's port while the app is connected (desktops). */
  app?: () => AppTabPort | undefined;
  /** No app runs on this computer at all: tabs live in the headless shell. */
  headless: boolean;
  network?: BrowserNetworkConfig;
  /** The other computers and the link to them. `peers.level` is this computer's own approval level, which judges every
   *  call another computer's session makes here (lane INT passes the daemon's). */
  peers?: BrowserPeers;
  /** Lane H's device registry: a revoked device's streams end at once, whether or not its link has gone down yet. */
  devices?: Pick<DeviceRegistry, "watch">;
  grants?: PersonsBrowserGrants;
  emit?: (event: BrowserEvent) => void;
  /** The headless shell's stream chunks (by default the service's own stream sender takes them). */
  streamData?: (stream: string, chunk: StreamChunk) => void;
  log?: (line: string) => void;
  /** For tests: the headless browser's own options on top. */
  headlessOptions?: Partial<HeadlessBrowserOptions>;
}

export interface DaemonBrowser {
  service: BrowserService;
  headless: HeadlessBrowser | undefined;
  /** The headless shell's network filter's ports (none on a desktop: the app has its own), for lane C's fence. */
  filterPorts(): number[];
  configure(config: BrowserNetworkConfig): Promise<void>;
  shutdown(): Promise<void>;
}

export function startBrowser(o: StartBrowserOptions): DaemonBrowser {
  let headless: HeadlessBrowser | undefined;
  let filter: NetworkFilter | undefined;
  if (o.headless) {
    // Only the headless shells' own processes (and their children, where their network runs) may use the filter.
    const owner = new PeerOwner({
      platform: process.platform,
      run: bunRun,
      allowedPids: async () => (headless === undefined ? [] : processTree(headless.browserPids(), { platform: process.platform, run: bunRun })),
      ...(o.log !== undefined ? { log: o.log } : {}),
    });
    filter = new NetworkFilter({ acceptPeer: (peer, port) => owner.accepts(peer, port), ...(o.log !== undefined ? { log: o.log } : {}) });
  }
  let service: BrowserService;
  if (filter !== undefined) {
    headless = new HeadlessBrowser({
      dir: join(o.home, "browser"),
      computer: o.computer,
      network: filter,
      report: (events) => service.report(events),
      // The shell's JPEG frames go to the service's stream sender, as the app's chunks do.
      streamData: o.streamData ?? ((stream, chunk) => service.streamData(stream, chunk)),
      ...(o.log !== undefined ? { log: o.log } : {}),
      ...o.headlessOptions,
    });
  }
  const port = (): AppTabPort | undefined => (headless !== undefined ? headless : o.app?.());
  service = new BrowserService({
    computer: o.computer,
    app: port,
    ...(o.network !== undefined ? { network: o.network } : {}),
    ...(o.peers !== undefined ? { peers: o.peers } : {}),
    ...(o.grants !== undefined ? { grants: o.grants } : {}),
    ...(o.devices !== undefined ? { devices: o.devices } : {}),
    ...(o.emit !== undefined ? { emit: o.emit } : {}),
  });
  const unserve = o.peers !== undefined ? serveBrowserPeers({ service, peers: o.peers }) : () => undefined;
  if (headless !== undefined) void headless.configure(service.networkConfig).catch((e) => o.log?.(`browser: the network settings didn't apply: ${String(e)}`));
  return {
    service,
    headless,
    filterPorts: () => filter?.listenerPorts() ?? [],
    configure: (config) => service.configure(config),
    shutdown: async () => {
      unserve();
      service.dispose();
      await headless?.shutdown();
      await filter?.close();
    },
  };
}
