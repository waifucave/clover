// The reading's limit in MOSS's copy of the sealed pages (the same two constants and the same page script as MOSS Code's).
import { describe, expect, test } from "bun:test";
import { FRESH_LIMIT_MS, FRESH_SETTLE_MS, buttonPage } from "../src/main/sealed-pages";
import { FRESH_MAX_AGE_MS } from "../src/main/sealed";

describe("the reading's limit", () => {
  test("a press waits for its two readings (the second a settle after the press) with room to spare, and gives the reading up well inside the age the app accepts it at", () => {
    // Measured on the GitHub macOS runners (608 presses, three runs): 5 to 373 ms, median about 140, p95 about 210.
    expect(FRESH_LIMIT_MS).toBeGreaterThanOrEqual(2 * 373);
    expect(FRESH_LIMIT_MS).toBeGreaterThan(FRESH_SETTLE_MS * 4);
    expect(FRESH_LIMIT_MS).toBeLessThanOrEqual(FRESH_MAX_AGE_MS / 1.5);
  });

  test("the page gives its reading up at the limit, as a 'late' that refuses nothing and answers nothing, and a cover during the wait still spoils the press", () => {
    const b = buttonPage({ cardId: "card_x", token: "t".repeat(43), option: "allow_once", label: "Allow", kind: "approve" });
    expect(b).toContain(`resolve(null); }, ${FRESH_LIMIT_MS})`);
    expect(b).toContain(`t0 + ${FRESH_SETTLE_MS} - performance.now()`);
    expect(b).toContain("if (after.some((x) => !shows(x))) spoiled = true");
    expect(b).toContain("finish(seen && !spoiled)");
  });
});
