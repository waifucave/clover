import { describe, expect, test } from "bun:test";
import { orderProviders, SEARCH_FROM } from "../src/provider-order";

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

describe("the ones people have come first", () => {
  const q = (id: string, name: string, method = "api-key", state = "signed-out") => ({ id, name, auth: [{ state, method }] });
  test("added, then sign-ins, then the featured API-key providers in order, then the rest by name", () => {
    const list = [q("moss/model-agentrouter", "AgentRouter"), q("moss/model-anthropic", "Anthropic"), q("moss/model-openai", "OpenAI"), q("moss/model-codex-oauth", "ChatGPT", "oauth-pkce"), q("moss/model-xai-oauth", "xAI (sign-in)", "custom"), q("moss/model-groq", "Groq", "api-key", "signed-in"), q("moss/model-aion", "Aion Labs")];
    expect(orderProviders(list, "").map((x) => x.id)).toEqual(["moss/model-groq", "moss/model-codex-oauth", "moss/model-xai-oauth", "moss/model-openai", "moss/model-anthropic", "moss/model-agentrouter", "moss/model-aion"]);
    expect(orderProviders(list, "aion").map((x) => x.id)).toEqual(["moss/model-aion"]);
  });
});
