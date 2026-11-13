// A test build's names for the acceptance run's own fixture site (called only from a branch gated on a test or acceptance
// build, so a release build has none of it). `CLOVER_TEST_BROWSER_NAMES` is `name=port;name=port`: each name resolves to
// one address of the PUBLIC kind (so every rule of the network filter judges it as it would any web address: a bot's tab
// is held to public addresses, and a name that resolved to loopback itself would be refused), and a connection to that
// address is dialled to the fixture server on this computer's loopback at the port named. Every other name resolves and
// connects as it always does; nothing about the filter's policy changes.
import { connect as netConnect, type Socket } from "node:net";

/** Public-kind addresses nothing real is reached at here (TEST-NET-like but not in the filter's reserved ranges). */
const FAKE_BASE = [93, 184, 216] as const;

export interface TestNames {
  lookup(host: string): Promise<string[]>;
  dial(port: number, ip: string): Socket;
}

export function testBrowserNames(spec: string | undefined): TestNames | undefined {
  if (spec === undefined || spec.trim() === "") return undefined;
  const byName = new Map<string, string>();
  const portOf = new Map<string, number>();
  let n = 0;
  for (const entry of spec.split(";")) {
    const m = /^\s*([a-z0-9.-]+)=(\d{1,5})\s*$/i.exec(entry);
    if (m === null) continue;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) continue;
    const ip = `${FAKE_BASE.join(".")}.${100 + n++}`;
    byName.set(m[1]!.toLowerCase(), ip);
    portOf.set(ip, port);
  }
  if (byName.size === 0) return undefined;
  return {
    lookup: async (host) => {
      const ip = byName.get(host.toLowerCase());
      if (ip !== undefined) return [ip];
      const { lookup } = await import("node:dns/promises");
      return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    },
    dial: (port, ip) => {
      const fixture = portOf.get(ip);
      return fixture !== undefined ? netConnect({ port: fixture, host: "127.0.0.1" }) : netConnect({ port, host: ip });
    },
  };
}
