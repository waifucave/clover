// The streamed view for other devices in a real Electron (spec §12.1 "From another device", lane L-M2): a bot's
// offscreen tab encoded with WebCodecs in the browser's own hidden page, decoded by a viewer with `VideoDecoder`; the
// codec each OS picks, keyframes and bitrate on request, a still page, stop and close, and no window on screen. CI
// ONLY, like the browser test: it needs both CI=true and CLOVER_UI_TESTS=1, which only the app job in
// .github/workflows/ci.yml sets (under xvfb on Linux). `test/browser/stream-fixture-main.ts` does the driving; this
// file builds it, runs it and reads its answers.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_ASSETS } from "../src/main/browser/assets";

const root = join(import.meta.dir, "..");
const enabled = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";

interface Step { name: string; ok: boolean; detail: unknown; ms: number }
interface Result { platform: string; electron: string; steps: Step[]; summary: Record<string, unknown>; fatal?: string }

/** The other device's viewer: decodes a run of chunks from a keyframe and reads the last picture's colours. */
const VIEWER = `<!doctype html><html><head><meta charset="utf-8"><title>Stream viewer</title></head><body><script>
window.decodeRun = async (cfg, run, points) => {
  const errors = [];
  let decoded = 0, width = 0, height = 0;
  const canvas = new OffscreenCanvas(cfg.width, cfg.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const draw = (img, w, h) => { decoded++; width = w; height = h; if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } ctx.drawImage(img, 0, 0); };
  if (cfg.codec === "jpeg") {
    for (const f of run) { const bmp = await createImageBitmap(new Blob([bytes(f.b64)], { type: "image/jpeg" })); draw(bmp, bmp.width, bmp.height); bmp.close(); }
  } else {
    const support = await VideoDecoder.isConfigSupported({ codec: cfg.codecString, codedWidth: cfg.width, codedHeight: cfg.height });
    if (!support.supported) return { decoded: 0, width: 0, height: 0, colours: [], error: "no decoder here for " + cfg.codecString };
    const dec = new VideoDecoder({ output: (fr) => { draw(fr, fr.displayWidth, fr.displayHeight); fr.close(); }, error: (e) => errors.push(String(e)) });
    dec.configure({ codec: cfg.codecString, codedWidth: cfg.width, codedHeight: cfg.height, optimizeForLatency: true });
    for (const f of run) dec.decode(new EncodedVideoChunk({ type: f.key ? "key" : "delta", timestamp: f.ts, data: bytes(f.b64) }));
    try { await dec.flush(); } catch (e) { errors.push(String(e)); }
    dec.close();
  }
  const colours = points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  return errors.length > 0 ? { decoded, width, height, colours, error: errors.join("; ") } : { decoded, width, height, colours };
};
</script></body></html>`;

async function bundle(entry: string, dir: string, name: string, format: "esm" | "cjs"): Promise<string> {
  const r = await Bun.build({ entrypoints: [entry], outdir: dir, target: "node", format, external: ["electron"], naming: name, ...{ macros: false } });
  if (!r.success) throw new Error(r.logs.map(String).join("\n"));
  return join(dir, name);
}

describe.if(enabled)("the streamed view in Electron (CI only)", () => {
  test("every step of the stream fixture passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-browser-stream-test-"));
    const main = await bundle(join(import.meta.dir, "browser", "stream-fixture-main.ts"), dir, "stream-fixture-main.mjs", "esm");
    const preload = await bundle(join(root, BROWSER_ASSETS.preload.entry), dir, "viewport-preload.cjs", "cjs");
    const streamPreload = await bundle(join(root, BROWSER_ASSETS.streamPreload.entry), dir, "browser-stream-preload.cjs", "cjs");
    const html = join(dir, "browser-viewport.html");
    copyFileSync(join(root, BROWSER_ASSETS.html.from), html);
    const streamHtml = join(dir, "browser-stream.html");
    copyFileSync(join(root, BROWSER_ASSETS.streamHtml.from), streamHtml);
    const viewer = join(dir, "stream-viewer.html");
    writeFileSync(viewer, VIEWER);
    const out = join(dir, "result.json");
    const electron = createRequire(join(root, "package.json"))("electron") as string;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOVER_BROWSER_TEST_OUT: out,
      CLOVER_BROWSER_TEST_PRELOAD: preload,
      CLOVER_BROWSER_TEST_HTML: html,
      CLOVER_STREAM_TEST_PRELOAD: streamPreload,
      CLOVER_STREAM_TEST_HTML: streamHtml,
      CLOVER_STREAM_TEST_VIEWER: viewer,
      ELECTRON_ENABLE_LOGGING: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [`--user-data-dir=${join(dir, "user-data")}`, "--no-proxy-server", ...(process.env.CLOVER_BROWSER_TEST_ARGS ?? "").split(/\s+/).filter((a) => a !== ""), main], { env, encoding: "utf8", timeout: 300_000 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
    expect(existsSync(out), output.slice(-4000)).toBe(true);
    const result = JSON.parse(readFileSync(out, "utf8")) as Result;
    console.log(JSON.stringify(result, null, 2));
    console.log(`stream summary (${result.platform}): ${JSON.stringify(result.summary)}`);
    expect(result.fatal).toBeUndefined();
    const failed = result.steps.filter((s) => !s.ok);
    expect(failed, `${JSON.stringify(failed, null, 2)}\n--- electron's output, last 3000 characters ---\n${output.slice(-3000)}`).toEqual([]);
    expect(result.steps.length).toBeGreaterThanOrEqual(14);
  }, 360_000);
});
