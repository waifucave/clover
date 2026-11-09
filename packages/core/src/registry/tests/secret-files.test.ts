// A plugin's secret as a 0600 file (`${secretFile:<key>}`; the controller's ruling on #377): written to its own folder,
// read only through that plugin's fence, never another's, and gone when its server stops, its plugin is removed, or the
// daemon starts. Temp homes only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darwinDescribe } from "../../../test/helpers/darwin-only";
import { resolvedPluginStdioMcpServer } from "../../runtime-sdk/external-mcp";
import { fencedCommand, toolFence } from "../plugin-fence";
import { ensurePluginRunFiles } from "../plugin-run";
import { PluginSecretFiles, secretFilesFolder, secretFilesRoot } from "../secret-files";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("a secret's file", () => {
  test("is 0600 in a 0700 folder of its plugin's own, written whole, and gone when its server stops", () => {
    const home = temp("clover-sf-");
    const files = new PluginSecretFiles(home);
    const path = files.write("luna/tarot", "keyed", "LUNA_KEY", "sk-test-value");
    expect(path).toBe(join(secretFilesFolder(home, "luna"), "keyed", "LUNA_KEY"));
    expect(readFileSync(path, "utf8")).toBe("sk-test-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const d of [secretFilesRoot(home), secretFilesFolder(home, "luna"), join(secretFilesFolder(home, "luna"), "keyed")]) expect(statSync(d).mode & 0o777).toBe(0o700);
    // No half-written name left beside it.
    expect(readdirSync(join(secretFilesFolder(home, "luna"), "keyed"))).toEqual(["LUNA_KEY"]);
    // Written again (a restart): replaced whole.
    files.write("luna", "keyed", "LUNA_KEY", "sk-test-other");
    expect(readFileSync(path, "utf8")).toBe("sk-test-other");
    files.release("luna", "keyed");
    expect(existsSync(path)).toBe(false);
    // A server or key name can't leave the folder.
    expect(() => files.write("luna", "../other", "LUNA_KEY", "x")).toThrow("isn't a server name");
    expect(() => files.write("luna", "keyed", "../x", "x")).toThrow("isn't a secret's name");
  });

  test("its plugin removed, or the daemon started: none is left", () => {
    const home = temp("clover-sf-");
    const files = new PluginSecretFiles(home);
    const a = files.write("luna", "keyed", "LUNA_KEY", "x");
    const b = files.write("tarot", "cards", "TAROT_KEY", "y");
    files.releasePlugin("luna/child");
    expect([existsSync(a), existsSync(b)]).toEqual([false, true]);
    files.sweep();
    expect(existsSync(secretFilesRoot(home))).toBe(false);
  });

  test("a server's ${secretFile:k} becomes the file's path in its env and args; a missing secret starts nothing and leaves no file", () => {
    const home = temp("clover-sf-");
    const root = join(home, "plugins", "luna");
    mkdirSync(root, { recursive: true });
    const files = new PluginSecretFiles(home);
    const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: false as const };
    const values = { pluginId: "luna", server: "keyed", dataDir: join(home, "plugin-data", "luna"), setting: () => undefined, secret: (k: string) => (k === "LUNA_KEY" ? "sk-test-value" : undefined), secretFiles: files };
    const { config, release } = resolvedPluginStdioMcpServer(
      { command: "luna-mcp", args: ["--key-file", "${secretFile:LUNA_KEY}"], env: { LUNA_KEY_FILE: "${secretFile:LUNA_KEY}", MODE: "fast" } },
      root, guard, values,
    );
    const path = join(secretFilesFolder(home, "luna"), "keyed", "LUNA_KEY");
    const c = config as { args: string[]; env: Record<string, string> };
    expect(c.args).toEqual(["--key-file", path]);
    expect(c.env.LUNA_KEY_FILE).toBe(path);
    expect(JSON.stringify(config)).not.toContain("sk-test-value");
    expect(readFileSync(path, "utf8")).toBe("sk-test-value");
    release();
    expect(existsSync(path)).toBe(false);
    expect(() => resolvedPluginStdioMcpServer({ command: "luna-mcp", env: { A: "${secretFile:LUNA_KEY}", B: "${secretFile:MISSING}" } }, root, guard, values)).toThrow("secret MISSING is not set");
    expect(existsSync(join(secretFilesFolder(home, "luna"), "keyed"))).toBe(false);
  });
});

darwinDescribe("a secret's file under the fence", () => {
  test("its plugin's hook or server reads it and can't write it; another plugin's can't read it", () => {
    const home = temp("clover-sf-");
    const userHome = temp("clover-sf-user-");
    const files = ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home });
    const path = new PluginSecretFiles(home).write("luna", "keyed", "LUNA_KEY", "sk-test-value");
    const run = (pluginId: string, script: string) => {
      const root = join(home, "plugins", pluginId);
      mkdirSync(root, { recursive: true });
      const { fence } = toolFence({ files, shared: [], pluginRoot: root, pluginId, userHome, name: `test-${pluginId}` });
      const r = Bun.spawnSync(fencedCommand(["/bin/sh", "-c", script], fence), { stdout: "pipe", stderr: "pipe" });
      return r.stdout.toString().trim();
    };
    const q = JSON.stringify(path);
    const probe = `cat ${q} >/dev/null 2>&1 && echo read=ok || echo read=denied; (echo x > ${q}) 2>/dev/null && echo write=ok || echo write=denied`;
    expect(run("luna", probe)).toBe("read=ok\nwrite=denied");
    expect(run("tarot", probe)).toBe("read=denied\nwrite=denied");
    expect(readFileSync(path, "utf8")).toBe("sk-test-value");
  });
});
