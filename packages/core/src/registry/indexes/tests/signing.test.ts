// The owner's signing (docs/plugin-index-signing.md): a file's exact bytes signed, a `.sig` the client takes, the file
// checked first (format 1, `seq` above the last published). A key made here, never a keychain.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifySigned } from "../client";
import { OFFICIAL_INDEX } from "../official";
import { checkSignable, keychainName, keychainRefused, publicKeyHex, seedFromBase64, signFile, signFloor, type KeySource } from "../signing";

const seed = () => crypto.getRandomValues(new Uint8Array(32));
const source = (s: Uint8Array): KeySource & { reads: number } => {
  const k = { reads: 0, seed: async () => (k.reads++, new Uint8Array(s)) };
  return k;
};
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const INDEX = { index: 1, issued: "2026-11-20T12:00:00Z", seq: 4, name: "Clover plugins", plugins: [] };
const LIST = { revocations: 1, issued: "2026-11-20T12:00:00Z", seq: 2, entries: [{ id: "evil", reason: "It sends your files away." }] };

describe("signing an index or a revocation list", () => {
  test("the exact bytes, verified by the client under the public key; the seed wiped after", async () => {
    const s = seed();
    const key = source(s);
    const b = bytes(INDEX);
    const r = await signFile(b, key, { after: 3 });
    expect([r.kind, r.seq, r.publicKey]).toEqual(["index", 4, publicKeyHex(s)]);
    expect(verifySigned(b, r.sig, [r.publicKey])).toBe(true);
    expect(verifySigned(bytes({ ...INDEX, name: "Other" }), r.sig, [r.publicKey])).toBe(false);
    expect(r.sig.endsWith("\n")).toBe(true);
    expect((await signFile(bytes(LIST), key)).kind).toBe("revocations");
  });

  test("refused before signing: not JSON, not format 1, no seq, a seq not above the last published", async () => {
    const key = source(seed());
    const why = (b: Uint8Array, after?: number) => signFile(b, key, after === undefined ? {} : { after }).then(() => "signed", (e: Error) => e.message);
    expect(await why(new TextEncoder().encode("{nope"))).toContain("isn't UTF-8 JSON");
    expect(await why(bytes({ index: 1, name: "x", plugins: [] }))).toContain("isn't a plugin index Clover reads");
    expect(await why(bytes({ ...LIST, seq: undefined }))).toContain("isn't a revocation list Clover reads");
    expect(await why(bytes(INDEX), 4)).toContain("must be above the last one published (4)");
    expect(key.reads).toBe(0);
    expect(checkSignable(bytes(INDEX))).toEqual({ kind: "index", seq: 4, issued: "2026-11-20T12:00:00Z" });
  });

  test("sign needs --after <seq> or --first, never neither: the seq check is never skipped by leaving a flag out", () => {
    const why = (args: string[]) => { try { return signFloor(args); } catch (e) { return (e as Error).message; } };
    expect(why(["index.json"])).toContain("give --after");
    expect(why(["index.json", "--after", "3"])).toEqual({ after: 3 });
    expect(why(["index.json", "--first"])).toEqual({});
    expect(why(["index.json", "--first", "--after", "3"])).toContain("not both");
    for (const bad of ["", "x", "-1", "1.5", "1e3"]) expect(why(["f", "--after", bad])).toContain("whole number");
    expect(why(["f", "--after"])).toContain("whole number");
  });

  test("keychain names: letters, digits, '.', '_' and '-' only (they go into security -i's line); its refusal shows no output of its", () => {
    expect(keychainName("com.waifucave.clover.plugin-index", "--service")).toBe("com.waifucave.clover.plugin-index");
    expect(keychainName("official_2", "--account")).toBe("official_2");
    for (const bad of [undefined, "", "a b", 'a"b', "a\nadd-generic-password", "a;b", "a$b", "x".repeat(129)]) {
      expect(() => keychainName(bad, "--account")).toThrow("--account takes letters, digits");
    }
    expect(keychainRefused(45)).toBe("the keychain refused the key (security exited with 45)");
    const tool = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "..", "scripts", "plugin-index-key.ts"), "utf8");
    expect(tool).not.toContain("stderr: \"pipe\"");
    expect(tool).not.toMatch(/r\.stderr/);
  });

  test("the keychain's text read as the seed; a wrong length refused", () => {
    const s = seed();
    expect(seedFromBase64(`${Buffer.from(s).toString("base64")}\n`)).toEqual(s);
    expect(() => seedFromBase64(Buffer.from(new Uint8Array(31)).toString("base64"))).toThrow("32-byte");
  });

  test("no real key in the repo: the official index is empty, the tool reads the keychain by reference only", () => {
    expect(OFFICIAL_INDEX).toBeUndefined();
    const tool = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "..", "scripts", "plugin-index-key.ts"), "utf8");
    // The secret goes to `security -i` on its stdin, never on a command line, and is never printed.
    expect(tool).toContain(`Bun.spawnSync(["/usr/bin/security", "-i"], { stdin:`);
    // What it prints: public keys and the .sig's name only, never the seed (base64 or raw).
    for (const line of tool.split("\n").filter((l) => l.includes("stdout.write("))) expect(line).toMatch(/publicKeyHex\(seed\)|\$\{pub\}|signed \$\{r\.kind\}/);
  });
});
