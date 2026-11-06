import { describe, expect, test } from "bun:test";
import { hostOf, normalizeAddress, tabName } from "../client/url";

describe("normalizeAddress", () => {
  test("a host, or host and path, with no scheme gets https://", () => {
    const cases: [string, string][] = [
      ["example.com", "https://example.com"],
      ["Example.com/Docs?a=1#top", "https://Example.com/Docs?a=1#top"],
      ["www.example.co.uk/a/b", "https://www.example.co.uk/a/b"],
      ["example.com:8080/x", "https://example.com:8080/x"],
      ["xn--bcher-kva.example", "https://xn--bcher-kva.example"],
      ["  clover.dev/docs  ", "https://clover.dev/docs"],
      ["192.168.1.20:3000/admin", "https://192.168.1.20:3000/admin"],
    ];
    for (const [typed, expected] of cases) expect([typed, normalizeAddress(typed)]).toEqual([typed, expected]);
  });

  test("the machine itself gets http://, since it has no certificate", () => {
    const cases: [string, string][] = [
      ["localhost", "http://localhost"],
      ["localhost:4321/docs/", "http://localhost:4321/docs/"],
      ["app.localhost:3000", "http://app.localhost:3000"],
      ["127.0.0.1:8080", "http://127.0.0.1:8080"],
      ["[::1]:3000/x", "http://[::1]:3000/x"],
    ];
    for (const [typed, expected] of cases) expect([typed, normalizeAddress(typed)]).toEqual([typed, expected]);
  });

  test("anything with a scheme goes as typed, for the browser to accept or refuse", () => {
    for (const typed of ["https://example.com/", "http://localhost:4321/", "about:blank", "file:///etc/hosts", "chrome://settings", "mailto:a@b.test", "javascript:alert(1)", "foo:bar"]) {
      expect(normalizeAddress(typed)).toBe(typed);
    }
  });

  test("what is no host goes as typed too", () => {
    for (const typed of ["two words", "what is a tab", "1.5", "v2.0", "intranet", "a.b", "user@example.com", "//example.com/x", "?q=1"]) {
      expect(normalizeAddress(typed)).toBe(typed);
    }
  });

  test("nothing typed is nothing", () => {
    expect(normalizeAddress("   ")).toBe("");
    expect(normalizeAddress("")).toBe("");
  });
});

describe("naming a tab", () => {
  test("the page's title, else its host, else nothing", () => {
    expect(tabName("Docs", "https://example.com/")).toBe("Docs");
    expect(tabName("  ", "https://www.example.com/a?b")).toBe("www.example.com");
    expect(tabName("", "about:blank")).toBe("");
    expect(tabName("", "not a url")).toBe("");
    expect(hostOf("http://localhost:4321/docs/")).toBe("localhost:4321");
  });
});
