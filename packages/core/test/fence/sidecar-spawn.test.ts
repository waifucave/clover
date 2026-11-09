// C-M3 item 4: the link sidecar under the fence. The profile and arguments; on macOS, what the profile refuses
// (reads of a hidden folder, any write) with ordinary programs; and two real sidecars, fenced, linked on loopback.
// The live part runs when the sidecar is built (`CLOVER_LINK_BIN`, or native/link's release build).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fencedSidecarSpawn, sidecarBwrapArgs, sidecarSeatbeltProfile, SidecarFenceUnavailable, SANDBOX_EXEC } from "../../src/fence/sidecar-spawn";
import { SidecarWire } from "../../src/links/sidecar-wire";
import { startReducedSidecar, windowsCommandLine, windowsEnvBlock } from "../../src/fence/windows-sidecar";
import { CloverLinkTransport } from "../../src/links/transport";
import { FileDeviceRegistry } from "../../src/devices/registry";
import { DeviceKey } from "../../src/identity/device-key";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { SystemClock } from "../../src/clock/system-clock";
import { darwinDescribe, onDarwin } from "../helpers/darwin-only";

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../../native/link/target/release/clover-link");
const built = existsSync(BIN);
const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

describe("the sidecar's fence: profile and arguments", () => {
  test("macOS: deny by default, only its own binary runs, the hidden folders last but the binary after them", () => {
    const p = sidecarSeatbeltProfile("/Applications/Clover.app/Contents/Resources/daemon/clover-link", ["/Users/someone"]);
    expect(p).toContain("(deny default)");
    expect(p).not.toContain("(allow network*)"); // IP only: no Unix socket on the disk
    for (const rule of ["(allow network-outbound (remote ip))", '(allow network-bind (local udp "*:*"))', '(allow network-inbound (local udp "*:*"))']) expect(p).toContain(rule);
    expect(p).not.toMatch(/\(allow file-read-metadata\)/); // scoped, not everywhere
    expect(p).toContain('(literal "/Applications/Clover.app/Contents/Resources/daemon")'); // the steps of its own path
    expect(p).not.toMatch(/allow file-write\* /);
    const deny = p.indexOf('(deny file-read* file-write* (subpath "/Users/someone"))');
    const exec = p.indexOf('(allow process-exec (literal "/Applications/Clover.app/Contents/Resources/daemon/clover-link"))');
    expect(deny).toBeGreaterThan(0);
    expect(exec).toBeGreaterThan(deny);
    expect(sidecarSeatbeltProfile('/a "b"\\c', [])).toContain('(literal "/a \\"b\\"\\\\c")');
  });

  test("Linux: the root read-only, every home and the session's sockets empty, its own namespaces", () => {
    const args = sidecarBwrapArgs("/srv/me", "/data/clover/bin/clover-link", () => true, { cloverHome: "/data/clover", seccompFd: 3, disableUserns: true });
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    for (const p of ["/home", "/root", "/run/user", "/media", "/run/media", "/mnt", "/srv/me", "/data/clover", "/tmp"]) expect(args.join(" ")).toContain(`--tmpfs ${p}`);
    expect(args.join(" ")).toContain("--seccomp 3");
    expect(args.join(" ")).toContain("--unshare-user --disable-userns");
    expect(sidecarBwrapArgs("/srv/me", "/x", () => true)).not.toContain("--disable-userns");
    for (const f of ["--unshare-pid", "--unshare-ipc", "--cap-drop", "--new-session", "--die-with-parent"]) expect(args).toContain(f);
    expect(args).not.toContain("--unshare-net");
    // The binary bound back in after the tmpfs mounts that would hide it.
    const bind = args.lastIndexOf("--ro-bind");
    expect(args.slice(bind, bind + 3)).toEqual(["--ro-bind", "/data/clover/bin/clover-link", "/data/clover/bin/clover-link"]);
    expect(bind).toBeGreaterThan(args.lastIndexOf("--tmpfs"));
    expect(sidecarBwrapArgs("/home/me", "/opt/clover-link", (p) => p === "/home" || p === "/home/me").filter((a) => a === "--tmpfs")).toHaveLength(3);
  });

  test("the wrapper each OS gets; no bwrap on Linux: not started, never unfenced", () => {
    const seen: string[][] = [];
    const spawn = (argv: readonly string[]) => { seen.push([...argv]); return {} as never; };
    fencedSidecarSpawn({ platform: "linux", bwrapPaths: [process.execPath], userHome: "/home/me", spawn })([process.execPath]);
    expect(seen[0]![0]).toBe(process.execPath);
    expect(seen[0]!.slice(-2)).toEqual(["--", realpathSync(process.execPath)]);
    expect(() => fencedSidecarSpawn({ platform: "linux", bwrapPaths: ["/nonexistent/bwrap"], spawn })(["/x"])).toThrow(SidecarFenceUnavailable);
    expect(() => fencedSidecarSpawn({ platform: "linux", bwrapPaths: [process.execPath], spawn })(["/nonexistent/clover-link"])).toThrow(SidecarFenceUnavailable);
    fencedSidecarSpawn({ platform: "win32", spawn })(["C:\\Clover\\clover-link.exe"]);
    expect(seen[1]).toEqual(["C:\\Clover\\clover-link.exe"]);
    fencedSidecarSpawn({ platform: "darwin", userHome: "/Users/someone", cloverHome: "/Volumes/Data/clover", spawn })([process.execPath]);
    expect(seen[2]!.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"]);
    expect(seen[2]![2]).toContain('(deny file-read* file-write* (subpath "/Volumes/Data/clover"))');
    expect(seen[2]!.at(-1)).toBe(realpathSync(process.execPath));
    expect(() => fencedSidecarSpawn({ platform: "darwin", spawn })(["/nonexistent/clover-link"])).toThrow(SidecarFenceUnavailable);
  });
});

darwinDescribe("the sidecar's Seatbelt profile, live", () => {
  test("a hidden folder can't be read or listed, nothing can be written, the system's files can be read", () => {
    const hidden = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-hidden-")));
    writeFileSync(join(hidden, "secret.txt"), "x");
    const run = (bin: string, args: string[]) => Bun.spawnSync([SANDBOX_EXEC, "-p", sidecarSeatbeltProfile(bin, [hidden]), bin, ...args]).exitCode;
    expect(run("/bin/cat", [join(hidden, "secret.txt")])).not.toBe(0);
    expect(run("/bin/ls", [hidden])).not.toBe(0);
    expect(run("/usr/bin/touch", [join(realpathSync(tmpdir()), `clover-c-touch-${process.pid}`)])).not.toBe(0);
    expect(existsSync(join(realpathSync(tmpdir()), `clover-c-touch-${process.pid}`))).toBe(false);
    expect(run("/bin/cat", ["/etc/hosts"])).toBe(0);
  });

  test("no Unix socket: a listener on the disk can't be reached, while TCP to a local address can", async () => {
    const { createServer } = await import("node:net");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-uds-")));
    const sock = join(dir, "s.sock");
    const uds = createServer((c) => { c.on("error", () => {}); c.end("x"); }).listen(sock);
    const tcp = createServer((c) => { c.on("error", () => {}); c.end("x"); }).listen(0, "127.0.0.1");
    await Promise.all([new Promise((r) => uds.once("listening", r)), new Promise((r) => tcp.once("listening", r))]);
    try {
      const nc = (args: string[], fenced: boolean) => Bun.spawnSync([...(fenced ? [SANDBOX_EXEC, "-p", sidecarSeatbeltProfile("/usr/bin/nc", [])] : []), "/usr/bin/nc", "-w", "2", ...args], { stdin: "ignore", timeout: 8000 }).exitCode;
      expect(nc(["-U", sock], false)).toBe(0);
      expect(nc(["-U", sock], true)).not.toBe(0);
      expect(nc(["127.0.0.1", String((tcp.address() as { port: number }).port)], true)).toBe(0);
      // Listening is UDP's only: a TCP listener is refused at once; a UDP one takes a datagram.
      expect(Bun.spawnSync([SANDBOX_EXEC, "-p", sidecarSeatbeltProfile("/usr/bin/nc", []), "/usr/bin/nc", "-l", "127.0.0.1", "0"], { stdin: "ignore", timeout: 5000 }).exitCode).not.toBe(0);
      const port = 40000 + (process.pid % 20000);
      const udp = Bun.spawn([SANDBOX_EXEC, "-p", sidecarSeatbeltProfile("/usr/bin/nc", []), "/usr/bin/nc", "-u", "-l", "127.0.0.1", String(port)], { stdin: "ignore", stdout: "pipe" });
      await Bun.sleep(500);
      const { createSocket } = await import("node:dgram");
      const sender = createSocket("udp4");
      await new Promise<void>((resolve) => sender.send("hello-udp\n", port, "127.0.0.1", () => resolve()));
      sender.close();
      await Bun.sleep(300);
      udp.kill();
      expect(await new Response(udp.stdout).text()).toContain("hello-udp");
    } finally {
      uds.close();
      tcp.close();
    }
  });

  test("a Clover home outside the user's home is hidden too", () => {
    const clover = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-home-")));
    writeFileSync(join(clover, "settings.json"), "{}");
    const seen: string[][] = [];
    fencedSidecarSpawn({ userHome: "/Users/nobody-here", cloverHome: clover, spawn: (argv) => { seen.push([...argv]); return {} as never; } })(["/bin/cat"]);
    const [, , profile] = seen[0]!;
    expect(Bun.spawnSync([SANDBOX_EXEC, "-p", profile!, "/bin/cat", join(clover, "settings.json")]).exitCode).not.toBe(0);
    expect(Bun.spawnSync([SANDBOX_EXEC, "-p", profile!, "/bin/cat", "/etc/hosts"]).exitCode).toBe(0);
  });
});

describe("the Windows sidecar's command line and environment", () => {
  test("arguments quoted as the C runtime parses them; the environment block sorted and double-terminated", () => {
    expect(windowsCommandLine(["C:\\Program Files\\Clover\\clover-link.exe", "a", 'say "hi"', "end\\", ""]))
      .toBe('"C:\\Program Files\\Clover\\clover-link.exe" a "say \\"hi\\"" end\\ ""');
    expect(windowsCommandLine(["x y\\"])).toBe('"x y\\\\"');
    expect(windowsEnvBlock({ b: "2", A: "1" }).toString("utf16le")).toBe("A=1\0b=2\0\0");
  });
});

const SYS32 = "C:\\Windows\\System32";
const readAll = async (s: ReadableStream<Uint8Array>) => Buffer.concat(await Array.fromAsync(s)).toString("utf8");

describe.skipIf(process.platform !== "win32")("the Windows sidecar, reduced, live", () => {
  test("low integrity, no privileges, Administrators deny-only, and it can start nothing", async () => {
    const groups = await startReducedSidecar([`${SYS32}\\whoami.exe`, "/groups", "/fo", "csv"]);
    const g = await readAll(groups.stdout);
    expect(await groups.exited).toBe(0);
    expect(g).toMatch(/Low Mandatory Level/);
    expect(g).not.toMatch(/Medium Mandatory Level/);
    // Administrators, where the user has it, is deny-only, whether or not the daemon runs elevated.
    for (const line of g.split("\n").filter((l) => /S-1-5-32-544/.test(l))) expect(line).toMatch(/deny only/i);
    const priv = await startReducedSidecar([`${SYS32}\\whoami.exe`, "/priv"]);
    const p = await readAll(priv.stdout);
    await priv.exited;
    expect(p).toMatch(/SeChangeNotifyPrivilege/);
    expect(p).not.toMatch(/SeShutdownPrivilege|SeIncreaseWorkingSetPrivilege|SeTimeZonePrivilege|SeUndockPrivilege/);
    const nested = await startReducedSidecar([`${SYS32}\\cmd.exe`, "/d", "/c", `${SYS32}\\whoami.exe`]);
    await readAll(nested.stdout);
    expect(await nested.exited).not.toBe(0); // the job holds one process: cmd can't start whoami
  }, 30_000);

  test("kill ends it, through its job", async () => {
    const ping = await startReducedSidecar([`${SYS32}\\PING.EXE`, "-n", "30", "127.0.0.1"]);
    await Bun.sleep(300);
    ping.kill();
    expect(await ping.exited).toBe(1);
  }, 30_000);
});

const canFence = onDarwin || (process.platform === "linux" && ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].some((p) => existsSync(p)));

describe.skipIf(!built || !canFence)("two real sidecars, fenced, on loopback", () => {
  test("they start under the device's key and link: a request and a stream", async () => {
    const spawn = fencedSidecarSpawn({ onLog: () => {} });
    const dev = async (name: string) => {
      const store = new MemorySecretStore();
      const key = await DeviceKey.loadOrCreate(store);
      const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-c-sidecar-")), key, clock, self: { name } });
      const wire = await SidecarWire.start({ binary: BIN, key, relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0", spawn });
      stops.push(() => wire.close());
      return { key, registry, wire, direct: (await wire.settledReport()).direct };
    };
    const a = await dev("Studio"), b = await dev("Laptop");
    expect(Buffer.from(a.wire.publicKey).toString("hex")).toBe(Buffer.from(a.key.publicKey).toString("hex"));
    await a.registry.add({ id: b.key.id, name: "Laptop", kind: "desktop", runsCore: true, computer: "Laptop", publicKey: b.key.publicKeyBase64 }, { via: "terminal" });
    await b.registry.add({ id: a.key.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", publicKey: a.key.publicKeyBase64 }, { via: "terminal" });
    a.wire.allow([b.key.publicKey]);
    b.wire.allow([a.key.publicKey]);
    await Promise.all([a.wire.stats(), b.wire.stats()]);
    const peers = new Map([[a.key.id, a], [b.key.id, b]]);
    const transport = (d: typeof a) => {
      const t = new CloverLinkTransport({ self: d.key.id, wire: d.wire, registry: d.registry, clock, directory: { target: (id) => { const p = peers.get(id); return p ? { key: p.key.publicKey, direct: p.direct } : undefined; } } });
      stops.push(() => t.close());
      return t;
    };
    const ta = transport(a), tb = transport(b);
    tb.handle("echo", (p) => p);
    const link = await ta.connect(b.key.id);
    expect(await link.request<unknown>("echo", { n: 1 })).toEqual({ n: 1 });
  }, 30_000);
});
