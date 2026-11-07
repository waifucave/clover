import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// K-M1's question: can a client reach the daemon's socket from inside a sandbox that hides the run
// folder? Measured on macOS's Seatbelt: a file rule hides the folder's listing but not a connect to the
// socket in it; only a network rule stops that. So an agent's own sandbox that hides `<home>/run` still
// lets a bridge inside it connect (and C-M2's fence must deny the socket with a network rule, beside
// hiding the folder). The caller check marks such a client fenced either way.

const mac = process.platform === "darwin";

describe.skipIf(!mac)("a Unix socket in a hidden folder, from inside Seatbelt", () => {
  let home = "";
  let server: { stop(force?: boolean): void } | undefined;
  afterEach(() => { server?.stop(true); server = undefined; if (home) rmSync(home, { recursive: true, force: true }); });

  async function underProfile(profile: string, code: string): Promise<string> {
    const p = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  }

  test("a file rule hides the folder but not the socket; a network rule stops the connect", async () => {
    // Short names: the real path of the test's temp root is long, and a socket path has 104 bytes.
    home = realpathSync(mkdtempSync(join(tmpdir(), "r-")));
    const run = join(home, "run");
    mkdirSync(run, { mode: 0o700 });
    const sock = join(run, "s");
    server = Bun.listen({ unix: sock, socket: { data(s) { s.write("pong\n"); } } });
    const connect = `Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data(_s, d) { console.log("reached " + new TextDecoder().decode(d).trim()); process.exit(0); } } })
      .then((s) => s.write("ping\\n"), (e) => { console.log("refused " + (e.code ?? e.message)); process.exit(0); }); setTimeout(() => { console.log("timeout"); process.exit(0); }, 3000);`;
    const list = `try { require("node:fs").readdirSync(${JSON.stringify(run)}); console.log("listed"); } catch (e) { console.log(e.code); }`;
    const hideRun = `(version 1)(allow default)(deny file-read* file-write* (subpath "${run}"))`;
    expect(await underProfile(hideRun, list)).toBe("EPERM");
    expect(await underProfile(hideRun, connect)).toBe("reached pong");
    const noNetwork = `(version 1)(allow default)(deny file-read* file-write* (subpath "${run}"))(deny network-outbound)`;
    expect(await underProfile(noNetwork, connect)).toMatch(/^refused/);
    const onlyThatSocket = `(version 1)(allow default)(deny network*)(allow network-outbound (remote unix-socket (path-literal "${sock}")))`;
    expect(await underProfile(onlyThatSocket, connect)).toBe("reached pong");
  }, 20_000);
});
