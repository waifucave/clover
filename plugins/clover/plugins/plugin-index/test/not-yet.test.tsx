// Clover's own plugins this build can't run yet (the registry's `off` with NOT_AVAILABLE_YET): one plain line, a switch
// that can't be used, nothing to set, sign in to or read; their parent names them.
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NOT_AVAILABLE_YET as PROTOCOL_REASON } from "../../../../../packages/protocol/src/plugins";
import { NOT_AVAILABLE_YET, toInstalled } from "../client/entry";
import { Detail, Installed } from "../client/Installed";
import { S } from "../client/strings";
import type { PluginDetailView } from "../client/types";
import { INSTALLED } from "../gallery/fixtures";

afterEach(cleanup);

const parked = { ...INSTALLED.find((p) => p.id === "clover/shell")!, id: "clover/forwarder", name: "waifucave forwarder", state: "off" as const, reason: NOT_AVAILABLE_YET };
const list = [
  ...INSTALLED.map((p) => (p.id === "clover" ? { ...p, children: [...p.children, "clover/forwarder"] } : p)),
  parked,
];

describe("a plugin not available in this build yet", () => {
  test("the page's reason is the registry's, word for word", () => {
    expect(NOT_AVAILABLE_YET).toBe(PROTOCOL_REASON);
  });

  test("its parent's row says how many of its parts aren't available yet; a plugin that is says so itself", () => {
    const rows = toInstalled(list as never);
    const clover = rows.find((r) => r.id === "clover")!;
    expect(clover.notYetParts).toEqual(["waifucave forwarder"]);
    expect(clover.notYet).toBeUndefined();
    // The others have no such parts.
    expect(rows.filter((r) => r.id !== "clover" && r.notYetParts !== undefined)).toEqual([]);
    // A top-level plugin marked so (only Clover's tree can be) reads as one, in one plain line.
    const top = toInstalled([{ ...parked, id: "clover", parent: undefined, children: [] }] as never)[0]!;
    expect(top.notYet).toBe(true);
    render(<Installed plugins={[top, clover]} query="" onQuery={() => {}} onOpen={() => {}} />);
    expect(screen.getAllByText("Not available in this build yet").length).toBe(1);
    expect(screen.getByText("1 part not available in this build yet")).toBeTruthy();
  });

  test("its detail: one plain line; no switch, restart, pin, remove, mute, settings, sign-in or log", () => {
    let switched = 0;
    let restarted = 0;
    let removed = 0;
    const p: PluginDetailView = {
      id: "clover/forwarder", name: "waifucave forwarder", source: "Comes with Clover", state: "off", reason: NOT_AVAILABLE_YET, enabled: true, dev: false,
      children: [], notYet: true, provenance: "", oks: [], tools: [], servers: [],
      settings: [{ key: "origin", title: "Origin", secret: false, value: "x", control: { kind: "text", value: "x" } }],
      signIns: [{ index: 0, method: "api-key", signedIn: false, state: "signed-out" }], log: ["a line"], pinned: false, updates: true, agents: [], notifies: true, muted: false,
    };
    render(<Detail plugin={p} onBack={() => {}} onSwitch={() => void switched++} onRestart={() => void restarted++} onPin={() => {}} onMute={() => {}} onRemove={() => void removed++} onKey={() => {}} onSignIn={() => {}} onSignOut={() => {}} onSetting={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Not available in this build yet");
    for (const name of [S.turnOn, S.turnOff, S.restart, S.remove, S.holdBack, S.letThrough, S.mute, S.unmute]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    // Back is the one control left.
    expect(screen.getAllByRole("button").length).toBe(1);
    fireEvent.click(screen.getByRole("button"));
    expect([switched, removed]).toEqual([0, 0]);
    for (const title of [S.settings, S.signIns, S.log]) expect(screen.queryByRole("heading", { name: title })).toBeNull();
    expect(document.querySelector("[data-setting]")).toBeNull();
    expect(document.querySelector("[data-sign-in]")).toBeNull();
    expect(document.querySelector(".cl-plugin-index__log")).toBeNull();
    expect(restarted).toBe(0);
  });

  test("its parent's detail names it under the parts not available yet", () => {
    const p: PluginDetailView = {
      id: "clover", name: "Clover", source: "Comes with Clover", state: "running", enabled: true, dev: false, children: ["Shell", "waifucave forwarder"],
      notYetParts: ["waifucave forwarder"], provenance: "", oks: [], tools: [], servers: [], settings: [], signIns: [], log: [], pinned: false, updates: false, agents: [], notifies: false, muted: false,
    };
    render(<Detail plugin={p} onBack={() => {}} onSwitch={() => {}} onRestart={() => {}} onRemove={() => {}} onKey={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
    expect(screen.getByRole("heading", { name: "Parts not available in this build yet" })).toBeTruthy();
    expect(document.querySelector("[data-not-yet-parts]")?.textContent).toBe("waifucave forwarder");
  });
});
