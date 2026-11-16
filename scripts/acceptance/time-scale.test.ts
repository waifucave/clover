import { describe, expect, test } from "bun:test";

const load = async (scale: string | undefined): Promise<typeof import("./time-scale")> => {
  const was = process.env.MOSS_ACCEPT_TIME_SCALE;
  if (scale === undefined) delete process.env.MOSS_ACCEPT_TIME_SCALE; else process.env.MOSS_ACCEPT_TIME_SCALE = scale;
  try { return await import(`./time-scale?${Math.random()}`); } finally { if (was === undefined) delete process.env.MOSS_ACCEPT_TIME_SCALE; else process.env.MOSS_ACCEPT_TIME_SCALE = was; }
};

describe("the acceptance run's time scale", () => {
  test("unset it is 1 and a wait is what its step says", async () => {
    const t = await load(undefined);
    expect(t.TIME_SCALE).toBe(1);
    expect(t.scaled(10_000)).toBe(10_000);
  });
  test("3 makes every wait three times as long", async () => {
    const t = await load("3");
    expect(t.TIME_SCALE).toBe(3);
    expect(t.scaled(10_000)).toBe(30_000);
  });
  test("nonsense, zero, a fraction and a huge number all read 1", async () => {
    for (const v of ["", "abc", "0", "0.5", "-2", "11", "Infinity"]) expect((await load(v)).TIME_SCALE).toBe(1);
  });
});
