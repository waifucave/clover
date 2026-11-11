#!/usr/bin/env bun
// The owner's signing tool for the official plugin index (docs/plugin-index-signing.md). The Ed25519 key lives in
// his macOS login keychain, as a generic password (the 32-byte seed in base64); this tool reaches it by reference
// (service and account) through `security`, keeps it in memory only for the signature, and never prints it, writes
// it to disk or passes it on a command line.
//
//   bun scripts/plugin-index-key.ts create [--service S] [--account A]   make a key in the keychain; prints its public key
//   bun scripts/plugin-index-key.ts public [--service S] [--account A]   prints the public key (hex), for OFFICIAL_INDEX.keys
//   bun scripts/plugin-index-key.ts sign <file> [--after <seq>] [...]    writes <file>.sig over the file's exact bytes
//
// Nothing here runs in a test or in CI: tests sign with a key they make (`registry/indexes/signing.ts`).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { publicKeyHex, signFile, type KeySource } from "../packages/core/src/registry/indexes/signing";

const DEFAULT_SERVICE = "com.waifucave.clover.plugin-index";
const DEFAULT_ACCOUNT = "official";

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function fail(why: string): never {
  process.stderr.write(`plugin-index-key: ${why}\n`);
  process.exit(1);
}

/** The keychain item, by reference: read through `security`, its output kept in memory. */
function keychain(service: string, account: string): KeySource & { exists(): boolean; create(seed: Uint8Array): void } {
  return {
    exists: () => Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", service, "-a", account], { stdout: "ignore", stderr: "ignore" }).exitCode === 0,
    async seed() {
      const r = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"], { stdout: "pipe", stderr: "ignore" });
      if (r.exitCode !== 0) fail(`there is no key in the keychain under ${service} / ${account} (or access was refused)`);
      const text = r.stdout.toString().trim();
      r.stdout.fill(0);
      const seed = Buffer.from(text, "base64");
      if (seed.byteLength !== 32) fail("the keychain item isn't a 32-byte Ed25519 seed in base64");
      return new Uint8Array(seed);
    },
    create(seed) {
      // Through `security -i`'s standard input, so the secret is never on a command line another process can read.
      const line = `add-generic-password -s ${service} -a ${account} -l "Clover plugin index signing key" -w ${Buffer.from(seed).toString("base64")}\n`;
      const r = Bun.spawnSync(["/usr/bin/security", "-i"], { stdin: Buffer.from(line), stdout: "ignore", stderr: "pipe" });
      seed.fill(0);
      if (r.exitCode !== 0) fail(`the keychain didn't take the key (${r.stderr.toString().trim().slice(0, 200)})`);
    },
  };
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const service = arg("--service", args) ?? DEFAULT_SERVICE;
  const account = arg("--account", args) ?? DEFAULT_ACCOUNT;
  if (process.platform !== "darwin") fail("this tool uses the macOS login keychain");
  const key = keychain(service, account);
  if (cmd === "create") {
    if (key.exists()) fail(`a key is already there under ${service} / ${account}; rotating makes a new account (see the doc)`);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const pub = publicKeyHex(seed);
    key.create(seed);
    process.stdout.write(`${pub}\n`);
    return;
  }
  if (cmd === "public") {
    const seed = await key.seed();
    try {
      process.stdout.write(`${publicKeyHex(seed)}\n`);
    } finally {
      seed.fill(0);
    }
    return;
  }
  if (cmd === "sign") {
    const file = args[0];
    if (file === undefined || file.startsWith("--") || !existsSync(file)) fail("usage: sign <file> [--after <seq>] [--service S] [--account A]");
    const afterText = arg("--after", args);
    const after = afterText === undefined ? undefined : Number(afterText);
    if (after !== undefined && !Number.isInteger(after)) fail("--after takes the seq last published");
    const bytes = readFileSync(file);
    let r: Awaited<ReturnType<typeof signFile>>;
    try {
      r = await signFile(bytes, key, after === undefined ? {} : { after });
    } catch (err) {
      fail((err as Error).message);
    }
    writeFileSync(`${file}.sig`, r.sig);
    process.stdout.write(`signed ${r.kind} seq ${r.seq} with ${r.publicKey}: ${file}.sig\n`);
    return;
  }
  fail("usage: create | public | sign <file> [--after <seq>]   [--service S] [--account A]");
}

void main();
