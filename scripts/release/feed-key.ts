// The update feed's Ed25519 key, the owner's (packages/update-feed). The private half lives only in the owner's login
// Keychain, read into memory at the release step to sign the update files, and never written anywhere else: not to
// disk, not to CI, not to a log. The public half is committed in packages/update-feed/src/key.ts, so the app and the
// daemon carry it.
//
//   bun scripts/release/feed-key.ts --generate   once: makes the pair, keeps the private half in the Keychain and
//                                                writes the public half into key.ts (commit it)
//   bun scripts/release/feed-key.ts --check      the Keychain's key matches the committed one
//
// Both are the owner's, on their Mac; CI and agents never run them.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFeedKey, publicKeyOf, UPDATE_FEED_PUBLIC_KEY } from "../../packages/update-feed/src/index";

/** Where the private half is kept: the login Keychain, through Bun.secrets. */
export const FEED_KEY_ITEM = { service: "com.waifucave.clover.release", name: "update-feed-ed25519" } as const;

/** The Keychain, narrowed to what's used (tests pass a fake: they never touch the real one). */
export interface KeyStore {
  get(item: typeof FEED_KEY_ITEM): Promise<string | null>;
  set(item: typeof FEED_KEY_ITEM & { value: string }): Promise<void>;
}

export const keychain: KeyStore = {
  get: (item) => Bun.secrets.get(item),
  set: (item) => Bun.secrets.set(item),
};

export const KEY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "update-feed", "src", "key.ts");

/** key.ts with `publicKey` in place of the line that holds the key. */
export function withPublicKey(source: string, publicKey: string): string {
  const line = /^export const UPDATE_FEED_PUBLIC_KEY: string \| null = .*;$/m;
  if (!line.test(source)) throw new Error("key.ts no longer has its UPDATE_FEED_PUBLIC_KEY line");
  return source.replace(line, `export const UPDATE_FEED_PUBLIC_KEY: string | null = ${JSON.stringify(publicKey)};`);
}

/**
 * The private key to sign with, checked against the committed public key: the release step signs nothing with a
 * key the app wouldn't accept. Throws with what's wrong (never the key).
 */
export async function signingKey(store: KeyStore, embedded: string | null = UPDATE_FEED_PUBLIC_KEY): Promise<string> {
  if (embedded === null) throw new Error("there is no update feed key yet: the owner runs `bun scripts/release/feed-key.ts --generate` and commits key.ts");
  const privateKey = await store.get(FEED_KEY_ITEM);
  if (privateKey === null) throw new Error(`the login Keychain has no ${FEED_KEY_ITEM.service} / ${FEED_KEY_ITEM.name}`);
  if (publicKeyOf(privateKey) !== embedded) throw new Error("the Keychain's update feed key is not the one the app carries (packages/update-feed/src/key.ts)");
  return privateKey;
}

export async function generate(store: KeyStore, keyFile: string, embedded: string | null = UPDATE_FEED_PUBLIC_KEY): Promise<string> {
  if (embedded !== null) throw new Error("the app already carries an update feed key; replacing it is a key rotation, not a --generate");
  if ((await store.get(FEED_KEY_ITEM)) !== null) throw new Error(`the login Keychain already holds ${FEED_KEY_ITEM.service} / ${FEED_KEY_ITEM.name}`);
  const pair = generateFeedKey();
  await store.set({ ...FEED_KEY_ITEM, value: pair.privateKey });
  writeFileSync(keyFile, withPublicKey(readFileSync(keyFile, "utf8"), pair.publicKey));
  return pair.publicKey;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (process.platform !== "darwin") { console.error("feed-key: the key lives in the owner's login Keychain, on their Mac"); return 2; }
  try {
    if (argv.length === 1 && argv[0] === "--generate") {
      const pub = await generate(keychain, KEY_FILE);
      console.log(`feed-key: made the update feed key; its public half, ${pub}, is in packages/update-feed/src/key.ts: commit it`);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--check") {
      await signingKey(keychain);
      console.log("feed-key: the Keychain's update feed key matches the one the app carries");
      return 0;
    }
    console.error("usage: feed-key --generate | --check");
    return 2;
  } catch (err) {
    console.error(`feed-key: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
