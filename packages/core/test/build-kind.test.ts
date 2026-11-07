import { expect, test } from "bun:test";
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

test.if(process.platform === "darwin")("the account's home comes from the password database, not HOME; the raw environment is readable", async () => {
  const { accountHome, rawEnvironment } = await import("../src/startup-guard");
  const home = accountHome();
  expect(home).toBeString();
  expect(home!.startsWith("/")).toBe(true);
  const raw = rawEnvironment();
  expect(raw).toBeArray();
  expect(raw!.some((e) => e.startsWith("PATH="))).toBe(true);
});

test.if(process.platform === "linux")("the raw environment comes from /proc/self/environ", async () => {
  const { rawEnvironment } = await import("../src/startup-guard");
  expect(rawEnvironment()!.some((e) => e.startsWith("PATH="))).toBe(true);
});

test("a compiled macOS core without the process holder beside it names the missing path; anything else says nothing", async () => {
  const { missingProcessHolder } = await import("../src/build-kind");
  const at = "/Applications/Clover.app/Contents/Resources/daemon/clover-core";
  expect(missingProcessHolder({ platform: "darwin", compiled: true, execPath: at, exists: () => false })).toBe("/Applications/Clover.app/Contents/Resources/daemon/clover-process-holder");
  expect(missingProcessHolder({ platform: "darwin", compiled: true, execPath: at, exists: () => true })).toBeUndefined();
  expect(missingProcessHolder({ platform: "darwin", compiled: false, execPath: at, exists: () => false })).toBeUndefined();
  expect(missingProcessHolder({ platform: "linux", compiled: true, execPath: "/opt/Clover/resources/daemon/clover-core", exists: () => false })).toBeUndefined();
});
