import { expect, test } from "bun:test";
import { darwinTest } from "./helpers/darwin-only";
import { DIST_BUILD, DIST_BUILD_DEFINE, isCompiledBinary, noteIgnoredEnvOverride } from "../src/build-kind";

test("a core run from source is not a dist build (only build-daemon's define makes one)", () => {
  expect(DIST_BUILD).toBe(false);
  expect(DIST_BUILD_DEFINE).toBe("__CLOVER_DIST__=true");
});

test("compiled-binary paths on every OS, and a checkout's", () => {
  expect(isCompiledBinary("/$bunfs/root/clover-core")).toBe(true);
  expect(isCompiledBinary("B:/~BUN/root/clover-core.exe")).toBe(true);
  expect(isCompiledBinary("B:\\~BUN\\root\\clover-core.exe")).toBe(true);
  expect(isCompiledBinary("/Users/x/clover/packages/cli/src/main.ts")).toBe(false);
  expect(isCompiledBinary("C:\\src\\clover\\packages\\cli\\src\\main.ts")).toBe(false);
});

test("an ignored override is said once per variable", () => {
  const lines: string[] = [];
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_A", (l) => lines.push(l));
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_A", (l) => lines.push(l));
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_B", (l) => lines.push(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("ignoring CLOVER_TEST_ONCE_A");
});

test("a dist build refuses TLS trust from the environment; a proxy and a dev build are fine", async () => {
  const { tlsEnvRefusal, TLS_ENV_REFUSAL_EXIT } = await import("../src/build-kind");
  expect(TLS_ENV_REFUSAL_EXIT).toBe(78);
  expect(tlsEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, true)).toContain("NODE_TLS_REJECT_UNAUTHORIZED is set");
  expect(tlsEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }, true)).toBeUndefined();
  expect(tlsEnvRefusal({ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", SSL_CERT_FILE: "/x" }, true)).toContain("NODE_EXTRA_CA_CERTS, SSL_CERT_FILE are set");
  expect(tlsEnvRefusal({ SSL_CERT_DIR: "/x" }, true)).toContain("SSL_CERT_DIR is set");
  expect(tlsEnvRefusal({ HTTPS_PROXY: "http://proxy:3128", HTTP_PROXY: "x" }, true)).toBeUndefined();
  expect(tlsEnvRefusal({ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" }, false)).toBeUndefined();
  // Present at all refuses, an empty value included: native code reads the first of duplicate entries, JS the last.
  expect(tlsEnvRefusal({ NODE_EXTRA_CA_CERTS: "" }, true)).toContain("NODE_EXTRA_CA_CERTS is set");
  expect(tlsEnvRefusal({ SSL_CERT_FILE: "" }, true)).toContain("SSL_CERT_FILE is set");
  expect(tlsEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: "false" }, true)).toContain("NODE_TLS_REJECT_UNAUTHORIZED is set");
  expect(tlsEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: "" }, true)).toContain("NODE_TLS_REJECT_UNAUTHORIZED is set");
  // Bun's process.env answers `in` true for an unset NODE_TLS_REJECT_UNAUTHORIZED: only a value counts.
  expect(tlsEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: undefined }, true)).toBeUndefined();
  expect(tlsEnvRefusal(process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined ? process.env : {}, true)).toBeUndefined();
});

test("a dist build reads the raw environment too: a duplicate entry can't hide a CA variable or verification off", async () => {
  const { tlsEnvRefusal, TLS_TRUST_ENV } = await import("../src/build-kind");
  const env = { PATH: "/usr/bin" };
  for (const k of TLS_TRUST_ENV) {
    const bad = k === "NODE_TLS_REJECT_UNAUTHORIZED" ? `${k}=0` : `${k}=/tmp/ca.pem`;
    // The refused entry first (native code's) and last (JS's), beside a harmless one.
    for (const raw of [[bad, `${k}=1`], [`${k}=1`, bad], [`${k}=`, bad], [bad]]) {
      expect(tlsEnvRefusal(env, true, raw)).toContain(`${k} is set`);
    }
    expect(tlsEnvRefusal(env, false, [bad])).toBeUndefined();
  }
  expect(tlsEnvRefusal(env, true, ["NODE_TLS_REJECT_UNAUTHORIZED=1", "NODE_TLS_REJECT_UNAUTHORIZED=1", "HTTPS_PROXY=http://p:1", "=NODE_EXTRA_CA_CERTS=x"])).toBeUndefined();
  expect(tlsEnvRefusal(env, true, ["NODE_EXTRA_CA_CERTS"])).toContain("NODE_EXTRA_CA_CERTS is set");
});

test("a macOS dist build refuses a HOME that isn't the account's own (real path); an unset HOME is fine", async () => {
  const { homeRefusal } = await import("../src/startup-guard");
  const account = () => "/Users/me";
  const real = (p: string) => (p === "/private/var/me-link" ? "/Users/me" : p.replace(/\/$/, ""));
  const on = { platform: "darwin" as const, distBuild: true, account, real };
  expect(homeRefusal({ ...on, home: undefined })).toBeUndefined();
  expect(homeRefusal({ ...on, home: "/Users/me" })).toBeUndefined();
  expect(homeRefusal({ ...on, home: "/Users/me/" })).toBeUndefined();
  expect(homeRefusal({ ...on, home: "/private/var/me-link" })).toBeUndefined();
  expect(homeRefusal({ ...on, home: "/tmp/planted" })).toContain("HOME is \"/tmp/planted\", not this account's home (/Users/me)");
  expect(homeRefusal({ ...on, home: "" })).toContain("HOME is \"\"");
  expect(homeRefusal({ ...on, home: "/Users/me", account: () => undefined })).toContain("could not be read");
  expect(homeRefusal({ ...on, home: "/tmp/planted", distBuild: false })).toBeUndefined();
  expect(homeRefusal({ ...on, home: "/tmp/planted", platform: "linux" })).toBeUndefined();
});

test("a macOS release refuses any DYLD_ entry (SIP is off if one reached it); other OSes and dev builds don't", async () => {
  const { dyldRefusal } = await import("../src/startup-guard");
  const on = { platform: "darwin" as const, distBuild: true };
  expect(dyldRefusal(["PATH=/usr/bin", "HOME=/Users/me"], on)).toBeUndefined();
  expect(dyldRefusal(["PATH=/usr/bin", "DYLD_INSERT_LIBRARIES=/tmp/x.dylib"], on)).toContain("DYLD_INSERT_LIBRARIES");
  expect(dyldRefusal(["DYLD_LRAWBR=--preload=/tmp/p.js"], on)).toContain("SIP is off");
  expect(dyldRefusal(["DYLD_=1"], on)).toContain("refusing to start");
  expect(dyldRefusal(["DYLD_X"], on)).toContain("DYLD_X");
  expect(dyldRefusal(["X=DYLD_Y=1"], on)).toBeUndefined();
  expect(dyldRefusal(["DYLD_INSERT_LIBRARIES=/x"], { ...on, distBuild: false })).toBeUndefined();
  expect(dyldRefusal(["DYLD_INSERT_LIBRARIES=/x"], { ...on, platform: "linux" })).toBeUndefined();
});

test("a release refuses to start with any test-keychain variable set, naming it; a dev build doesn't", async () => {
  const { testKeychainRefusal } = await import("../src/startup-guard");
  expect(testKeychainRefusal({}, [], true)).toBeUndefined();
  expect(testKeychainRefusal({ CLOVER_TEST_KEYCHAIN: "/tmp/t.keychain-db" }, [], true)).toContain("CLOVER_TEST_KEYCHAIN is set");
  expect(testKeychainRefusal({ CLOVER_KEYCHAIN_SERVICE: "x", WINTER_TEST_KEYCHAIN: "memory" }, [], true)).toContain("CLOVER_KEYCHAIN_SERVICE, WINTER_TEST_KEYCHAIN are set");
  expect(testKeychainRefusal({}, ["CLOVER_TEST_KEYCHAIN="], true)).toContain("CLOVER_TEST_KEYCHAIN is set");
  expect(testKeychainRefusal({}, ["NOT_CLOVER_TEST_KEYCHAIN=1"], true)).toBeUndefined();
  expect(testKeychainRefusal({ CLOVER_TEST_KEYCHAIN: "/tmp/t" }, [], false)).toBeUndefined();
});

darwinTest("the account's home comes from the password database, not HOME", async () => {
  const { accountHome } = await import("../src/startup-guard");
  const home = accountHome();
  expect(home).toBeString();
  expect(home!.startsWith("/")).toBe(true);
});

test("the raw environment is readable (macOS _NSGetEnviron, Linux /proc/self/environ; none on Windows)", async () => {
  const { rawEnvironment } = await import("../src/startup-guard");
  const raw = rawEnvironment();
  if (process.platform === "win32") expect(raw).toBeUndefined();
  else expect(raw!.some((e) => e.startsWith("PATH="))).toBe(true);
});

test("a compiled macOS core without the process holder beside it names the missing path; anything else says nothing", async () => {
  const { missingProcessHolder } = await import("../src/build-kind");
  const at = "/Applications/Clover.app/Contents/Resources/daemon/clover-core";
  expect(missingProcessHolder({ platform: "darwin", compiled: true, execPath: at, exists: () => false })).toBe("/Applications/Clover.app/Contents/Resources/daemon/clover-process-holder");
  expect(missingProcessHolder({ platform: "darwin", compiled: true, execPath: at, exists: () => true })).toBeUndefined();
  expect(missingProcessHolder({ platform: "darwin", compiled: false, execPath: at, exists: () => false })).toBeUndefined();
  expect(missingProcessHolder({ platform: "linux", compiled: true, execPath: "/opt/Clover/resources/daemon/clover-core", exists: () => false })).toBeUndefined();
});

// A test-marked release build's start (scripts/test-build.ts): a test's keychain file and a temp home, or no start.
test("a test-marked build starts only with a throwaway keychain file and a HOME and CLOVER_HOME outside this account's home", async () => {
  const { testBuildStartRefusal } = await import("../src/startup-guard");
  const { join, sep } = await import("node:path");
  // Paths in this OS's own form, so the cases hold wherever the suite runs (a test build itself is macOS's).
  const root = process.platform === "win32" ? "C:\\" : "/";
  const account = join(root, "Users", "someone");
  const run = join(root, "tmp", "run");
  const o = { account: () => account, real: (p: string) => p.replace(/[\\/]+$/, "") };
  const ok = { CLOVER_TEST_KEYCHAIN: join(run, "t.keychain-db"), HOME: join(run, "home") };
  expect(testBuildStartRefusal(ok, [], o)).toBeUndefined();
  expect(testBuildStartRefusal({ ...ok, CLOVER_HOME: join(run, "clover") }, [], o)).toBeUndefined();
  // No keychain file, or an empty one, in the environment or in any raw entry.
  expect(testBuildStartRefusal({ HOME: join(run, "home") }, [], o)).toContain("CLOVER_TEST_KEYCHAIN is not set");
  expect(testBuildStartRefusal({ ...ok, CLOVER_TEST_KEYCHAIN: "" }, [], o)).toContain("CLOVER_TEST_KEYCHAIN is empty");
  expect(testBuildStartRefusal(ok, ["CLOVER_TEST_KEYCHAIN="], o)).toContain("CLOVER_TEST_KEYCHAIN is empty");
  // HOME: unset, this account's (with a trailing separator too), or a duplicate entry naming it.
  expect(testBuildStartRefusal({ CLOVER_TEST_KEYCHAIN: join(run, "k") }, [], o)).toContain("HOME is not set");
  expect(testBuildStartRefusal({ ...ok, HOME: account }, [], o)).toContain("HOME is this account's home");
  expect(testBuildStartRefusal({ ...ok, HOME: `${account}${sep}` }, [], o)).toContain("HOME is this account's home");
  expect(testBuildStartRefusal(ok, [`HOME=${account}`], o)).toContain("HOME is this account's home");
  expect(testBuildStartRefusal({ ...ok, HOME: "" }, [], o)).toContain("HOME is this account's home");
  // CLOVER_HOME inside this account's home (the live .clover, or any folder there) or empty; a look-alike prefix is fine.
  expect(testBuildStartRefusal({ ...ok, CLOVER_HOME: join(account, ".clover") }, [], o)).toContain("CLOVER_HOME is inside this account's home");
  expect(testBuildStartRefusal({ ...ok, CLOVER_HOME: account }, [], o)).toContain("CLOVER_HOME is inside");
  expect(testBuildStartRefusal(ok, [`CLOVER_HOME=${join(account, "x")}`], o)).toContain("CLOVER_HOME is inside");
  expect(testBuildStartRefusal({ ...ok, CLOVER_HOME: "" }, [], o)).toContain("CLOVER_HOME is inside");
  expect(testBuildStartRefusal({ ...ok, CLOVER_HOME: join(root, "Users", "someone-other", ".clover") }, [], o)).toBeUndefined();
  // An account home that can't be read refuses (it can't tell a temp HOME from the real one).
  expect(testBuildStartRefusal(ok, [], { ...o, account: () => undefined })).toContain("could not be read");
  // Every refusal names the build and never the login keychain as a fallback.
  expect(testBuildStartRefusal({}, [], o)).toContain("test-marked build");
});

darwinTest("a test-marked build's HOME check follows links: a link to this account's home is its home", async () => {
  const { testBuildStartRefusal, accountHome } = await import("../src/startup-guard");
  const { mkdtempSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const own = accountHome();
  if (own === undefined) return;
  const dir = mkdtempSync(join(tmpdir(), "lane-int-home-link-"));
  try {
    symlinkSync(own, join(dir, "home"));
    expect(testBuildStartRefusal({ CLOVER_TEST_KEYCHAIN: join(dir, "k"), HOME: join(dir, "home") }, [])).toContain("HOME is this account's home");
    expect(testBuildStartRefusal({ CLOVER_TEST_KEYCHAIN: join(dir, "k"), HOME: dir }, [])).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
