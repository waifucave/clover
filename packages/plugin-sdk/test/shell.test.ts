import { describe, expect, test } from "bun:test";
import { ThemeSchema, SHELL_GROUPS, SHELL_SHAPE_NAMES, isShapeValue, isShellValue, resolveShell } from "../src";

const bar = { bar: "#F6F2FF", "bar.text": "#221A33", "bar.rule": "#C9BDEB" };
const sidebar = { sidebar: "linear-gradient(180deg, #F7F3FF, #F4FAF7)", "sidebar.text": "#2A2140", "sidebar.muted": "#5C5278", "sidebar.selected": "#F6F0FF", "sidebar.hover": "#F8F4FF" };

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
    expect(resolveShell({ tokens: { bar: "#F6F2FF55", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF").dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(resolveShell({ tokens: { bar: "#F6F2FF", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF").dropped).toEqual([]);
    // Each gradient stop is checked on its own.
    const grad = resolveShell({ tokens: { bar: "linear-gradient(90deg, #F6F2FF, #101010)", "bar.text": "#221A33", ...base } }, "light", "#FCFAFF");
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
  });

  test("Clover's own marks stay visible: attention, danger, the stock accent and the focus ring reach 3:1 on every ground the skin supplies", () => {
    const base = { ...bar, ...sidebar };
    expect(resolveShell({ tokens: base }, "light", "#FFFFFF").dropped).toEqual([]);
    // A sidebar painted in the attention colour; a selected row in the danger colour; a bar the attention mark vanishes on.
    const att = resolveShell({ tokens: { ...base, sidebar: "#C27C00", "sidebar.text": "#000000", "sidebar.muted": "#1A1000" } }, "light", "#FFFFFF");
    expect(att.dropped.map((d) => d.group)).toEqual(["sidebar"]);
    expect(att.dropped[0]?.why).toContain("attention");
    const danger = resolveShell({ tokens: { ...base, sidebar: "#1A1530", "sidebar.text": "#FFFFFF", "sidebar.muted": "#D0C8EA", "sidebar.selected": "#C93C3C", "sidebar.hover": "#2A2243" } }, "light", "#FFFFFF");
    expect(danger.dropped.map((d) => d.group)).toEqual(["sidebar"]);
    expect(danger.dropped[0]?.why).toMatch(/mark on the selected row/);
    const dim = resolveShell({ tokens: { ...base, bar: "#E4D2F7", "bar.text": "#221A33" } }, "light", "#FFFFFF");
    expect(dim.dropped.map((d) => d.group)).toEqual(["bar"]);
    // The dark values are the dark marks: a dark skin passes where its marks read.
    expect(resolveShell({ tokens: { ...base }, dark: { tokens: { bar: "#1A1534", "bar.text": "#F3EEFF", "bar.rule": "#3A3058", ...Object.fromEntries(Object.entries(sidebar).map(([k, v]) => [k, v])) , sidebar: "#16132B", "sidebar.text": "#F3EEFF", "sidebar.muted": "#B3A9D2", "sidebar.selected": "#2A2243", "sidebar.hover": "#201A38" } } }, "dark", "#191919").dropped).toEqual([]);
  });

  test("a group missing a name is dropped; dark values replace light ones; a light-only theme does nothing in dark", () => {
    const partial = resolveShell({ tokens: { sidebar: "#EEE" } }, "light", "#FFF");
    expect(partial.values).toEqual({});
    expect(partial.dropped[0]?.group).toBe("sidebar");
    const both = resolveShell({ tokens: { ...bar }, dark: { tokens: { bar: "#1B1633", "bar.text": "#F3EEFF", "bar.rule": "#4A3F72" } } }, "dark", "#1C1730");
    expect(both.values["bar"]).toBe("#1B1633");
    expect(resolveShell({ tokens: { ...bar } }, "dark", "#1C1730", "light").values).toEqual({});
  });

  test("shape names stand alone: each valid one is kept, a bad one is dropped, colours are untouched", () => {
    expect(SHELL_SHAPE_NAMES).toContain("bar.mode");
    expect(isShapeValue("bar.mode", "none")).toBe(true);
    expect(isShapeValue("bar.mode", "hidden")).toBe(false);
    expect(isShapeValue("sidebar.width", "260")).toBe(true);
    expect(isShapeValue("sidebar.width", "50")).toBe(false);
    expect(isShapeValue("sidebar.width", "260px")).toBe(false);
    const r = resolveShell({ tokens: { "bar.mode": "none", "sidebar.mode": "float", "panel.width": "9999", ...bar } }, "light", "#FCFAFF");
    expect(r.values["bar.mode"]).toBe("none");
    expect(r.values["sidebar.mode"]).toBe("float");
    expect(r.values["panel.width"]).toBeUndefined();
    expect(r.values["bar"]).toBeDefined();
    expect(r.dropped.map((d) => d.group)).toEqual(["shape"]);
    expect(ThemeSchema.safeParse({ theme: 1, name: "x", tokens: {}, shell: { tokens: { "bar.mode": "none" } } }).success).toBe(true);
  });
});
