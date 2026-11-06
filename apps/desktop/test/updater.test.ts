// The app's updates (src/main/updater.ts): an update file is read only once its `.sig` verifies over exactly the
// bytes electron-updater parses, with a throwaway key; nothing here reaches the network.
import { describe, expect, test } from "bun:test";
import type { RequestOptions } from "node:http";
import { generateFeedKey, signFeed } from "@waifucave/clover-update-feed";
import { FeedRefused, feedFileOf, IDLE_POLL_MS, InstallGate, parseUpdateConfig, updatesItself, verifyingExecutor, VerifiedGitHubProvider, type InstallGateDeps } from "../src/main/updater";

const FEED = "version: 1.2.3\nfiles:\n  - url: Clover-1.2.3-mac.zip\n    sha512: abc\n    size: 10\npath: Clover-1.2.3-mac.zip\nsha512: abc\nreleaseDate: '2026-11-06T00:00:00.000Z'\n";

/** An executor answering from a table of paths (anything else is a 404), logging what was asked. */
function fakeExecutor(files: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    async request(options: RequestOptions, _token?: unknown): Promise<string> {
      const path = options.path ?? "";
      asked.push(path);
      if (!(path in files)) throw Object.assign(new Error(`404 ${path}`), { statusCode: 404 });
      return files[path]!;
    },
  };
}

describe("the app's updates", () => {
  test("an update file is known by its name; the release list and the download are not", () => {
    expect(feedFileOf("/waifucave/clover/releases/download/v1.2.3/latest-mac.yml")).toBe("latest-mac.yml");
    expect(feedFileOf("/waifucave/clover/releases/download/v1.2.3/beta-linux-arm64.yml?x=1")).toBe("beta-linux-arm64.yml");
    expect(feedFileOf("/waifucave/clover/releases/download/v1.2.3/latest.yml")).toBe("latest.yml");
    expect(feedFileOf("/waifucave/clover/releases.atom")).toBeUndefined();
    expect(feedFileOf("/waifucave/clover/releases/download/v1.2.3/Clover-1.2.3-mac.zip")).toBeUndefined();
    expect(feedFileOf("/x/latest-mac.yml.sig")).toBeUndefined();
    expect(feedFileOf(undefined)).toBeUndefined();
  });

  test("a signed update file reads; a changed one, one under another name or one without its .sig is refused", async () => {
    const key = generateFeedKey();
    const path = "/waifucave/clover/releases/download/v1.2.3/latest-mac.yml";
    const good = fakeExecutor({ [path]: FEED, [`${path}.sig`]: signFeed("latest-mac.yml", new TextEncoder().encode(FEED), key.privateKey) });
    const ex = verifyingExecutor(good, key.publicKey);
    expect(await ex.request({ path }, undefined)).toBe(FEED);
    expect(good.asked).toEqual([path, `${path}.sig`]);
    // Anything but an update file passes through untouched, with no .sig asked for.
    const other = fakeExecutor({ "/waifucave/clover/releases.atom": "<feed/>" });
    expect(await verifyingExecutor(other, key.publicKey).request({ path: "/waifucave/clover/releases.atom" }, undefined)).toBe("<feed/>");
    expect(other.asked).toEqual(["/waifucave/clover/releases.atom"]);

    const refused = async (files: Record<string, string>, publicKey: string | null = key.publicKey): Promise<string> => {
      try {
        await verifyingExecutor(fakeExecutor(files), publicKey).request({ path }, undefined);
        return "read";
      } catch (err) {
        expect(err).toBeInstanceOf(FeedRefused);
        return (err as FeedRefused).verdict.reason;
      }
    };
    expect(await refused({ [path]: `${FEED}# changed\n`, [`${path}.sig`]: signFeed("latest-mac.yml", new TextEncoder().encode(FEED), key.privateKey) })).toBe("bad signature");
    expect(await refused({ [path]: FEED, [`${path}.sig`]: signFeed("beta-mac.yml", new TextEncoder().encode(FEED), key.privateKey) })).toBe("bad signature");
    expect(await refused({ [path]: FEED, [`${path}.sig`]: signFeed("latest-mac.yml", new TextEncoder().encode(FEED), generateFeedKey().privateKey) })).toBe("bad signature");
    expect(await refused({ [path]: FEED })).toBe("no signature");
    // An app built before the key exists takes no update at all.
    expect(await refused({ [path]: FEED, [`${path}.sig`]: "x" }, null)).toBe("no key");
  });

  test("electron-updater's own GitHub provider reads its update file through the check", async () => {
    const key = generateFeedKey();
    const sig = signFeed("latest-mac.yml", new TextEncoder().encode(FEED), key.privateKey);
    const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><link rel="alternate" type="text/html" href="https://github.com/waifucave/clover/releases/tag/v1.2.3"/><title>v1.2.3</title><content>notes</content></entry></feed>';
    const release = "/waifucave/clover/releases/download/v1.2.3/latest-mac.yml";
    const make = (files: Record<string, string>) => {
      const ex = fakeExecutor({ "/waifucave/clover/releases.atom": atom, "/waifucave/clover/releases/latest": JSON.stringify({ tag_name: "v1.2.3" }), ...files });
      const provider = new VerifiedGitHubProvider(
        { provider: "github", owner: "waifucave", repo: "clover" } as never,
        { channel: null, allowPrerelease: false, currentVersion: "1.0.0", fullChangelog: false } as never,
        { executor: ex, platform: "darwin", isUseMultipleRangeRequest: false } as never,
      );
      // The check runs against the test's key, not the one the app carries.
      (provider as unknown as { executor: unknown }).executor = verifyingExecutor(ex, key.publicKey);
      return { ex, provider };
    };
    const ok = make({ [release]: FEED, [`${release}.sig`]: sig });
    expect((await ok.provider.getLatestVersion()).version).toBe("1.2.3");
    expect(ok.ex.asked).toContain(`${release}.sig`);
    const bad = make({ [release]: FEED.replace("abc", "abd"), [`${release}.sig`]: sig });
    await expect(bad.provider.getLatestVersion()).rejects.toThrow(/refused: bad signature/);
    // Built with the key the app carries, the provider checks with it.
    const carried = new VerifiedGitHubProvider({ provider: "github", owner: "waifucave", repo: "clover" } as never, { channel: null } as never, { executor: fakeExecutor({}), platform: "darwin" } as never);
    expect((carried as unknown as { executor: { request: unknown } }).executor.request).toBeFunction();
  });

  test("the publish settings come from app-update.yml; only a GitHub feed is taken", () => {
    expect(parseUpdateConfig("owner: waifucave\nrepo: clover\nprovider: github\nchannel: beta\nupdaterCacheDirName: clover-updater\n")).toEqual({ owner: "waifucave", repo: "clover", channel: "beta" });
    expect(parseUpdateConfig("owner: waifucave\nrepo: clover\nprovider: github\n")).toEqual({ owner: "waifucave", repo: "clover", channel: "latest" });
    expect(parseUpdateConfig("provider: generic\nurl: https://example.com\n")).toBeUndefined();
    expect(parseUpdateConfig("provider: github\nowner: waifucave\n")).toBeUndefined();
  });

  test("only a packaged app updates itself, and on Linux only the AppImage (apt and dnf update the rest)", () => {
    expect(updatesItself(false, "darwin", {})).toBe(false);
    expect(updatesItself(true, "darwin", {})).toBe(true);
    expect(updatesItself(true, "win32", {})).toBe(true);
    expect(updatesItself(true, "linux", {})).toBe(false);
    expect(updatesItself(true, "linux", { APPIMAGE: "/home/u/Clover.AppImage" })).toBe(true);
  });

  describe("the idle gate (InstallGate) against a fake daemon", () => {
    /** A fake daemon answering `update.status` and `update.apply` from its busy work, and a log of what the app did. */
    function harness(busy: string[] = []) {
      const daemon = { busy, up: true, prepared: 0 };
      const did: string[] = [];
      let tick: (() => void) | undefined;
      const deps: InstallGateDeps = {
        status: async () => (daemon.up ? { idle: daemon.busy.length === 0, busy: [...daemon.busy] } : undefined),
        apply: async () => {
          if (!daemon.up) return undefined;
          if (daemon.busy.length > 0) return "when-idle";
          daemon.prepared++;
          return "now";
        },
        exiting: async () => { did.push("pair.exiting{update}"); },
        stopApp: () => { did.push("stop the app"); },
        daemonGone: async () => { daemon.up = false; did.push("daemon gone"); },
        install: (relaunch) => { did.push(relaunch ? "install, then start" : "install"); },
        every: (ms, fn) => {
          expect(ms).toBe(IDLE_POLL_MS);
          tick = fn;
          return () => { tick = undefined; did.push("polling stopped"); };
        },
        log: () => {},
      };
      const gate = new InstallGate(deps);
      // One poll's worth: what `every` would run a minute later.
      const poll = async () => { tick?.(); await Bun.sleep(0); await Bun.sleep(0); };
      return { daemon, did, gate, poll, polling: () => tick !== undefined };
    }

    test("busy: the update waits, polling every minute; at the first idle moment it installs and starts again", async () => {
      const { daemon, did, gate, poll, polling } = harness(["turns:1"]);
      await gate.downloaded("1.3.0");
      expect(gate.ready).toBe("1.3.0");
      expect(did).toEqual([]);
      expect(polling()).toBe(true);
      daemon.busy = ["agents:2", "approvals:1"];
      await poll();
      expect(did).toEqual([]);
      daemon.busy = [];
      await poll();
      expect(daemon.prepared).toBe(1);
      expect(did).toEqual(["polling stopped", "pair.exiting{update}", "stop the app", "daemon gone", "install, then start"]);
      expect(polling()).toBe(false);
      // Installs once.
      await poll();
      await gate.check();
      expect(did.filter((d) => d.startsWith("install"))).toHaveLength(1);
    });

    test("idle when the download finishes: it installs at once", async () => {
      const { did, gate } = harness();
      await gate.downloaded("1.3.0");
      expect(did).toEqual(["polling stopped", "pair.exiting{update}", "stop the app", "daemon gone", "install, then start"]);
    });

    test("a turn that starts between the status and the apply keeps the update waiting", async () => {
      const { daemon, did, gate } = harness();
      const status = daemon.busy;
      // The status reads idle; by the apply, a turn has started.
      daemon.busy = status;
      const realStatus = gate["d" as never] as InstallGateDeps;
      const answerIdle = realStatus.status;
      realStatus.status = async () => { const s = await answerIdle(); daemon.busy = ["turns:1"]; return s; };
      await gate.downloaded("1.3.0");
      expect(did).toEqual([]);
      expect(daemon.prepared).toBe(0);
    });

    test("a daemon that can't be asked never gets an update installed over it", async () => {
      const { daemon, did, gate, poll } = harness();
      daemon.up = false;
      await gate.downloaded("1.3.0");
      await poll();
      expect(did).toEqual([]);
    });

    test("the user's Quit installs the update without starting the app again; with none, the Quit is as usual", async () => {
      const none = harness();
      expect(await none.gate.quitting()).toBe(false);
      expect(none.did).toEqual([]);
      const { did, gate } = harness(["turns:1"]);
      await gate.downloaded("1.3.0");
      expect(await gate.quitting()).toBe(true);
      // pair.quit already stopped the pair: no pair.exiting, and no second install.
      expect(did).toEqual(["polling stopped", "stop the app", "daemon gone", "install"]);
      expect(await gate.quitting()).toBe(false);
    });
  });
});
