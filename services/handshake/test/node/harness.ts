// Starts test/node/serve.mjs from Bun and hands back the local handshake's origin. For other packages' end-to-end
// tests (the web companion's); import it as "@waifucave/clover-service-handshake/harness".

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface HandshakeHarness {
  /** The handshake's origin, http://127.0.0.1:<port> */
  url: string;
  /** The local sign-in stand-in's origin. */
  accounts: string;
  stop(): Promise<void>;
}

const serviceDir = join(dirname(import.meta.path), "../..");

/** Whether the harness can run here: wrangler installed, and node on the PATH. */
export function harnessReady(): boolean {
  return existsSync(join(serviceDir, "node_modules/wrangler/package.json")) || existsSync(join(serviceDir, "../../node_modules/wrangler/package.json"))
    ? Bun.which("node") !== null
    : false;
}

export async function startHandshake(options: { webOrigins?: string } = {}): Promise<HandshakeHarness> {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const child = Bun.spawn([Bun.which("node")!, join(serviceDir, "test/node/serve.mjs")], {
    cwd: serviceDir,
    env: {
      ...process.env,
      CLOUDFLARE_CF_FETCH_ENABLED: "false",
      WRANGLER_SEND_METRICS: "false",
      HANDSHAKE_E2E: JSON.stringify({ ticketSecret: secret, webOrigins: options.webOrigins ?? "" }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let buffered = "";
  for (;;) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) break;
    const { done, value } = await reader.read();
    if (done) throw new Error("the handshake harness exited before it was listening");
    buffered += new TextDecoder().decode(value);
  }
  const { url, accounts } = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as { url: string; accounts: string };
  return {
    url,
    accounts,
    async stop() {
      await child.stdin.end();
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
      if (exited === null) child.kill();
    },
  };
}
