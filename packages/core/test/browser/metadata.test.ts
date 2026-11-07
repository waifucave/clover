// The browser's address filter and the fence contract agree on the cloud metadata addresses: every address in
// `CLOUD_METADATA_ADDRESSES` (lane C's fence, with J's additions) is one the filter refuses for every owner, so the two
// lists can't drift. The filter keeps its own list because the app shares `network.ts` and can't import the core.
import { describe, expect, test } from "bun:test";
import { isIP } from "node:net";
import { CLOUD_METADATA_ADDRESSES } from "../../src/contracts/fence";
import { addressAllowed, BOT_LAN_POLICY, BOT_POLICY, classifyAddress, PERSON_POLICY, SESSION_POLICY } from "../../src/browser/network";

describe("cloud metadata addresses", () => {
  test("every address in the fence contract's list is metadata to the filter, refused for everyone", () => {
    const ips = [...CLOUD_METADATA_ADDRESSES.filter((a) => isIP(a) !== 0), "fd20:ce::254"];
    for (const ip of ips) {
      expect(`${ip} ${classifyAddress(ip)}`).toBe(`${ip} metadata`);
      for (const policy of [BOT_POLICY, BOT_LAN_POLICY, SESSION_POLICY, PERSON_POLICY]) expect(addressAllowed(ip, policy)).toBe(false);
    }
    // Spelled out in full, the same addresses.
    expect(classifyAddress("fd20:00ce:0000:0000:0000:0000:0000:0254")).toBe("metadata");
    expect(classifyAddress("fd20:ce::255")).not.toBe("metadata");
  });
});
