// Who holds a connection to the network filter (the second review's should-fix 1), from each OS's socket table as
// text: Linux's /proc, macOS's lsof, Windows' netstat. No real lookups; the Electron test checks the real thing.
import { describe, expect, test } from "bun:test";
import { parseLsof, parseNetstat, parseProcNetTcp, PeerOwner, processTree, type PeerOwnerFs } from "../src/main/browser/peer-owner";

const LISTENER = 61000; // 0xEE48
const PEER = 52344; // 0xCC78
const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:EE48 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 1111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:CC78 0100007F:EE48 01 00000000:00000000 00:00000000 00000000   501        0 2222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:CC79 0100007F:EE48 01 00000000:00000000 00:00000000 00000000   502        0 3333 1 0000000000000000 20 4 30 10 -1
`;

function linuxFs(fds: Record<number, string[] | "denied">): PeerOwnerFs {
  return {
    readFile: async (p) => (p === "/proc/net/tcp" ? PROC_TCP : ""),
    readdir: async (p) => {
      const pid = Number(p.split("/")[2]);
      const v = fds[pid];
      if (v === undefined || v === "denied") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return v.map((_, i) => String(i));
    },
    readlink: async (p) => {
      const [, , pid, , fd] = p.split("/");
      const v = fds[Number(pid)];
      return Array.isArray(v) ? v[Number(fd)]! : "";
    },
  };
}

const at = (port: number) => ({ address: "127.0.0.1", port });

describe("the socket tables, as text", () => {
  test("Linux /proc/net/tcp, lsof -F pn, netstat -ano", () => {
    expect(parseProcNetTcp(PROC_TCP)[1]).toEqual({ from: PEER, to: LISTENER, uid: 501, inode: 2222 });
    expect(parseLsof("p812\nf31\nn127.0.0.1:52344->127.0.0.1:61000\np900\nn[::1]:5000->[::1]:6000\n")).toEqual([
      { from: PEER, to: LISTENER, pid: 812 }, { from: 5000, to: 6000, pid: 900 },
    ]);
    expect(parseNetstat("\nActive Connections\n\n  Proto  Local Address  Foreign Address  State  PID\n  TCP    127.0.0.1:52344  127.0.0.1:61000  ESTABLISHED  4420\n")).toEqual([{ from: PEER, to: LISTENER, pid: 4420 }]);
  });
});

describe("PeerOwner", () => {
  test("Linux: the connecting socket's inode is the network process's; another process's isn't", async () => {
    const owner = new PeerOwner({ platform: "linux", run: async () => "", allowedPids: () => [77], fs: linuxFs({ 77: ["pipe:[1]", "socket:[2222]"] }) });
    expect(await owner.accepts(at(PEER), LISTENER)).toBe(true);
    expect(await owner.accepts(at(PEER + 1), LISTENER)).toBe(false);
    const other = new PeerOwner({ platform: "linux", run: async () => "", allowedPids: () => [77], fs: linuxFs({ 77: ["socket:[9999]"] }) });
    expect(await other.accepts(at(PEER), LISTENER)).toBe(false);
  });

  test("Linux, a network process whose fds can't be read: every connection is refused (fail closed), said once; the readable path says so too", async () => {
    const logs: string[] = [];
    const owner = new PeerOwner({ platform: "linux", run: async () => "", allowedPids: () => [77], fs: linuxFs({ 77: "denied" }), log: (l) => logs.push(l) });
    // The connection is the same user's (uid 501 in the table) and would have passed a uid check; it must not pass.
    expect(await owner.accepts(at(PEER), LISTENER)).toBe(false);
    expect(await owner.accepts(at(PEER + 1), LISTENER)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Linux path: .*can't be read.*refused/);
    const readable: string[] = [];
    const ok = new PeerOwner({ platform: "linux", run: async () => "", allowedPids: () => [77], fs: linuxFs({ 77: ["socket:[2222]"] }), log: (l) => readable.push(l) });
    expect(await ok.accepts(at(PEER), LISTENER)).toBe(true);
    expect(await ok.accepts(at(PEER), LISTENER)).toBe(true);
    expect(readable).toHaveLength(1);
    expect(readable[0]).toMatch(/Linux path: .*read from \/proc/);
  });

  test("macOS: lsof on the allowed processes alone; one reading for a burst of connections", async () => {
    const runs: string[][] = [];
    const owner = new PeerOwner({
      platform: "darwin", allowedPids: () => [812, 813],
      run: async (_cmd, args) => { runs.push(args); await new Promise((r) => setTimeout(r, 10)); return "p812\nn127.0.0.1:52344->127.0.0.1:61000\nn127.0.0.1:52345->127.0.0.1:61000\n"; },
    });
    const answers = await Promise.all([owner.accepts(at(PEER), LISTENER), owner.accepts(at(PEER + 1), LISTENER), owner.accepts(at(PEER + 2), LISTENER)]);
    expect(answers).toEqual([true, true, false]);
    expect(runs.length).toBeLessThanOrEqual(2);
    expect(runs[0]).toContain("812,813");
    // lsof exits 1 when a process has no connection: what it printed still counts.
    const quiet = new PeerOwner({ platform: "darwin", allowedPids: () => [812], run: async () => { throw Object.assign(new Error("exit 1"), { stdout: "" }); } });
    expect(await quiet.accepts(at(PEER), LISTENER)).toBe(false);
  });

  test("a connection made after a reading is found by the next one (never an old reading)", async () => {
    let table = "p812\nn127.0.0.1:52344->127.0.0.1:61000\n";
    let runs = 0;
    const owner = new PeerOwner({ platform: "darwin", allowedPids: () => [812], run: async () => { runs++; return table; } });
    expect(await owner.accepts(at(PEER), LISTENER)).toBe(true);
    table += "n127.0.0.1:52345->127.0.0.1:61000\n";
    expect(await owner.accepts(at(PEER + 1), LISTENER)).toBe(true);
    table += "n127.0.0.1:52346->127.0.0.1:61000\n";
    expect(await owner.accepts(at(PEER + 2), LISTENER)).toBe(true);
    expect(runs).toBe(3);
  });

  test("Windows: netstat names the process; only the allowed one passes", async () => {
    const run = async () => "  TCP    127.0.0.1:52344  127.0.0.1:61000  ESTABLISHED  4420\n  TCP    127.0.0.1:52345  127.0.0.1:61000  ESTABLISHED  999\n";
    const owner = new PeerOwner({ platform: "win32", allowedPids: () => [4420], run });
    expect(await owner.accepts(at(PEER), LISTENER)).toBe(true);
    expect(await owner.accepts(at(PEER + 1), LISTENER)).toBe(false);
  });

  test("fails closed: a table that can't be read, no network process, or a peer off loopback", async () => {
    const logs: string[] = [];
    const broken = new PeerOwner({ platform: "win32", allowedPids: () => [1], run: async () => { throw new Error("no netstat"); }, log: (l) => logs.push(l) });
    expect(await broken.accepts(at(PEER), LISTENER)).toBe(false);
    expect(logs.some((l) => l.includes("refused"))).toBe(true);
    const none = new PeerOwner({ platform: "darwin", allowedPids: () => [], run: async () => "p1\nn127.0.0.1:52344->127.0.0.1:61000\n" });
    expect(await none.accepts(at(PEER), LISTENER)).toBe(false);
    const ok = new PeerOwner({ platform: "darwin", allowedPids: () => [1], run: async () => "p1\nn127.0.0.1:52344->127.0.0.1:61000\n" });
    expect(await ok.accepts({ address: "192.168.1.5", port: PEER }, LISTENER)).toBe(false);
  });

  test("a browser's process tree, from ps", async () => {
    const run = async () => "  1     0\n 50     1\n 51    50\n 52    51\n 60     1\n";
    expect((await processTree([50], { platform: "linux", run })).sort()).toEqual([50, 51, 52]);
  });
});
