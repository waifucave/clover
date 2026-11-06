// The web companion plugin's host half (clover/companion-web). It runs on the main computer (the `companions`
// point's default) and fills its `companions` entry: the pairing link a browser opens, and presence. The browsers'
// links come up through the waifucave handshake (src/web-host.ts) and go to the core, which serves them the `web`
// call list; a companion can't widen that list, and cards never pass through it (lane B's CompanionHandler).

import { HandshakeClient } from "@waifucave/clover-service-handshake/client";
import { DEFAULT_ICE_SERVERS } from "@waifucave/clover-service-web/protocol";
import { RTCPeerConnection } from "node-datachannel/polyfill";

import type { RtcEnvironment } from "@waifucave/clover-service-web/protocol";
import { WebLinkHost } from "../src/web-host";
import type { HostApi } from "./api";

export const DEFAULT_HANDSHAKE = "https://handshake.waifucave.com";
export const DEFAULT_WEB = "https://clover.waifucave.com";

/** node-datachannel's RTCPeerConnection, which spike S1 showed answering Chrome, Firefox and Safari under Bun. */
export const nodeRtc: RtcEnvironment = {
  createPeerConnection: (config) => new RTCPeerConnection(config) as unknown as ReturnType<RtcEnvironment["createPeerConnection"]>,
  iceServers: DEFAULT_ICE_SERVERS,
};

let host: WebLinkHost | null = null;

export async function start(api: HostApi): Promise<void> {
  if (host) return;
  const handshake = (await api.settings.get<string>("handshakeOrigin")) || DEFAULT_HANDSHAKE;
  const web = (await api.settings.get<string>("webOrigin")) || DEFAULT_WEB;
  host = new WebLinkHost({
    client: new HandshakeClient({ origin: handshake }),
    webOrigin: web,
    ...(handshake !== DEFAULT_HANDSHAKE ? { inviteHandshake: handshake } : {}),
    computerName: api.plugin.computer,
    rtc: nodeRtc,
    store: api.pairs,
    registry: api.registry,
    // Lane B's sealed card from this plugin: the person compares the words the browser shows with these.
    confirm: async ({ browser, words }) => ({
      confirmed: await api.confirm(`${browser} wants to pair with this computer. Does it show these four words: ${words.join(" ")}? Confirm only if they match.`),
      card: `companion-web:${words.join("-")}`,
    }),
    adopt: api.adoptLink,
    // A host half's console goes to its plugin's log (lane B: there is no log call).
    log: (level, message) => console[level](message),
  });
  await host.start();
}

export function stop(): void {
  host?.stop();
  host = null;
}

function live(): WebLinkHost {
  if (!host) throw new Error("the web companion is not running on this computer");
  return host;
}

/** The `companions` entry's handler (lane B's CompanionHandler). */
export const companion = {
  /** A paired browser came online or went away; the core tracks it, and there is nothing for this plugin to do. */
  presence: async (_args: { device: string; role: "remote" | "web"; online: boolean }) => undefined,
  /** The link the pairing screen shows for a browser, given the core's pairing code: as text and as a QR payload. */
  pairing: async (args: { code: string; expiresAt: number }) => {
    const url = await live().createInvite(args);
    return { url, qr: url };
  },
};
