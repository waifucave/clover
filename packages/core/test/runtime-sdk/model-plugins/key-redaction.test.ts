// The keyed fetch's key never reaches the plugin (key-redaction.ts): masked in the body, a key split across pieces
// included, at the same length; a header holding it dropped; an error's message masked with its code kept.
import { describe, expect, test } from "bun:test";
import { ContractError } from "../../../src/contracts/common";
import { maskError, maskResponse, maskStream, maskText, noteKeys } from "../../../src/runtime-sdk/model-plugins/key-redaction";

const KEY = "sk-test-0123456789abcdefKEY";

function pieces(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

describe("key redaction", () => {
  test("a key split across pieces at every offset is masked, at the same length", async () => {
    const text = `start ${KEY} middle ${KEY}${KEY} end`;
    for (let size = 1; size <= text.length; size += 3) {
      const out = await new Response(maskStream(pieces(text, size), new Set([KEY]))).text();
      expect(out).not.toContain(KEY);
      expect(out.length).toBe(text.length);
      expect(out).toBe(text.split(KEY).join("*".repeat(KEY.length)));
    }
  });

  test("a key learnt while the body streams (a 401's newer token) is masked from then on", async () => {
    const keys = new Set<string>();
    const newer = "sk-newer-token-ABCDEFGH";
    const body = maskStream(pieces(`a ${newer} b`, 4), keys);
    keys.add(newer);
    expect(await new Response(body).text()).toBe(`a ${"*".repeat(newer.length)} b`);
  });

  test("a response: any header holding the key dropped (a set-cookie too), the rest kept, the body masked", async () => {
    const res = new Response(`echo ${KEY}`, { status: 201, statusText: "Made", headers: [["x-echo", `Bearer ${KEY}`], ["x-fine", "yes"], ["set-cookie", `s=${KEY}`], ["set-cookie", "t=1"]] });
    const out = maskResponse(res, new Set([KEY]));
    expect(out.status).toBe(201);
    expect(out.headers.get("x-echo")).toBeNull();
    expect(out.headers.get("x-fine")).toBe("yes");
    expect(out.headers.getSetCookie()).toEqual(["t=1"]);
    expect(await out.text()).toBe(`echo ${"*".repeat(KEY.length)}`);
  });

  test("an error's message masked; its name, code and detail kept; a contract error stays one", () => {
    const keyed = Object.assign(new Error(`redirect to https://x.example/?k=${KEY} refused`), { name: "KeyedFetchError", code: "redirect_refused" });
    const m = maskError(keyed, new Set([KEY])) as Error & { code?: string };
    expect(m.message).not.toContain(KEY);
    expect([m.name, m.code]).toEqual(["KeyedFetchError", "redirect_refused"]);
    const c = maskError(new ContractError("refused", `no ${KEY}`, { call: "net.fetch" }), new Set([KEY]));
    expect(c).toBeInstanceOf(ContractError);
    expect((c as ContractError).code).toBe("refused");
    expect((c as ContractError).message).toBe(`no ${"*".repeat(KEY.length)}`);
  });

  test("the token sources' values are noted as they're handed out; a short value isn't looked for", async () => {
    const keys = new Set<string>();
    const src = noteKeys({ current: async () => ({ value: KEY, generation: 1 }), newer: async () => ({ value: "short", generation: 2 }) }, keys);
    await src.current();
    await src.newer(1);
    expect([...keys]).toEqual([KEY]);
    expect(maskText("short and sweet", ["short"])).toBe("short and sweet");
  });
});
