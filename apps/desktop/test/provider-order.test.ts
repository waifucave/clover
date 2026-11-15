import { describe, expect, test } from "bun:test";
import { orderProviders, SEARCH_FROM } from "../src/core/provider-order";

const p = (id: string, name: string, state = "signed-out") => ({ id, name, auth: [{ state }] });

describe("the welcome guide's provider list", () => {
  const list = [p("c", "Cedar"), p("a", "Acorn"), p("b", "Birch", "signed-in"), p("d", "Dune", "refreshing")];
  test("signed-in providers come first, then by name", () => {
    expect(orderProviders(list, "").map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
  test("a search matches name or id, ignoring case and edge spaces", () => {
    expect(orderProviders(list, "  CED ").map((x) => x.id)).toEqual(["c"]);
    expect(orderProviders(list, "a").map((x) => x.id)).toEqual(["a", "c"]);
    expect(orderProviders(list, "zzz")).toEqual([]);
  });
  test("it does not change the list it was given, and search shows only for long lists", () => {
    const before = list.map((x) => x.id);
    orderProviders(list, "");
    expect(list.map((x) => x.id)).toEqual(before);
    expect(SEARCH_FROM).toBeGreaterThan(list.length);
  });
});
