// Lane M: the plugin host's bundles a compiled core embeds (bundles.ts). The compiled proof is
// `scripts/verify-fd-receiver-compiled.ts` step 3e (a real compiled core starts a host process from them); these pin the
// reader and the refusal without a compile.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_BUNDLE_FILES, loadEmbeddedHostBundles, prebuiltHostBundles, writeHostBundles, type EmbeddedBundleFile } from "../bundles";

const file = (name: string, text: string | Uint8Array): EmbeddedBundleFile => ({
  name,
  bytes: async () => (typeof text === "string" ? new TextEncoder().encode(text) : text),
});

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "clover-host-bundles-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the embedded plugin-host bundles", () => {
  test("found by Bun's hashed names, beside other embedded files", async () => {
    const got = await loadEmbeddedHostBundles([
      file("clover-bundled-plugins-abc123.manifest", "{}"),
      file("clover-plugin-host-nn3p2648.bundle", "host();"),
      file("clover-plugin-worker-x9.bundle", "worker();"),
    ]);
    expect(got).toEqual({ host: "host();", worker: "worker();" });
    // The unhashed names too (the build's own file names).
    expect(await loadEmbeddedHostBundles([file(HOST_BUNDLE_FILES.host, "h"), file(HOST_BUNDLE_FILES.worker, "w")])).toEqual({ host: "h", worker: "w" });
  });

  test("none embedded is undefined (from source, or a core built without them)", async () => {
    expect(await loadEmbeddedHostBundles([])).toBeUndefined();
    expect(await loadEmbeddedHostBundles([file("clover-bundled-plugins.manifest", "{}"), file("clover-plugin-host.bundle.js", "x")])).toBeUndefined();
  });

  test("one without the other, two of either, an empty one or one that isn't UTF-8 throws", async () => {
    await expect(loadEmbeddedHostBundles([file("clover-plugin-host-a.bundle", "h")])).rejects.toThrow("0 clover-plugin-worker.bundle files, not one");
    await expect(loadEmbeddedHostBundles([file("clover-plugin-worker-a.bundle", "w")])).rejects.toThrow("0 clover-plugin-host.bundle files, not one");
    await expect(loadEmbeddedHostBundles([file("clover-plugin-host-a.bundle", "h"), file("clover-plugin-host-b.bundle", "h"), file("clover-plugin-worker-a.bundle", "w")])).rejects.toThrow("2 clover-plugin-host.bundle files");
    await expect(loadEmbeddedHostBundles([file("clover-plugin-host-a.bundle", ""), file("clover-plugin-worker-a.bundle", "w")])).rejects.toThrow("is empty");
    await expect(loadEmbeddedHostBundles([file("clover-plugin-host-a.bundle", new Uint8Array([0xff, 0xfe])), file("clover-plugin-worker-a.bundle", "w")])).rejects.toThrow();
  });

  test("from source nothing is prebuilt", () => {
    expect(prebuiltHostBundles()).toBeUndefined();
  });
});

describe("writeHostBundles", () => {
  test("writes the prebuilt texts when the core carries them, private, and rewrites only on a change", async () => {
    const dir = join(scratch(), "run", "plugin-host");
    const out = await writeHostBundles(dir, { compiled: true, prebuilt: async () => ({ host: "host();\n", worker: "worker();\n" }) });
    expect(readFileSync(out.host, "utf8")).toBe("host();\n");
    expect(readFileSync(out.worker, "utf8")).toBe("worker();\n");
    expect(statSync(out.host).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A same-text write leaves the file alone; a changed one is replaced.
    writeFileSync(out.worker, "stale");
    const before = statSync(out.host).mtimeMs;
    await writeHostBundles(dir, { compiled: true, prebuilt: async () => ({ host: "host();\n", worker: "worker();\n" }) });
    expect(statSync(out.host).mtimeMs).toBe(before);
    expect(readFileSync(out.worker, "utf8")).toBe("worker();\n");
  });

  test("a compiled core without them refuses, never trying to build from sources it doesn't have", async () => {
    const dir = join(scratch(), "plugin-host");
    await expect(writeHostBundles(dir, { compiled: true, prebuilt: async () => undefined })).rejects.toThrow("built without the plugin host's bundles");
  });

  test("from source they're built from HOST_BUNDLE_ENTRIES", async () => {
    const dir = join(scratch(), "plugin-host");
    const out = await writeHostBundles(dir, { compiled: false, prebuilt: async () => undefined });
    expect(readFileSync(out.host, "utf8")).toContain("pluginHost.ping");
    expect(readFileSync(out.worker, "utf8").length).toBeGreaterThan(0);
  });
});
