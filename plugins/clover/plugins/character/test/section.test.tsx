// The Avatar section of a bot's editor (`bot.editor.section`), filled by this plugin: packs, the user's own model through
// main's picker and `bot.importAvatar`, and the model's credit note. With no renderer installed it says so and offers
// neither; the bot editor draws it only while this plugin fills the spot.
import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiEntry } from "../../shell/runtime/resolve";
import { SPOT_DECLS } from "../../shell/runtime/catalog";
import { fakeApi, fakeApprovals, fakeCore, settle } from "../../shell/runtime/testkit";
import type { BotView, EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { UiRuntimeProvider } from "../../shell/client/sdk";
import { BotEditorEntry } from "../../bot-editor/client/entry";
import { AvatarSection } from "../client";

afterEach(cleanup);

const noop = () => undefined;
const ALPHA: BotView = { id: "alpha", name: "Alpha", model: "openai/gpt-6", userLayer: ["theme"], state: "idle", mainSession: "s_alpha" };
const VRM = { pluginId: "clover/vrm", entryId: "vrm", value: { id: "vrm", format: "vrm", name: "VRM", entry: { extensions: [".vrm"] }, files: { kinds: [{ ext: [".vrm", ".glb"], type: "binary" }], maxFiles: 1 }, import: { accepts: ["file"] } } };
const LIVE2D = { pluginId: "clover/live2d", entryId: "live2d", value: { id: "live2d", format: "live2d", name: "Live2D (Cubism)", entry: { extensions: [".model3.json", ".zip"] }, files: { kinds: [{ ext: [".json"], type: "json" }] }, import: { accepts: ["folder", "zip"] } } };
const PACKS = [
  { pluginId: "chibi-pack", entryId: "mint", value: { id: "mint", name: "Mint", file: "assets/mint.vrm", format: "vrm", portrait: "assets/mint.png" } },
  { pluginId: "chibi-pack", entryId: "rose", value: { id: "rose", file: "assets/rose.vrm", format: "vrm" } },
];
const sectionEntry = { pluginId: "clover/character", id: "avatar", spot: "bot.editor.section", component: "AvatarSection", fields: { title: "Avatar" }, source: "bundled", enabledAt: 0 } as unknown as UiEntry;

/** The bot editor with whatever entries fill `bot.editor.section` (the character plugin's, or none), on the runtime. */
async function editor(view: BotView, o: { entries?: UiEntry[]; formats?: unknown[]; packs?: unknown[]; core?: Parameters<typeof fakeCore>[0] } = {}) {
  const core = fakeCore({
    "bot.setUserLayer": () => ({ applied: true }),
    "models.list": () => ({ models: [] }),
    "plugin.ui": () => ({ plugins: [] }),
    "plugin.list": () => ({ plugins: [{ id: "chibi-pack", name: "Chibi pack" } as never] }),
    ...o.core,
  });
  const api = fakeApi({
    bots: { list: async () => [view], get: async () => view, watch: () => noop },
    points: { "avatar.formats": o.formats ?? [VRM, LIVE2D], "avatar.packs": o.packs ?? PACKS },
  } as never);
  const runtime = runtimeWith({
    api: () => api, core: () => core, approvals: fakeApprovals(), spot: (name) => SPOT_DECLS[name],
    entries: o.entries ?? [sectionEntry],
    component: (_p, name) => (name === "AvatarSection" ? (AvatarSection as unknown as EntryComponent) : undefined),
  });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <BotEditorEntry props={{ route: "bot-editor", params: { bot: view.id }, navigate: noop }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle(6));
  return { core };
}

describe("the bot editor and this plugin's section", () => {
  test("with this plugin filling `bot.editor.section`, the editor shows the Avatar section; without it the editor has no avatar section at all", async () => {
    await editor(ALPHA);
    expect(screen.getByRole("radiogroup", { name: "Avatar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose avatar…" })).toBeTruthy();
    cleanup();
    await editor(ALPHA, { entries: [] });
    expect(screen.queryByText("Avatar")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose avatar…" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  });

  test("the section sits between the model and the voice", async () => {
    await editor(ALPHA);
    const rows = [...document.querySelectorAll(".cl-bot-editor__rows > section")].map((e) => e.querySelector(".cl-bot-editor__label, .cl-avatar-section__label")?.textContent);
    expect(rows.indexOf("Avatar")).toBe(rows.indexOf("Model") + 1);
    expect(rows[rows.indexOf("Avatar") + 1]).toBe("Voice");
  });
});

describe("the avatar section", () => {
  test("lists the avatars the installed packs offer, named by their plugin, and a choice is a patch to the user layer; Reset clears it", async () => {
    const { core } = await editor({ ...ALPHA, userLayer: ["avatar"] });
    const avatars = within(screen.getByRole("radiogroup", { name: "Avatar" }));
    // Rose has no name of its own (its id stands in) and no portrait (its initial stands in).
    expect(avatars.getAllByRole("radio").map((r) => r.textContent)).toEqual(["MintFrom Chibi pack", "RroseFrom Chibi pack"]);
    fireEvent.click(avatars.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Reset the avatar" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([
      { id: "alpha", patch: { avatar: { file: "assets/mint.vrm", format: "vrm", portrait: "assets/mint.png" } } },
      { id: "alpha", patch: { avatar: null } },
    ]);
  });

  test("no Reset while the avatar is the plugin's; no packs says where they come from", async () => {
    await editor(ALPHA, { packs: [] });
    expect(screen.queryByRole("button", { name: "Reset the avatar" })).toBeNull();
    expect(screen.getByText(/No avatar packs are installed yet/)).toBeTruthy();
  });

  test("with no renderer installed, the section says nothing can draw avatars and offers no pack and no import", async () => {
    await editor(ALPHA, { formats: [] });
    expect(screen.getByText(/Nothing installed can draw avatars yet/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose avatar…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a folder instead" })).toBeNull();
  });

  test("a pick names the use, shows only a name, imports on a second click with the token, and says how it went", async () => {
    const { core } = await editor(ALPHA, {
      core: {
        "ui.pick": () => ({ token: "pick-1", name: "Mochi\u202e.zip" }),
        "bot.importAvatar": () => ({ format: "live2d", name: "Live2D (Cubism)", files: 12, bytes: 3 * 1024 * 1024 }),
      },
    });
    // What it takes comes from the installed renderers' declarations, not from formats the section knows by name.
    expect(screen.getByText(/^Your own model: /).textContent).toBe("Your own model: a .vrm or .glb file (VRM); a folder or .zip with a .model3.json (Live2D (Cubism)). It is copied into Clover; the original stays where it is.");
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "file", use: "bot.importAvatar" });
    expect(screen.getByText(/^Picked: /).textContent).not.toContain("\u202e");
    fireEvent.click(screen.getByRole("button", { name: "Import and use" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "bot.importAvatar")?.params).toEqual({ id: "alpha", path: "pick-1" });
    expect(screen.getByRole("status").textContent).toContain("Imported a Live2D (Cubism) model (12 files, 3.0 MB)");
    // The token is spent: the import button is gone until another pick.
    expect(screen.queryByRole("button", { name: "Import and use" })).toBeNull();
  });

  test("a folder pick asks for a folder; a cancelled pick and a refused import say so in plain words", async () => {
    let cancel = true;
    const { core } = await editor(ALPHA, {
      core: {
        "ui.pick": () => (cancel ? { cancelled: true } : { token: "pick-2", name: "model" }),
        "bot.importAvatar": () => { throw new Error("no .model3.json in there"); },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder instead" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "folder", use: "bot.importAvatar" });
    expect(screen.getByRole("status").textContent).toBe("Nothing picked.");
    cancel = false;
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("button", { name: "Import and use" }));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("That didn't work: no .model3.json in there");
  });

  test("the model's own note shows under the avatar, and the user can change or clear it (their own value for that avatar)", async () => {
    const view: BotView = { ...ALPHA, userLayer: ["avatar"], avatar: { src: "/_a/alpha/m-1/x.model3.json", format: "live2d", credit: "Free for personal use, credit the artist." } };
    const { core } = await editor(view);
    const box = screen.getByRole("textbox", { name: "Credit note" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Free for personal use, credit the artist.");
    expect(screen.getByText("From the model's own notes")).not.toBeNull();
    fireEvent.change(box, { target: { value: "Rigging by someone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([
      { id: "alpha", patch: { avatarCredit: "Rigging by someone" } },
      { id: "alpha", patch: { avatarCredit: null } },
    ]);
  });

  test("before the second click, an import says it replaces the avatar the user imported before (and says nothing when there is none)", async () => {
    const own: BotView = { ...ALPHA, userLayer: ["avatar"], avatar: { src: "/_a/alpha/m-1/x.model3.json", format: "live2d" } };
    await editor(own, { core: { "ui.pick": () => ({ token: "pick-1", name: "m.zip" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(screen.getByText("This replaces the avatar you imported before.")).not.toBeNull();
    cleanup();
    await editor(ALPHA, { core: { "ui.pick": () => ({ token: "pick-2", name: "m.zip" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(screen.queryByText("This replaces the avatar you imported before.")).toBeNull();
  });
});

void React;
