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
  expect(tlsEnvRefusal({ NODE_EXTRA_CA_CERTS: "" }, true)).toBeUndefined();
});
