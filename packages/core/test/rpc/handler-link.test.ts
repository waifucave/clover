// `handler`'s `link` option: a method of the plugin-host link keeps the contract's error, its `detail` included (the
// keyed fetch's own code rides there), where the public RPC's mapping gives a JSON-RPC code and drops the detail.
import { describe, expect, test } from "bun:test";
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { ContractError } from "../../src/contracts/common";
import { errorToWire } from "../../src/plugin-host/link";
import { handler, MethodError } from "../../src/rpc/handler";

const CORE = { caller: { kind: "core" } } as never;
const spec = PLUGINS_METHODS.pluginHostFetchCancel;
const failing = () => {
  throw new ContractError("failed", "the host refused", { fetch: "host_not_declared" });
};

describe("handler's link option", () => {
  test("a link method's failure crosses as the contract's error with its detail; the public mapping drops it", async () => {
    const link = await handler(spec, failing, { link: true })({ pluginId: "luna", fetchId: "f" }, CORE).catch((e: unknown) => e);
    expect(link).toBeInstanceOf(ContractError);
    expect(errorToWire(link)).toMatchObject({ code: "failed", detail: { fetch: "host_not_declared" } });
    const rpc = await handler(spec, failing)({ pluginId: "luna", fetchId: "f" }, CORE).catch((e: unknown) => e);
    expect(rpc).toBeInstanceOf(MethodError);
    expect(errorToWire(rpc)).not.toHaveProperty("detail");
  });

  test("bad params on a link method are the contract's `invalid`, naming the field", async () => {
    const err = await handler(spec, () => ({ ok: true as const }), { link: true })({ pluginId: 7 }, CORE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe("invalid");
    expect((err as Error).message).toContain("pluginHost.fetchCancel: pluginId");
  });
});
