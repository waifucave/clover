import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_STEPS, stepNumber, finishTable } from "./steps";
import { sealedProblem, WEB_STEP } from "./web-step";
import { DRAG_STEP, moveOf } from "./drag-step";
import { REVIEW_STEP, reviewProblem, type ReviewView } from "./review-step";

describe("the web part, drag and review rows", () => {
  test("each has its own row, and --only-* takes just that row", () => {
    const rows = [WEB_STEP, DRAG_STEP, REVIEW_STEP].map((s) => stepNumber(FULL_STEPS, s));
    expect(new Set(rows).size).toBe(3);
    for (const n of rows) expect(finishTable([], FULL_STEPS, n).map((r) => r.n)).toEqual([n]);
  });

  test("the fixture declares a ui entry of kind web with a folder page, and no code", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "acceptance-webpart", "clover.json"), "utf8"));
    expect(m.contributes.ui).toHaveLength(1);
    expect(m.contributes.ui[0].web).toEqual({ entry: "page.html", partition: "main" });
    expect(m.contributes.ui[0].component).toBeUndefined();
    expect(m.client).toBeUndefined();
    expect(m.host).toBeUndefined();
  });

  test("the web page's reach line is held to none", () => {
    const ok = "ACCEPTANCE-WEB-PART (scripted)\nbridge: none; node: none; page: top";
    expect(sealedProblem(ok)).toBeUndefined();
    expect(sealedProblem(ok.replace("bridge: none", "bridge: present"))).toContain("bridges");
    expect(sealedProblem(ok.replace("node: none", "node: present"))).toContain("Node");
    expect(sealedProblem("ACCEPTANCE-WEB-PART")).toContain("script didn't run");
    expect(sealedProblem("ACCEPTANCE-WEB-PART (scripted)")).toContain("reports nothing");
  });

  test("a window move is read from the app's log, the last one after the lines already there", () => {
    const lines = ["x window: moved by its title area, from (10, 20) to (11, 21)", "x window: a drag was refused (card)", "x window: moved by its title area, from (-5, 0) to (115, 60)"];
    expect(moveOf(lines, 1)).toMatchObject({ dx: 120, dy: 60 });
    expect(moveOf(lines, 2)).toBeUndefined();
    expect(moveOf(["window: moved by its title area, nonsense"], 0)).toBeUndefined();
  });

  test("a Review view passes only when done, headed, carrying the plugin's report and naming the model", () => {
    const v: ReviewView = { state: "done", note: "Review sends this plugin's files to anthropic/x. It's advice: it doesn't answer this card.", headHidden: false, head: "A model's reading of the plugin's files", report: "ACCEPTANCE-REVIEW acceptance-page: fine.\nThis is a model's reading of the plugin's files, not a check.", buttonDisabled: true };
    expect(reviewProblem(v, "anthropic/x")).toBeUndefined();
    expect(reviewProblem({ ...v, state: "failed" }, "anthropic/x")).toContain("not done");
    expect(reviewProblem({ ...v, headHidden: true }, "anthropic/x")).toContain("hidden");
    expect(reviewProblem({ ...v, report: "other" }, "anthropic/x")).toContain("doesn't carry");
    expect(reviewProblem(v, "other/model")).toContain("doesn't name the model");
    expect(reviewProblem({ ...v, note: "Review sends this plugin's files to a model. It's advice" }, "a model")).toContain("before the model");
  });
});
