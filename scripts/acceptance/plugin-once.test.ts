import { expect, test } from "bun:test";
import { pluginOnce, type PluginRpc } from "./plugin-once";

function fakeRpc(installed: Set<string>): PluginRpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push(method);
      if (method === "plugin.get") {
        const id = (params as { id: string }).id;
        if (!installed.has(id)) throw new Error(`no plugin ${id}`);
        return { plugin: { id, state: "running" } } as T;
      }
      if (method === "plugin.install") {
        if (installed.has("acceptance-echo")) throw new Error("acceptance-echo is already installed; remove it first to install this folder (-32600)");
        installed.add("acceptance-echo");
        return { id: "acceptance-echo" } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("already installed by an earlier row: used as it is, no second install", async () => {
  const rpc = fakeRpc(new Set(["acceptance-echo"]));
  expect(await pluginOnce(rpc, "acceptance-echo", "/fixtures/acceptance-echo")).toEqual({ id: "acceptance-echo", installedHere: false });
  expect(rpc.calls).toEqual(["plugin.get"]);
});

test("not installed (the row alone, a fresh home): installed from its folder", async () => {
  const rpc = fakeRpc(new Set());
  expect(await pluginOnce(rpc, "acceptance-echo", "/fixtures/acceptance-echo")).toEqual({ id: "acceptance-echo", installedHere: true });
  expect(rpc.calls).toEqual(["plugin.get", "plugin.install"]);
});
