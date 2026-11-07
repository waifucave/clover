// `clover-core __verify-feed <update file>`: the update feed's signature check (packages/update-feed) inside the
// daemon's own binary, against the key it carries, for a server's daemon updating itself (spec §3.1) and for
// `build:daemon --smoke`. It reads the file and `<file>.sig` beside it, and answers before anything reads the file:
// `feed: ok`, or `feed: refused (<reason>)` with exit 1.
import { existsSync, readFileSync } from "node:fs";
import { SIGNATURE_SUFFIX, UPDATE_FEED_PUBLIC_KEY, verifyFeed } from "@waifucave/clover-update-feed";

export function runVerifyFeed(file: string | undefined, publicKey: string | null = UPDATE_FEED_PUBLIC_KEY): { code: number; line: string } {
  if (file === undefined || !existsSync(file)) return { code: 2, line: "usage: clover-core __verify-feed <update file> (its signature beside it, <file>.sig)" };
  const sigFile = `${file}${SIGNATURE_SUFFIX}`;
  const signature = existsSync(sigFile) ? readFileSync(sigFile, "utf8") : undefined;
  const verdict = verifyFeed(new Uint8Array(readFileSync(file)), signature, publicKey);
  return verdict.ok ? { code: 0, line: "feed: ok" } : { code: 1, line: `feed: refused (${verdict.reason})` };
}
