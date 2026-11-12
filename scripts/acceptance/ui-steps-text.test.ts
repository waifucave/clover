// The window steps read a document's drawn text with DRAWN_TEXT_JS (ui-steps.ts treeText, and the "This part stopped."
// check). The conversation skips its rows that are off screen (`content-visibility: auto`), and `innerText` leaves a skipped
// row out. Row 13 of the 14c gate counted the reply bubbles as 3 before the pill's reply and 3 after, because an older
// reply had scrolled out of view. The reader is run here on a small stand-in document, with no browser.
import { describe, expect, test } from "bun:test";
import { DRAWN_TEXT_JS, replyCount } from "./ui-steps";

type Unit = { textContent: string; checkVisibility?: (o?: { contentVisibilityAuto?: boolean }) => boolean };
/** A row: `shown` = drawn in view, `skipped` = drawn but off screen (skipped by content-visibility: auto), `hidden` =
 *  under a display: none part, `old` = a browser without checkVisibility. */
function unit(text: string, how: "shown" | "skipped" | "hidden" | "old"): Unit {
  if (how === "old") return { textContent: text };
  return { textContent: text, checkVisibility: (o) => how === "shown" || (how === "skipped" && o?.contentVisibilityAuto !== true) };
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
