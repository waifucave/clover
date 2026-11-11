import { describe, expect, test } from "bun:test";
import { ThemeSchema, SHELL_GROUPS, isShellValue, resolveShell } from "../src";

const bar = { bar: "#F3EEFFCC", "bar.text": "#221A33", "bar.rule": "#C9BDEB" };
const sidebar = { sidebar: "linear-gradient(180deg, #E9E1FA, #F7F3FF)", "sidebar.text": "#2A2140", "sidebar.muted": "#5C5278", "sidebar.selected": "#D9CCF5", "sidebar.hover": "#E3D9F8" };

describe("a theme's shell block", () => {
  test("the schema takes only the names the groups list", () => {
    const ok = { theme: 1, name: "x", tokens: {}, shell: { tokens: { ...bar, ...sidebar, accent: "#6A45D4" } } };
    expect(ThemeSchema.safeParse(ok).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...ok, shell: { tokens: { "window.layout": "#fff" } } }).success).toBe(false);
    expect(Object.values(SHELL_GROUPS).flat().length).toBe(9);
  });

  test("values are hex colours, or for the two paints transparent and plain gradients: never a function that loads or runs", () => {
    expect(isShellValue("bar", "linear-gradient(90deg, #fff 0%, #000 100%)")).toBe(true);
    expect(isShellValue("bar", "transparent")).toBe(true);
    expect(isShellValue("bar.text", "transparent")).toBe(false);
    expect(isShellValue("bar", "url(x.png)")).toBe(false);
    expect(isShellValue("sidebar", "linear-gradient(red, blue)")).toBe(false);
  });

  test("a legible group applies whole; one that misses a pair is dropped and the rest stay", () => {
    const light = resolveShell({ tokens: { ...bar, ...sidebar } }, "light", "#FCFAFF");
    expect(Object.keys(light.values).sort()).toEqual([...SHELL_GROUPS.bar, ...SHELL_GROUPS.sidebar].sort());
    const bad = resolveShell({ tokens: { ...bar, "bar.text": "#E0D8F5", ...sidebar } }, "light", "#FCFAFF");
    expect(bad.dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(bad.values["sidebar"]).toBeDefined();
    expect(bad.values["bar"]).toBeUndefined();
  });

  test("a group missing a name is dropped; dark values replace light ones; a light-only theme does nothing in dark", () => {
    const partial = resolveShell({ tokens: { sidebar: "#EEE" } }, "light", "#FFF");
    expect(partial.values).toEqual({});
    expect(partial.dropped[0]?.group).toBe("sidebar");
    const both = resolveShell({ tokens: { ...bar }, dark: { tokens: { bar: "#1B1633", "bar.text": "#F3EEFF", "bar.rule": "#4A3F72" } } }, "dark", "#1C1730");
    expect(both.values["bar"]).toBe("#1B1633");
    expect(resolveShell({ tokens: { ...bar } }, "dark", "#1C1730", "light").values).toEqual({});
  });
});
