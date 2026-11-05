// C0 (review S1): loading core makes every provider call in this process present as Clover — the product token in
// `User-Agent`, the Codex backend's `originator` (spec §3.3: "clover") and the contact URL — not the SDK's defaults.
import { describe, expect, test } from "bun:test";
import "../../src/index";
import { activeWinterIdentity, winterUserAgent } from "@waifucave/clover-provider-runtime";
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

  test("codex-config's header table repeats the same originator", () => {
    expect(CODEX.headers.originator).toBe(CORE_BRAND.codexOriginator);
  });
});
