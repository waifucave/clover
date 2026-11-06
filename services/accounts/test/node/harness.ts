// Starts the account service (test/node/serve.mjs) from Bun against a sign-in stack, for end-to-end tests: this
// service's own and the core's (lane H's AccountClient). Import it as "@waifucave/clover-service-accounts/harness".
// It answers with the same `url`, `issuer` and `jwks` as the core's `startFakeAccountService`, so a test can swap one
// for the other. The signing key is made here, in memory, for this run.

import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AccountServiceHarness {
  /** The service's origin, http://127.0.0.1:<port>; also its issuer. */
  url: string;
  issuer: string;
  /** `{"keys":[...]}`: the public half of this run's signing key, for `verifyAccountToken`. */
  jwks: string;
  stop(): Promise<void>;
}

export interface AccountServiceOptions {
  /** The sign-in stack's project URL and public key (lane M's stub: `url` and `anonKey`). */
  authUrl: string;
  anonKey: string;
  /** Seconds a token lives, at most 300. */
  tokenTtlSeconds?: number;
  /** Also open POST /dev/token, the mint without a sign-in. */
  devMint?: boolean;
}

const serviceDir = join(dirname(import.meta.path), "../..");

/** Whether the harness can run here: wrangler installed, and node on the PATH. */
export function harnessReady(): boolean {
  return existsSync(join(serviceDir, "node_modules/wrangler/package.json")) || existsSync(join(serviceDir, "../../node_modules/wrangler/package.json"))
    ? Bun.which("node") !== null
    : false;
}

export async function startAccountService(options: AccountServiceOptions): Promise<AccountServiceHarness> {
  const key = generateKeyPairSync("ed25519");
  const kid = `harness-${crypto.randomUUID().slice(0, 8)}`;
  const signingJwks = JSON.stringify({ keys: [{ ...key.privateKey.export({ format: "jwk" }), kid }] });
  const jwks = JSON.stringify({ keys: [{ ...key.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] });
  const child = Bun.spawn([Bun.which("node")!, join(serviceDir, "test/node/serve.mjs")], {
    cwd: serviceDir,
    env: {
      ...process.env,
      CLOUDFLARE_CF_FETCH_ENABLED: "false",
      WRANGLER_SEND_METRICS: "false",
      ACCOUNTS_E2E: JSON.stringify({
        authUrl: options.authUrl,
        anonKey: options.anonKey,
        signingJwks,
        tokenTtl: options.tokenTtlSeconds ?? 300,
        devMint: options.devMint ?? false,
      }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("the account service's harness exited before it was listening");
    buffered += new TextDecoder().decode(value);
  }
  const { url } = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as { url: string };
  return {
    url,
    issuer: url,
    jwks,
    async stop() {
      await child.stdin.end();
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
      if (exited === null) child.kill();
    },
  };
}
