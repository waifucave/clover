// What the real registry adds to lane B's contract: names unique ignoring case and never a Windows device name
// (S6 edit 10), and this computer's own entry kept on its own disk (§8.5: levels stay on each computer).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { CoreComputerRegistry } from "../../src/computers/registry";
import { FileSelfStateStore, selfStatePath } from "../../src/computers/store";

const clock = { now: () => 1 };
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("the computer registry", () => {
  test("names are unique ignoring case, found in any case, and never one Windows keeps", async () => {
    const reg = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" }, others: [{ name: "Laptop1", device: "laptop00000000000000" }] });
    expect(reg.get("laptop1")?.name).toBe("Laptop1");
    expect(isContractError(await rejection(reg.rename("Studio", "LAPTOP1")), "conflict")).toBe(true);
    expect(isContractError(await rejection(reg.rename("Studio", "con")), "invalid")).toBe(true);
    expect(isContractError((() => { try { reg.add({ name: "COM1", device: "x0000000000000000000" }); } catch (e) { return e; } })(), "invalid")).toBe(true);
    expect(isContractError((() => { try { reg.add({ name: "studio", device: "y0000000000000000000" }); } catch (e) { return e; } })(), "conflict")).toBe(true);
    await reg.rename("Studio", "studio"); // a computer may change its own name's case
    expect(reg.self().name).toBe("studio");
  });

  test("this computer's level and old names survive a restart, in the levels folder, owner-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-j-reg-"));
    const store = new FileSelfStateStore(selfStatePath(home));
    const a = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" }, store });
    await a.setLevel("Studio", "read-only");
    await a.rename("Studio", "Studio-2");
    const b = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" }, store });
    expect(b.self()).toMatchObject({ name: "Studio-2", level: "read-only", aliases: ["Studio"] });
    expect(JSON.parse(readFileSync(selfStatePath(home), "utf8"))).toEqual({ name: "Studio-2", level: "read-only", aliases: ["Studio"] });
    if (process.platform !== "win32") expect(statSync(selfStatePath(home)).mode & 0o077).toBe(0);
    // A raise still takes proof after a restart.
    expect(isContractError(await rejection(b.setLevel("Studio-2", "automatic")), "refused")).toBe(true);
  });
});
