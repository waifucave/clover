import { describe, expect, test } from "bun:test";
import { notServed, OptionalCalls } from "../src/main/pair/optional-calls";
import { RpcCallError } from "../src/main/protocol/client";

const client = (fail?: Error) => ({ request: (async (m: string) => { if (fail) throw fail; return { m }; }) as never });

describe("setup calls the daemon doesn't serve yet", () => {
  test("method-not-found and 'is not served yet' count; other failures don't", () => {
    expect(notServed(new RpcCallError(-32601, "x"))).toBe(true);
    expect(notServed(new RpcCallError(-32000, "plugin.ui is not served yet"))).toBe(true);
    expect(notServed(new RpcCallError(-32000, "boom"))).toBe(false);
    expect(notServed(new Error("plugin.ui is not served yet"))).toBe(false);
  });

  test("a missing method reads undefined and is logged once; a served one answers; a real failure throws", async () => {
    const lines: string[] = [];
    const o = new OptionalCalls((l) => lines.push(l));
    const missing = client(new RpcCallError(-32601, "plugin.ui is not served yet"));
    expect(await o.call(missing, "plugin.ui")).toBeUndefined();
    expect(await o.call(missing, "plugin.ui")).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(await o.call(client(), "ui.settings")).toEqual({ m: "ui.settings" });
    await expect(o.call(client(new RpcCallError(-32000, "boom")), "ui.settings")).rejects.toThrow("boom");
  });
});
