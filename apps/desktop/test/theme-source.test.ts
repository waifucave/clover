import { describe, expect, test } from "bun:test";
import { themeSourceOf } from "../src/main/theme-source";

describe("the Theme choice as nativeTheme.themeSource", () => {
  test("light, dark and system pass through", () => {
    expect(themeSourceOf("light")).toBe("light");
    expect(themeSourceOf("dark")).toBe("dark");
    expect(themeSourceOf("system")).toBe("system");
  });
  test("a missing or odd value is the OS's choice", () => {
    for (const v of [undefined, null, "", "Dark", "DARK", " dark", "auto", 1, true, {}, ["dark"]]) expect(themeSourceOf(v)).toBe("system");
  });
});
