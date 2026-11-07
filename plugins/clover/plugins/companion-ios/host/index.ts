// The iPhone companion's host half (clover/companion-ios). It fills its `companions` entry (lane B's
// CompanionHandler) with what the pairing screen shows for a phone. Everything else is the core's: the phone pairs
// as a device of its own (lane H's pairing, with the four words checked on both), dials this computer over its own
// link, and speaks the remote role's call list on a `clover/rpc/1` stream (lane H's remote-client door). Cards never
// pass through this plugin: the phone answers them with its own answer key, on the core's link (spec §10).

/** The app's URL scheme: the iPhone app opens `clover://pair` links and reads the pairing from them. */
export const APP_SCHEME = "clover";
const QR_PREFIX = "clover-pair:1:";

/** The link the phone opens for the core's pairing code, and what its QR carries. */
export function pairingLink(code: string): { url: string; qr: string } {
  const trimmed = code.trim();
  // A QR pairing (the host's key and addresses in it): the phone's scanner reads it as it is, and the link carries it
  // in the fragment, so it never reaches a server or a log.
  if (trimmed.startsWith(QR_PREFIX)) return { url: `${APP_SCHEME}://pair#${trimmed}`, qr: trimmed };
  // A short code: the phone finds the computer through the handshake's rendezvous.
  const url = `${APP_SCHEME}://pair?code=${encodeURIComponent(trimmed)}`;
  return { url, qr: url };
}

/** The `companions` entry's handler (lane B's CompanionHandler). */
export const companion = {
  /** A paired phone came online or went away; the core tracks it, and there is nothing for this plugin to do. */
  presence: async (_args: { device: string; role: "remote" | "web"; online: boolean }) => undefined,
  /** What the pairing screen shows for a phone, given the core's pairing code: a link the app opens, and its QR. */
  pairing: async (args: { code: string; expiresAt: number }) => pairingLink(args.code),
};
