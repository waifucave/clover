// The window steps read a document's drawn text with DRAWN_TEXT_JS (ui-steps.ts treeText, and the "This part stopped."
// check). The conversation skips the contents of its rows that are off screen (`content-visibility: auto` on the row),
// and `innerText` leaves skipped contents out. Row 13 of the 14c gate, and of source runs of 025b04366, counted the reply
// bubbles as 3 before the pill's reply and 3 after, because an older reply had scrolled out of view: the row itself is
// never skipped (only what is inside it), so asking the row alone found nothing to add back (a real run's reading: 95
// rows, 6 replies in their text, 3 in innerText, 0 rows found skipped). The reader is run here on a small stand-in
// document, with no browser.
import { describe, expect, test } from "bun:test";
import { DRAWN_TEXT_JS, REPLY_ROWS_JS, replyCount } from "./ui-steps";

type Check = (o?: { contentVisibilityAuto?: boolean }) => boolean;
type Unit = { textContent: string; checkVisibility?: Check; firstElementChild: { checkVisibility?: Check } | null };
/** A row: `shown` = drawn in view, `skipped` = drawn but off screen (its own content-visibility: auto skips what is inside
 *  it, as Chromium does: the row answers true, its first child false), `under` = under a skipped ancestor (the row itself
 *  answers false), `hidden` = under a display: none part, `old` = a browser without checkVisibility. */
function unit(text: string, how: "shown" | "skipped" | "under" | "hidden" | "old"): Unit {
  if (how === "old") return { textContent: text, firstElementChild: {} };
  const row: Check = (o) => how === "shown" || how === "skipped" || (how === "under" && o?.contentVisibilityAuto !== true);
  const kid: Check = (o) => how === "shown" || ((how === "skipped" || how === "under") && o?.contentVisibilityAuto !== true);
  return { textContent: text, checkVisibility: row, firstElementChild: { checkVisibility: kid } };
}
function drawn(body: { innerText: string } | null, units: Unit[]): string {
  const document = { body, querySelectorAll: (sel: string) => (sel === ".cl-conv__unit" ? units : []) };
  return String(new Function("document", `return ${DRAWN_TEXT_JS}`)(document));
}

describe("the window steps' drawn text", () => {
  test("a reply scrolled out of view still counts: 3 before the pill's reply, 4 after", () => {
    const old = ["ACCEPTANCE-REPLY-OK a", "ACCEPTANCE-REPLY-OK b", "ACCEPTANCE-REPLY-OK c"];
    // Before: all three in view, so innerText holds them all.
    const before = drawn({ innerText: old.join("\n") }, old.map((t) => unit(t, "shown")));
    // After: the new reply pushed the first one out of view, so innerText holds three, the oldest skipped.
    const after = drawn({ innerText: [...old.slice(1), "ACCEPTANCE-REPLY-OK d"].join("\n") }, [unit(old[0]!, "skipped"), ...old.slice(1).map((t) => unit(t, "shown")), unit("ACCEPTANCE-REPLY-OK d", "shown")]);
    expect([replyCount(before), replyCount(after)]).toEqual([3, 4]);
  });

  test("the real run's reading: rows whose contents are skipped count, and the pill's reply makes it one more", () => {
    // Before the pill: 5 replies in the rows, 3 of them in view; after: 6, still 3 in view (the oldest in view scrolled out).
    const rows = (n: number, inView: number) => Array.from({ length: n }, (_, i) => unit(`ACCEPTANCE-REPLY-OK ${i}`, i >= n - inView ? "shown" : "skipped"));
    const view = (n: number, inView: number) => Array.from({ length: inView }, (_, i) => `ACCEPTANCE-REPLY-OK ${n - inView + i}`).join("\n");
    expect([replyCount(drawn({ innerText: view(5, 3) }, rows(5, 3))), replyCount(drawn({ innerText: view(6, 3) }, rows(6, 3)))]).toEqual([5, 6]);
    // A row under a skipped ancestor counts too.
    expect(replyCount(drawn({ innerText: "" }, [unit("ACCEPTANCE-REPLY-OK u", "under")]))).toBe(1);
  });

  test("a row in view is never counted twice, and a hidden row or an old browser's row is left out as innerText leaves it", () => {
    const text = drawn({ innerText: "ACCEPTANCE-REPLY-OK in view" }, [
      unit("ACCEPTANCE-REPLY-OK in view", "shown"),
      unit("ACCEPTANCE-REPLY-OK in a hidden tab", "hidden"),
      unit("ACCEPTANCE-REPLY-OK old browser", "old"),
    ]);
    expect(replyCount(text)).toBe(1);
  });

  test("an absence over the transcript sees an off-screen row: Try again and This part stopped.", () => {
    const text = drawn({ innerText: "the newest reply" }, [unit("Try again", "skipped"), unit("This part stopped.", "skipped")]);
    expect([text.includes("Try again"), text.includes("This part stopped.")]).toEqual([true, true]);
  });

  test("a document with no body reads as empty", () => {
    expect(drawn(null, [unit("x", "skipped")])).toBe("");
  });
});

describe("the reply bubbles the window steps count (REPLY_ROWS_JS)", () => {
  function rows(body: { innerText: string } | null, units: Unit[]): number {
    const document = { body, querySelectorAll: (sel: string) => (sel === ".cl-conv__unit" ? units : []) };
    return Number(new Function("document", `return ${REPLY_ROWS_JS}`)(document));
  }
  test("one per row holding the marker, in view or scrolled out, even when a row's text holds it twice", () => {
    const twice = (i: number) => `ACCEPTANCE-REPLY-OK ${i} (copy: ACCEPTANCE-REPLY-OK ${i})`;
    // A real run's 4 -> 6 by words: a row scrolled out counted its hidden copy too. By rows it is 4 -> 5.
    const before = [unit(twice(0), "skipped"), unit("you: hello", "shown"), ...[1, 2, 3].map((i) => unit(twice(i), "shown"))];
    const after = [unit(twice(0), "skipped"), unit("you: hello", "skipped"), unit(twice(1), "skipped"), unit(twice(2), "shown"), unit(twice(3), "shown"), unit("you: again", "shown"), unit(twice(4), "shown")];
    expect([rows({ innerText: "" }, before), rows({ innerText: "" }, after)]).toEqual([4, 5]);
  });
  test("a row hidden with its tab is left out; a document with no conversation counts its drawn text; no body is none", () => {
    expect(rows({ innerText: "" }, [unit("ACCEPTANCE-REPLY-OK a", "hidden"), unit("ACCEPTANCE-REPLY-OK b", "under")])).toBe(1);
    expect(rows({ innerText: "ACCEPTANCE-REPLY-OK in the pill" }, [])).toBe(1);
    expect(rows(null, [])).toBe(0);
  });
});
