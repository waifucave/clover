import { describe, expect, test } from "bun:test";
import { doors, envNamesIn } from "./verify-sealed-core";
import { SEALED_ENV_NAMES } from "./seal-bun-doors";

/** An ELF64 with one native string run and a `.bun` graph. */
function elf(native: string, graph: string): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(native), g = enc.encode(graph), names = enc.encode("\0.rodata\0.bun\0.shstrtab\0");
  const nativeAt = 64, graphAt = nativeAt + n.length, namesAt = graphAt + g.length, shoff = namesAt + names.length;
  const b = new Uint8Array(shoff + 4 * 64);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x7f454c46, false);
  v.setBigUint64(0x28, BigInt(shoff), true);
  v.setUint16(0x3a, 64, true);
  v.setUint16(0x3c, 4, true);
  v.setUint16(0x3e, 3, true);
  const section = (i: number, nameOff: number, offset: number, size: number) => {
    v.setUint32(shoff + i * 64, nameOff, true);
    v.setBigUint64(shoff + i * 64 + 0x18, BigInt(offset), true);
    v.setBigUint64(shoff + i * 64 + 0x20, BigInt(size), true);
  };
  section(1, 1, nativeAt, n.length);
  section(2, 9, graphAt, g.length);
  section(3, 14, namesAt, names.length);
  b.set(n, nativeAt);
  b.set(g, graphAt);
  b.set(names, namesAt);
  return b;
}

describe("verify:sealed-core", () => {
  test("the sweep finds every BUN_/NODE_ name in Bun's code, packed runs split, and none from the app's graph", () => {
    const names = envNamesIn(elf("\0BUN_TMPDIR\0link binaryBUN_SHOW_BUN_STACKFRAMESNODE_PRESERVE_SYMLINKS\0x NODE_DEBUG,", `"BUN_FROM_THE_APP"`));
    expect(names).toContain("BUN_TMPDIR");
    expect(names).toContain("NODE_DEBUG");
    expect(names).toContain("NODE_PRESERVE_SYMLINKS");
    expect(names).toContain("BUN_SHOW_BUN_STACKFRAMES");
    expect(names).not.toContain("BUN_FROM_THE_APP");
  });

  test("every door but argv's is checked for the core staying itself, and every =-led door is raw, macOS and Linux only", () => {
    const all = doors();
    for (const d of all) if (d.stayItself === false) expect(d.name.startsWith("argv ")).toBe(true);
    for (const d of all.filter((x) => x.raw !== undefined)) expect(d.os?.includes("win32") ?? false).toBe(false);
    for (const raw of ["=$PAYLOAD", "=--preload=$PAYLOAD", "=1", "=x"]) expect(all.some((d) => d.raw?.includes(raw))).toBe(true);
    for (const v of ["$PAYLOAD", "--preload $PAYLOAD", "1"]) expect(all.some((d) => d.env?.[""] === v)).toBe(true);
    // Each sealed name's own replacement is tried, on the OS whose seal it is.
    for (const name of SEALED_ENV_NAMES) {
      expect(all.some((d) => d.name.startsWith(`${name}'s macOS replacement DYLD_`) && d.os?.join() === "darwin")).toBe(true);
      expect(all.some((d) => d.name === `${name}'s Linux replacement's letters` && d.os?.join() === "linux")).toBe(true);
    }
  });
});
