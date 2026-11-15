import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolResult, diffLinesOf, shortPath, splitBash, trimDiff, writeVerb } from "../client/result";
import type { ToolCall } from "../client/types";

const call = (name: string, output: string, extra: Partial<ToolCall> = {}): ToolCall => ({ callId: "c", name, status: "succeeded", output, ...extra });
const create = JSON.stringify({
  type: "create",
  filePath: "/var/x/home/scratch/alpha/trip/packing.md",
  content: "# Packing\n",
  diff: [
    { type: "add", newLineNumber: 1, content: "# Packing" },
    { type: "add", newLineNumber: 2, content: "- Passport" },
  ],
});

afterEach(cleanup);

describe("a result never reads as a JSON dump for a known tool", () => {
  test("Write: added lines with numbers, a short path, no raw braces", () => {
    const { container } = render(<>{ToolResult({ call: call("Write", create) })}</>);
    expect(container.querySelectorAll('[data-line="add"]').length).toBe(2);
    expect(container.textContent).toContain("…/alpha/trip/packing.md".replace("alpha/trip", "trip"));
    expect(container.textContent).not.toContain('"type"');
    expect(writeVerb(create)).toBe("created");
  });

  test("a result the core cut short still yields the diff lines that survived", () => {
    const cut = create.slice(0, create.indexOf("- Passport") + 4);
    expect(diffLinesOf(cut)?.length).toBe(1);
  });

  test("a long diff keeps changes with a little context and says what it left out", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ type: i === 15 ? ("remove" as const) : ("context" as const), oldLine: i + 1, newLine: i + 1, content: `l${i}` }));
    const rows = trimDiff(lines);
    expect(rows.filter((r) => "gap" in r).length).toBe(2);
    expect(rows.length).toBe(7);
  });

  test("Bash: stdout, stderr, exit code and sandbox note are told apart", () => {
    const r = splitBash("(no stdout)\n[stderr]\nls: nope: No such file\n\n[exit 1]\n[sandbox: sandboxed]");
    expect(r).toEqual({ stdout: "", stderr: "ls: nope: No such file", exit: 1, notes: ["sandbox: sandboxed"] });
    const { container } = render(<>{ToolResult({ call: call("Bash", "x\n[exit 2]", { status: "failed" }) })}</>);
    expect(container.textContent).toContain("Exited with code 2");
  });

  test("an unknown tool's JSON is a key/value view with a raw toggle", () => {
    render(<>{ToolResult({ call: call("mcp__x__Thing", JSON.stringify({ a: 1, list: [1, 2], nested: { k: 1 } })) })}</>);
    expect(screen.getByText("list")).toBeTruthy();
    expect(screen.getByText("1 field")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show raw" }));
    expect(document.body.textContent).toContain('"nested"');
  });

  test("plain text of an unknown tool is left to the standard block", () => {
    expect(ToolResult({ call: call("Mystery", "just words") })).toBeNull();
  });

  test("WebSearch chips come from the results' titles and hosts", () => {
    const { container } = render(<>{ToolResult({ call: call("WebSearch", JSON.stringify({ results: [{ title: "Tram 28", url: "https://www.carris.pt/x" }] })) })}</>);
    expect(container.querySelector(".cl-conv-chips__title")?.textContent).toBe("Tram 28");
  });

  test("paths shorten to their last two parts", () => {
    expect(shortPath("/a/b/c/d.md")).toBe("…/c/d.md");
    expect(shortPath("d.md")).toBe("d.md");
  });
});
