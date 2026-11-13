// The Voice section of Settings: the running voice modes, the choice kept in Clover Voice's own `active` setting (empty
// is Clover Voice), and a chosen mode that stopped shown as not running.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeApi, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { UiRuntimeProvider } from "../../shell/client/sdk";
import { VoiceSection } from "../client";

afterEach(cleanup);

type Mode = { pluginId: string; id: string; name: string; active: boolean };
const CLOVER: Mode = { pluginId: "clover/voice", id: "clover-voice", name: "Clover Voice", active: true };
const OTHER: Mode = { pluginId: "acme-voice", id: "acme", name: "Acme Voice", active: false };

async function section(modes: Mode[], active = "") {
  const api = fakeApi({ pluginId: "clover/voice", settings: { active }, speech: { modes: async () => modes } as never });
  render(
    <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
      <VoiceSection />
    </UiRuntimeProvider>,
  );
  await act(() => settle(6));
  return api;
}

describe("Settings › Voice", () => {
  test("lists the running voice modes with Clover Voice chosen while the setting is empty; choosing another stores its id, choosing Clover Voice stores empty", async () => {
    const api = await section([CLOVER, OTHER]);
    const select = screen.getByRole("combobox", { name: "Active voice" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Clover Voice", "Acme Voice"]);
    expect(select.value).toBe("clover/voice");
    await act(async () => {
      fireEvent.change(select, { target: { value: "acme-voice" } });
      await settle(4);
    });
    expect(api.stored.get("active")).toBe("acme-voice");
    await act(async () => {
      fireEvent.change(select, { target: { value: "clover/voice" } });
      await settle(4);
    });
    expect(api.stored.get("active")).toBe("");
    expect(screen.getByText(/makes your bots text-only/)).toBeTruthy();
  });

  test("a chosen voice that isn't running is shown as not running", async () => {
    await section([CLOVER], "acme-voice");
    const select = screen.getByRole("combobox", { name: "Active voice" }) as HTMLSelectElement;
    expect(select.value).toBe("acme-voice");
    expect(select.selectedOptions[0]!.textContent).toBe("acme-voice (not running)");
  });

  test("no voice running: the section says the bots are text-only and offers no choice", async () => {
    await section([]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/your bots are text-only/)).toBeTruthy();
  });
});
