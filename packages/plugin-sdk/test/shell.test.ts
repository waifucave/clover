import { describe, expect, test } from "bun:test";
import { ThemeSchema, SHELL_GROUPS, SHELL_NOT_OFFERED, SHELL_SHAPE_NAMES, isShapeValue, isShellValue, resolveShell } from "../src";

const bar = { bar: "#F6F2FF", "bar.text": "#221A33", "bar.rule": "#C9BDEB" };
/** The sidebar's old group: Bots doesn't offer the sidebar (§5.5), so a theme that still has it loads and it is ignored. */
const sidebar = { sidebar: "linear-gradient(180deg, #F7F3FF, #F4FAF7)", "sidebar.text": "#2A2140", "sidebar.muted": "#5C5278", "sidebar.selected": "#F6F0FF", "sidebar.hover": "#F8F4FF" };

describe("a theme's shell block", () => {
  test("the schema takes the names the groups and the shape list, and still loads the sidebar's old ones; nothing else", () => {
    const ok = { theme: 1, name: "x", tokens: {}, shell: { tokens: { ...bar, accent: "#6A45D4", "bar.mode": "none" } } };
    expect(ThemeSchema.safeParse(ok).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...ok, shell: { tokens: { ...bar, ...sidebar, "sidebar.mode": "none", "sidebar.width": "260" } } }).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...ok, shell: { tokens: { "window.layout": "#fff" } } }).success).toBe(false);
    expect(Object.values(SHELL_GROUPS).flat()).toEqual(["bar", "bar.text", "bar.rule", "accent"]);
    expect(SHELL_SHAPE_NAMES.filter((n) => n.startsWith("sidebar"))).toEqual([]);
    expect(SHELL_NOT_OFFERED).toHaveLength(12);
  });

  test("values are hex colours, or for the bar's paint transparent and plain gradients: never a function that loads or runs", () => {
    expect(isShellValue("bar", "linear-gradient(90deg, #fff 0%, #000 100%)")).toBe(true);
    expect(isShellValue("bar", "transparent")).toBe(true);
    expect(isShellValue("bar.text", "transparent")).toBe(false);
    expect(isShellValue("bar.text", "linear-gradient(90deg, #fff, #000)")).toBe(false);
    expect(isShellValue("bar", "url(x.png)")).toBe(false);
    expect(isShellValue("bar", "linear-gradient(red, blue)")).toBe(false);
  });

  test("a legible group applies whole; one that misses a pair is dropped and the rest stay; the sidebar's old names are passed over without a word", () => {
    const light = resolveShell({ tokens: { ...bar, ...sidebar, "sidebar.mode": "none", accent: "#6A45D4" } }, "light", "#FCFAFF");
    expect(Object.keys(light.values).sort()).toEqual([...SHELL_GROUPS.bar, "accent"].sort());
    expect(light.dropped).toEqual([]);
    const bad = resolveShell({ tokens: { ...bar, "bar.text": "#E0D8F5", accent: "#6A45D4" } }, "light", "#FCFAFF");
    expect(bad.dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(bad.values["accent"]).toBe("#6A45D4");
    expect(bad.values["bar"]).toBeUndefined();
  });

  test("the bar is checked worst case, over pure black and pure white: a transparent bar with dark text is dropped", () => {
    const base = { "bar.rule": "#C9BDEB" };
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

  test("the accent must read at 3:1 where it is drawn: on the bar and on the surface the right panels show", () => {
    expect(resolveShell({ tokens: { ...bar, accent: "#6A45D4" } }, "light", "#FCFAFF").values["accent"]).toBe("#6A45D4");
    const weak = resolveShell({ tokens: { ...bar, accent: "#CDBFF0" } }, "light", "#FCFAFF");
    expect(weak.dropped.map((d) => d.group)).toEqual(["accent"]);
    // On its own it is checked against the theme's surface.
    expect(resolveShell({ tokens: { accent: "#CDBFF0" } }, "light", "#FCFAFF").dropped.map((d) => d.group)).toEqual(["accent"]);
    // Readable on a dark bar, not on a light surface: dropped (the panels show the surface).
    const dark = { bar: "#16132B", "bar.text": "#F3EEFF", "bar.rule": "#3A3058" };
    const onDark = resolveShell({ tokens: { ...dark, accent: "#F0E6FF" } }, "light", "#FCFAFF");
    expect(onDark.dropped.find((d) => d.group === "accent")?.why).toContain("the surface");
  });

  test("Clover's own marks stay visible: attention, danger, the stock accent and the focus ring reach 3:1 on the bar", () => {
    expect(resolveShell({ tokens: bar }, "light", "#FFFFFF").dropped).toEqual([]);
    // A bar the attention mark vanishes on.
    const dim = resolveShell({ tokens: { ...bar, bar: "#E4D2F7", "bar.text": "#221A33" } }, "light", "#FFFFFF");
    expect(dim.dropped.map((d) => d.group)).toEqual(["bar"]);
    expect(dim.dropped[0]?.why).toContain("attention");
    // The dark values are the dark marks: a dark skin passes where its marks read.
    expect(resolveShell({ tokens: { ...bar }, dark: { tokens: { bar: "#1A1534", "bar.text": "#F3EEFF", "bar.rule": "#3A3058" } } }, "dark", "#191919").dropped).toEqual([]);
  });

  test("a group missing a name is dropped; dark values replace light ones; a light-only theme does nothing in dark", () => {
    const partial = resolveShell({ tokens: { bar: "#EEE" } }, "light", "#FFF");
    expect(partial.values).toEqual({});
    expect(partial.dropped[0]?.group).toBe("bar");
    expect(resolveShell({ tokens: { sidebar: "#EEE" } }, "light", "#FFF")).toEqual({ values: {}, dropped: [] });
    const both = resolveShell({ tokens: { ...bar }, dark: { tokens: { bar: "#1B1633", "bar.text": "#F3EEFF", "bar.rule": "#4A3F72" } } }, "dark", "#1C1730");
    expect(both.values["bar"]).toBe("#1B1633");
    expect(resolveShell({ tokens: { ...bar } }, "dark", "#1C1730", "light").values).toEqual({});
  });

  test("shape names stand alone: each valid one is kept, a bad one is dropped, colours are untouched", () => {
    expect(SHELL_SHAPE_NAMES).toContain("bar.mode");
    expect(isShapeValue("bar.mode", "none")).toBe(true);
    expect(isShapeValue("bar.mode", "hidden")).toBe(false);
    expect(isShapeValue("panel.width", "460")).toBe(true);
    expect(isShapeValue("panel.width", "50")).toBe(false);
    expect(isShapeValue("panel.width", "460px")).toBe(false);
    expect(isShapeValue("sidebar.width", "260")).toBe(false);
    const r = resolveShell({ tokens: { "bar.mode": "none", "sidebar.mode": "float", "panel.width": "9999", ...bar } }, "light", "#FCFAFF");
    expect(r.values["bar.mode"]).toBe("none");
    expect(r.values["sidebar.mode"]).toBeUndefined();
    expect(r.values["panel.width"]).toBeUndefined();
    expect(r.values["bar"]).toBeDefined();
    expect(r.dropped.map((d) => d.group)).toEqual(["shape"]);
    expect(ThemeSchema.safeParse({ theme: 1, name: "x", tokens: {}, shell: { tokens: { "bar.mode": "none" } } }).success).toBe(true);
  });
});
