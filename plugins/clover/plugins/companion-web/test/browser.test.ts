// The web companion in a real browser: headless Chrome loads the built page (services/web), pairs with this plugin's
// WebLinkHost through the handshake Worker on wrangler's local runtime, connects over WebRTC with its own addresses
// hidden behind mDNS names as on a real page, lists the bots and sends a message.
//
// It starts a browser, so it runs only in CI (as spike S1's browser lab does): never on someone's screen. Driven over
// the DevTools protocol; every key is made for the run, in memory; the only network is 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup } from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";

import { HandshakeClient } from "@waifucave/clover-service-handshake/client";
import { harnessReady, type HandshakeHarness, startHandshake } from "@waifucave/clover-service-handshake/harness";
import type { RtcEnvironment, RtcLink } from "@waifucave/clover-service-web/protocol";

import { MemoryPairStore } from "../src/contracts";
import { WebLinkHost } from "../src/web-host";

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((p): p is string => typeof p === "string" && existsSync(p)) ?? null;
}

const chrome = findChrome();
const enabled = process.env.CI === "true" && chrome !== null && harnessReady();

const webDir = join(dirname(fileURLToPath(import.meta.resolve("@waifucave/clover-service-web/protocol"))), "..");

/** A minimal DevTools protocol client on one page target. */
class Page {
  private next = 1;
  private readonly waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== undefined) this.waiting.get(message.id)?.(message);
    });
  }

  static async attach(port: number): Promise<Page> {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((t) => t.type === "page")!;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    return new Page(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (message) => {
        this.waiting.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value: T } };
    return result.result.value;
  }

  async until<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate<T>(expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}\npage: ${await this.evaluate<string>("document.body.innerText")}`);
      await Bun.sleep(100);
    }
  }

  close(): void {
    this.ws.close();
  }
}

let harness: HandshakeHarness;
let pageServer: ReturnType<typeof Bun.serve>;
let dist: string;
let profile: string;
let browser: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  if (!enabled) return;
  dist = mkdtempSync(join(tmpdir(), "clover-web-dist-"));
  const build = Bun.spawnSync([process.execPath, join(webDir, "scripts/build.ts"), "--out", dist], { stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("the page didn't build");
  const workerPath = join(webDir, "src/worker.ts");
  const pageWorker = ((await import(workerPath)) as { default: { fetch(r: Request, env: Record<string, unknown>): Promise<Response> } }).default;
  const assets = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const file = join(dist, path === "/" ? "index.html" : path.slice(1));
      if (!file.startsWith(dist) || !existsSync(file)) return new Response("not found", { status: 404 });
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      return new Response(readFileSync(file), { headers: { "content-type": type } });
    },
  };
  let handshakeOrigin = "";
  pageServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => pageWorker.fetch(request, { ASSETS: assets, HANDSHAKE_ORIGIN: handshakeOrigin }),
  });
  harness = await startHandshake({ webOrigins: pageServer.url.origin });
  handshakeOrigin = harness.url;
}, 120_000);

afterAll(async () => {
  browser?.kill();
  await browser?.exited;
  pageServer?.stop(true);
  await harness?.stop();
  cleanup();
  for (const dir of [dist, profile]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("the web companion in headless Chrome", () => {
  test("pairs, connects over WebRTC, lists the bots and sends a message", async () => {
    const rtc: RtcEnvironment = {
      createPeerConnection: (config) => new RTCPeerConnection(config) as unknown as ReturnType<RtcEnvironment["createPeerConnection"]>,
      iceServers: [],
    };
    const sent: string[] = [];
    let attached = false;
    let page: Page | null = null;
    const host = new WebLinkHost({
      client: new HandshakeClient({ origin: harness.url }),
      webOrigin: pageServer.url.origin,
      inviteHandshake: harness.url,
      computerName: "Studio",
      rtc,
      store: new MemoryPairStore(),
      registry: { add: async (d) => d, watch: () => () => undefined },
      // The person compares the words: the page must show the same four.
      confirm: async ({ words }) => {
        const shown = await page!.until<string[] | null>("(() => { const w = [...document.querySelectorAll('.words span')].map((s) => s.textContent); return w.length === 4 ? w : null; })()");
        return { confirmed: JSON.stringify(shown) === JSON.stringify(words), card: "card-1" };
      },
      adopt: (link: RtcLink) => {
        link.handle("bot.list", () => ({ bots: [{ id: "alpha", name: "Alpha", mainSession: "s_alpha", state: "idle" }] }));
        link.handle("session.history", () => ({ events: [{ type: "assistant_message", sessionId: "s_alpha", text: "Hello from Alpha" }], hasMore: false }));
        link.handle("session.attach", () => {
          attached = true;
          return { lastSeq: 1 };
        });
        link.handle("session.send", (params) => {
          const text = (params as { message: { text: string } }).message.text;
          sent.push(text);
          link.notify("event", { type: "user_message", sessionId: "s_alpha", text });
          return { seq: 2 };
        });
      },
    });
    await host.start();
    const url = await host.createInvite({ code: "271828", expiresAt: Date.now() + 10 * 60_000 });

    profile = mkdtempSync(join(tmpdir(), "clover-web-chrome-"));
    browser = Bun.spawn(
      [
        chrome!,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    // A cold Chrome on a Windows runner can take well over 20 s to start listening.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 900 && !existsSync(portFile); i++) {
      if (browser.exitCode !== null) throw new Error(`Chrome exited with ${browser.exitCode} before it was listening`);
      await Bun.sleep(100);
    }
    if (!existsSync(portFile)) throw new Error("Chrome didn't start listening within 90 s");
    page = await Page.attach(Number(readFileSync(portFile, "utf8").split("\n")[0]));
    await page.send("Page.enable");
    await page.send("Page.navigate", { url });

    await page.until("[...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Pair with Studio'))");
    // The invite's secret has left the address bar.
    expect(await page.evaluate<string>("location.hash")).toBe("");
    await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Pair with Studio')).click()");
    await page.until("document.getElementById('status').textContent === 'Connected to Studio'", 60_000);
    await page.until("[...document.querySelectorAll('button')].some((b) => b.textContent === 'Open')");
    await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Open').click()");
    await page.until("document.body.innerText.includes('Hello from Alpha')");
    for (let i = 0; i < 300 && !attached; i++) await Bun.sleep(100);
    expect(attached).toBe(true);
    await page.evaluate("document.querySelector('textarea').value = 'hi from chrome'; document.querySelector('form.composer').requestSubmit()");
    await page.until("[...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes('hi from chrome'))");
    expect(sent).toEqual(["hi from chrome"]);
    expect(host.links().size).toBe(1);

    // A reload connects again from what IndexedDB kept, with no new pairing.
    await page.send("Page.reload");
    await page.until("document.getElementById('status').textContent === 'Connected to Studio'", 60_000);
    page.close();
    host.stop();
  }, 240_000);
});
