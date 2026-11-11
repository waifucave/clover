import { describe, expect, test } from "bun:test";
import { checkTheme } from "../src/index";

const base = { theme: 1, name: "t", tokens: { "color.surface": "#FCFAFF" } };
const bar = { bar: "#F3EEFFCC", "bar.text": "#221A33", "bar.rule": "#C9BDEB" };

describe("the shell block in the lint", () => {
  test("a whole, legible group passes", () => {
    expect(checkTheme({ ...base, shell: { tokens: bar } })).toEqual([]);
  });
  test("unknown names, loose values and a missing name are told", () => {
    expect(checkTheme({ ...base, shell: { tokens: { layout: "#fff" } } }).join()).toContain("not a shell token");
    expect(checkTheme({ ...base, shell: { tokens: { ...bar, bar: "url(x)" } } }).join()).toContain("must be a hex colour");
    expect(checkTheme({ ...base, shell: { tokens: { bar: "#fff" } } }).join()).toContain("needs all of");
  });
  test("text that misses 4.5:1 on its paint is told", () => {
    expect(checkTheme({ ...base, shell: { tokens: { ...bar, "bar.text": "#DDD5F0" } } }).join()).toContain("bar.text on bar is under 4.5:1");
  });
});
