// C0 (review S1): loading core makes every provider call in this process present as Clover — the product token in
// `User-Agent`, the Codex backend's `originator` (spec §3.3: "clover") and the contact URL — not the SDK's defaults.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import "../../src/index";
import { activeWinterIdentity, winterUserAgent } from "@waifucave/clover-provider-runtime";
import { WINTER_BRAND, installedBrand, requireBrand } from "@waifucave/clover-agent-sdk";
import { CODEX } from "../../src/providers/codex-config";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import { CORE_VERSION } from "../../src/version";
import { installCloverProcessIdentity } from "../../src/runtime-sdk/process-identity";

describe("the process-wide provider identity", () => {
  test("is Clover's as soon as core is loaded", () => {
    expect(activeWinterIdentity()).toEqual({ product: "clover-core", codexOriginator: "clover", contactUrl: "https://github.com/waifucave/clover", version: CORE_VERSION });
    // A-M1: Clover's own release after its name (CORE_BRAND.productVersion), not the SDK's version.
    expect(winterUserAgent()).toBe(`clover-core/${CORE_VERSION}`);
  });

  test("comes from the brand, and installing it again changes nothing", () => {
    installCloverProcessIdentity();
    expect(activeWinterIdentity()).toEqual({ product: CORE_BRAND.packageName, codexOriginator: CORE_BRAND.codexOriginator, contactUrl: CORE_BRAND.contactUrl, version: CORE_BRAND.productVersion });
  });

  test("the process's SDK brand is Clover's, so an unthreaded SDK call reads Clover's names, never the live install's", () => {
    // A-M1 review: the SDK has no default brand. Core installs CORE_BRAND when it loads; an SDK reader handed no
    // brand reads it (and with none installed would refuse), so nothing in this process can land on another home.
    expect(installedBrand()).toEqual(CORE_BRAND);
    expect(requireBrand().homeDirName).toBe(".clover");
    expect(requireBrand().envPrefix).toBe("CLOVER_");
    expect(requireBrand().keychainService).toBe(CORE_BRAND.keychainService);
  });

  test("core refuses to load in a process that installed another brand first, instead of running under it", async () => {
    // A fresh process (no test preload): another product's profile (the SDK's WINTER_BRAND) is installed first, then core is loaded.
    const script = [
      `import { WINTER_BRAND, installBrand } from "@waifucave/clover-agent-sdk";`,
      `installBrand(WINTER_BRAND);`,
      `try { await import(${JSON.stringify(fileURLToPath(new URL("../../src/runtime-sdk/process-identity.ts", import.meta.url)))}); console.log("LOADED"); }`,
      `catch (err) { console.log("REFUSED " + (err instanceof Error ? err.message : String(err))); }`,
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(out.trim()).toBe(`REFUSED clover-core: this process already serves another brand (${WINTER_BRAND.packageName}), installed before core loaded; core runs only under ${CORE_BRAND.packageName}'s`);
  }, 30_000);

  test("codex-config's header table repeats the same originator", () => {
    expect(CODEX.headers.originator).toBe(CORE_BRAND.codexOriginator);
  });
});
