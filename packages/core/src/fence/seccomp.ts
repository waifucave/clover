// The seccomp filter Clover's Linux fences load into bubblewrap (`--seccomp <fd>`), one copy for all of them: the
// command fence (`linux-bwrap.ts`, through `fenced-process.ts`) and, with C-M3 item 4 (#282), the link sidecar, which
// keeps the host network for QUIC and so can't take `--unshare-net`.

/** The seccomp filter (classic BPF, `struct sock_filter[]`): `socket(AF_UNIX, …)` and `io_uring_setup` fail with EPERM,
 *  and so does every call of another architecture (a 32-bit binary's) or with the x32 bit (>= 0x40000000, which
 *  would otherwise reuse another number under the same audit), so no Unix socket on the disk can be reached.
 *  Null where the architecture isn't one Clover ships for. */
export function unixSocketFilter(arch: string = process.arch): Buffer | null {
  const t = arch === "x64" ? { audit: 0xc000003e, socket: 41 } : arch === "arm64" ? { audit: 0xc00000b7, socket: 198 } : null;
  if (t === null) return null;
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, ALLOW = 0x7fff0000, EPERM = 0x00050001, IO_URING_SETUP = 425, AF_UNIX = 1, X32 = 0x40000000;
  const prog: [number, number, number, number][] = [
    [LD, 0, 0, 4], //            0: the architecture
    [JEQ, 0, 7, t.audit], //     1: another one: EPERM (9)
    [LD, 0, 0, 0], //            2: the call
    [JGE, 5, 0, X32], //         3: x32 numbers: EPERM (9)
    [JEQ, 4, 0, IO_URING_SETUP], // 4: EPERM (9)
    [JEQ, 0, 2, t.socket], //    5: not socket(): allow (8)
    [LD, 0, 0, 16], //           6: its first argument, the domain (low 32 bits)
    [JEQ, 1, 0, AF_UNIX], //     7: AF_UNIX: EPERM (9), else allow (8)
    [RET, 0, 0, ALLOW], //       8
    [RET, 0, 0, EPERM], //       9
  ];
  const b = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => { b.writeUInt16LE(code, i * 8); b.writeUInt8(jt, i * 8 + 2); b.writeUInt8(jf, i * 8 + 3); b.writeUInt32LE(k >>> 0, i * 8 + 4); });
  return b;
}
