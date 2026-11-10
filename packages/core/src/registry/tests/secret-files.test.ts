// A plugin's secret as a 0600 file (`${secretFile:<key>}`; the controller's ruling on #377): written to its own folder,
// read only through that plugin's fence, never another's, and gone when its server stops, its plugin is removed, or the
// daemon starts. Temp homes only.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("is 0600 in a 0700 folder of its plugin's own, written whole, and gone when its instance stops", () => {
    const home = temp("clover-sf-");
    const files = new PluginSecretFiles(home);
    const one = PluginSecretFiles.instance();
    const path = files.write("luna/tarot", "keyed", "LUNA_KEY", "sk-test-value", one);
    const folder = join(secretFilesFolder(home, "luna"), "keyed", one);
    expect(path).toBe(join(folder, "LUNA_KEY"));
    expect(readFileSync(path, "utf8")).toBe("sk-test-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const d of [secretFilesRoot(home), secretFilesFolder(home, "luna"), join(secretFilesFolder(home, "luna"), "keyed"), folder]) expect(statSync(d).mode & 0o777).toBe(0o700);
    // No half-written name left beside it.
    expect(readdirSync(folder)).toEqual(["LUNA_KEY"]);
    // Written again (a restart): replaced whole.
    files.write("luna", "keyed", "LUNA_KEY", "sk-test-other", one);
    expect(readFileSync(path, "utf8")).toBe("sk-test-other");
    // A second running instance of the same server keeps its keys when the first stops (#402's review).
    const two = PluginSecretFiles.instance();
    const other = files.write("luna", "keyed", "LUNA_KEY", "sk-test-two", two);
    files.release("luna", "keyed", one);
    expect([existsSync(path), readFileSync(other, "utf8")]).toEqual([false, "sk-test-two"]);
    // A server, key or instance name can't leave the folder.
    expect(() => files.write("luna", "../other", "LUNA_KEY", "x", one)).toThrow("isn't a server name");
    expect(() => files.write("luna", "keyed", "../x", "x", one)).toThrow("isn't a secret's name");
    expect(() => files.write("luna", "keyed", "LUNA_KEY", "x", "../x")).toThrow("isn't an instance id");
  });

  test("a folder on the way that's a link or a file is refused, never written through; one there already is made 0700", () => {
    const home = temp("clover-sf-");
    const elsewhere = temp("clover-sf-elsewhere-");
    const files = new PluginSecretFiles(home);
    mkdirSync(secretFilesRoot(home), { recursive: true });
    // A same-user process pre-plants a link where the plugin's folder goes.
    symlinkSync(elsewhere, secretFilesFolder(home, "luna"));
    expect(() => files.write("luna", "keyed", "LUNA_KEY", "x", PluginSecretFiles.instance())).toThrow("isn't a folder of Clover's");
    expect(readdirSync(elsewhere)).toEqual([]);
    // A file where a server's folder goes.
    mkdirSync(secretFilesFolder(home, "tarot"), { mode: 0o755 });
    writeFileSync(join(secretFilesFolder(home, "tarot"), "cards"), "");
    expect(() => files.write("tarot", "cards", "TAROT_KEY", "x", PluginSecretFiles.instance())).toThrow("isn't a folder of Clover's");
    // A folder there already, too open: made 0700.
    chmodSync(secretFilesRoot(home), 0o755);
    files.write("tarot", "deck", "TAROT_KEY", "x", PluginSecretFiles.instance());
    for (const d of [secretFilesRoot(home), secretFilesFolder(home, "tarot")]) expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  test("a release that removes the shared server folder mid-write: the write makes its folders again once and lands", () => {
    const home = temp("clover-sf-");
    const first = PluginSecretFiles.instance();
    const second = PluginSecretFiles.instance();
    let races = 0;
    const files: PluginSecretFiles = new PluginSecretFiles(home, {
      // Once, while the second instance writes: the first instance's release takes the server folder with it.
      beforeWrite: () => {
        if (races++ !== 1) return;
        files.release("luna", "keyed", first);
        rmSync(join(secretFilesFolder(home, "luna"), "keyed"), { recursive: true, force: true });
      },
    });
    files.write("luna", "keyed", "LUNA_KEY", "x", first);
    const path = files.write("luna", "keyed", "LUNA_KEY", "y", second);
    expect(races).toBe(3);
    expect(readFileSync(path, "utf8")).toBe("y");
  });

  test("its plugin removed, or the daemon started: none is left", () => {
    const home = temp("clover-sf-");
    const files = new PluginSecretFiles(home);
    const a = files.write("luna", "keyed", "LUNA_KEY", "x", PluginSecretFiles.instance());
    const b = files.write("tarot", "cards", "TAROT_KEY", "y", PluginSecretFiles.instance());
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
    const c = config as { args: string[]; env: Record<string, string> };
    const path = c.env.LUNA_KEY_FILE!;
    expect(path.startsWith(join(secretFilesFolder(home, "luna"), "keyed") + "/")).toBe(true);
    expect(c.args).toEqual(["--key-file", path]);
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
    const path = new PluginSecretFiles(home).write("luna", "keyed", "LUNA_KEY", "sk-test-value", PluginSecretFiles.instance());
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
