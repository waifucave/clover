import { describe, expect, test } from "bun:test";
import { ThemeSchema, SHELL_GROUPS, isShellValue, resolveShell } from "../src";

const bar = { bar: "#F3EEFFF4", "bar.text": "#221A33", "bar.rule": "#C9BDEB" };
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

  test("the bar is checked worst case, over pure black and pure white: a transparent bar with dark text is dropped", () => {
    const base = { "bar.rule": "#C9BDEB", ...sidebar };
    const r = resolveShell({ tokens: { bar: "transparent", "bar.text": "#111111", ...base } }, "light", "#FCFAFF");
    expect(r.dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(r.values["bar"]).toBeUndefined();
    // A translucent paint that only reads over a light ground fails too; a near-opaque one passes.
    expect(resolveShell({ tokens: { bar: "#F3EEFF55", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF").dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(resolveShell({ tokens: { bar: "#F3EEFFF4", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF").dropped).toEqual([]);
    // Each gradient stop is checked on its own.
    const grad = resolveShell({ tokens: { bar: "linear-gradient(90deg, #F3EEFF, #101010)", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF");
    expect(grad.dropped.map((d) => d.group)).toEqual(["bar"]);
  });

  test("colours take exactly 3, 4, 6 or 8 hex digits, in gradient stops too", () => {
    for (const bad of ["#12345", "#1234567", "#12", "#123456789"]) {
      expect(isShellValue("bar.text", bad)).toBe(false);
      expect(isShellValue("bar", `linear-gradient(90deg, ${bad}, #fff)`)).toBe(false);
    }
    for (const ok of ["#123", "#1234", "#123456", "#12345678"]) {
      expect(isShellValue("bar.text", ok)).toBe(true);
      expect(isShellValue("bar", `linear-gradient(90deg, ${ok}, #fff)`)).toBe(true);
    }
  });

  test("the accent must read at 3:1 on the bar, the sidebar, the selected and hovered rows; with no sidebar group, on the surface", () => {
    const tokens = { ...bar, ...sidebar };
    expect(resolveShell({ tokens: { ...tokens, accent: "#6A45D4" } }, "light", "#FCFAFF").values["accent"]).toBe("#6A45D4");
    const weak = resolveShell({ tokens: { ...tokens, accent: "#CDBFF0" } }, "light", "#FCFAFF");
    expect(weak.dropped.map((d) => d.group)).toEqual(["accent"]);
    // On its own it is checked against the shell's surface.
    expect(resolveShell({ tokens: { accent: "#CDBFF0" } }, "light", "#FCFAFF").dropped.map((d) => d.group)).toEqual(["accent"]);
    // It reads on the sidebar paint but not on the selected row.
    const rows = resolveShell({ tokens: { ...tokens, "sidebar.selected": "#7B5CE0", "sidebar.text": "#FFFFFF", sidebar: "#2A2140", "sidebar.muted": "#D0C8EA", "sidebar.hover": "#3A2E5A", accent: "#8E70F0" } }, "light", "#FCFAFF");
    expect(rows.dropped.map((d) => d.group)).toContain("accent");
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
