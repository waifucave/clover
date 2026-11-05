// The Keychain service a process's default secret store uses (`auth/secret-store.ts`'s DEFAULT_SECRET_SERVICE),
// resolved in a FRESH process per environment — names only: nothing here reads or writes the Keychain.
//
// The isolation fix (2026-10-09): a process run on an explicit, non-default CLOVER_HOME honours
// CLOVER_KEYCHAIN_SERVICE, so a hand-started experiment daemon never probes the user's real
// `com.waifucave.clover.core[.dev]` items (it used to, raising a consent prompt per item another binary created).
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "..", "..", "src", "auth", "secret-store.ts");

function serviceUnder(env: Record<string, string | undefined>): string {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const r = Bun.spawnSync(["bun", "-e", `const m = await import(${JSON.stringify(MODULE)}); console.log("SERVICE=" + m.DEFAULT_SECRET_SERVICE);`], { env: clean, stdout: "pipe", stderr: "pipe" });
  const line = r.stdout.toString().split("\n").find((l) => l.startsWith("SERVICE="));
  if (line === undefined) throw new Error(`no answer: ${r.stderr.toString()}`);
  return line.slice("SERVICE=".length);
}

describe("the default secret store's Keychain service", () => {
  const temp = join(tmpdir(), "clover-isolation-probe-home");

  test("an explicit custom CLOVER_HOME honours CLOVER_KEYCHAIN_SERVICE — dist and dev profile alike", () => {
    expect(serviceUnder({ CLOVER_HOME: temp, CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core.test-iso");
    expect(serviceUnder({ CLOVER_HOME: temp, CLOVER_PROFILE: "dev", CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core.test-iso");
  });

  test("no override, or no explicit home: the profile's own service (unchanged)", () => {
    expect(serviceUnder({ CLOVER_HOME: temp })).toBe("com.waifucave.clover.core");
    expect(serviceUnder({ CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core");
    expect(serviceUnder({ CLOVER_PROFILE: "dev", CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core.dev");
  });

  test("the profile's DEFAULT home is never redirected by the env var", () => {
    expect(serviceUnder({ CLOVER_HOME: join(homedir(), ".clover-dev"), CLOVER_PROFILE: "dev", CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core.dev");
    expect(serviceUnder({ CLOVER_HOME: join(homedir(), ".clover"), CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-iso" })).toBe("com.waifucave.clover.core");
  });
});
