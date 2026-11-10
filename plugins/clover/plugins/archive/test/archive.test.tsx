import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EntryComponent } from "../../shell/runtime/types";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { ArchiveEntry, OLD_APP } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { ARCHIVED, NOW } from "../gallery/fixtures";

afterEach(cleanup);

/** Stands in for the conversation part: shows the props its spot got. */
const Transcript: EntryComponent = ({ props }) => <p data-testid="transcript">{JSON.stringify(props)}</p>;

async function mount(params: { session?: string } = {}) {
  const core = fakeCore({
    "archive.list": ({ query, cursor }) => {
      const matching = ARCHIVED.filter((s) => !query || (s.title ?? "").toLowerCase().includes(query.toLowerCase()));
      const page = cursor ? matching.slice(Number(cursor)) : matching.slice(0, 3);
      return { sessions: page, more: !cursor && matching.length > 3, ...(!cursor && matching.length > 3 ? { cursor: "3" } : {}) };
    },
  });
  const runtime = runtimeWith({
    core: () => core,
    spot: (name) => (name === "conversation" ? { shape: "single" } : undefined),
    entries: [{ pluginId: "clover/conversation", id: "conversation", spot: "conversation", component: "ConversationEntry", source: "bundled", enabledAt: 0 }],
    component: (_, name) => (name === "ConversationEntry" ? Transcript : undefined),
  });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <ArchiveEntry props={{ route: "archive", params, now: NOW }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { core };
}

const titles = () => within(screen.getByRole("list", { name: "Old sessions" })).getAllByRole("button").map((b) => b.querySelector(".cl-archive__session-title")?.textContent);

describe("the archive", () => {
  test("lists the old sessions a page at a time, each with its mode, project and date", async () => {
    await mount();
    expect(titles()).toEqual(["Release notes for 0.123", "Trip to Kyoto: what to book first", "Clean up the Downloads folder"]);
    expect(screen.getAllByRole("button")[0]!.textContent).toContain("Code · assistant · Nov 2");
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await act(() => settle());
    expect(titles()).toEqual(["Release notes for 0.123", "Trip to Kyoto: what to book first", "Clean up the Downloads folder", "Profile the daemon's idle wakeups", "Untitled session"]);
    // A session from another year says the year.
    expect(within(screen.getByRole("list", { name: "Old sessions" })).getAllByRole("button")[4]!.textContent).toContain("Chat · Oct 1, 2025");
  });

  test("a picked session reads through the conversation spot, archived, the old app speaking", async () => {
    await mount();
    expect(screen.getByText("Pick a session to read it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Trip to Kyoto/ }));
    expect(JSON.parse(screen.getByTestId("transcript").textContent!)).toEqual({ bot: OLD_APP, session: "w-2", archived: true });
    expect(screen.getByRole("region", { name: "Trip to Kyoto: what to book first" }).textContent).toContain("Chat · Oct 30 · anthropic/claude-sonnet-5 · 18 messages");
  });

  test("opens on the session its route names", async () => {
    await mount({ session: "w-1" });
    expect(JSON.parse(screen.getByTestId("transcript").textContent!).session).toBe("w-1");
  });

  test("searching asks the core again", async () => {
    const { core } = await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search old sessions" }), { target: { value: "daemon" } });
    fireEvent.submit(screen.getByRole("search"));
    await act(() => settle());
    expect(core.calls.map((c) => c.params)).toEqual([{ limit: 50 }, { query: "daemon", limit: 50 }]);
    expect(titles()).toEqual(["Profile the daemon's idle wakeups"]);
  });
});
