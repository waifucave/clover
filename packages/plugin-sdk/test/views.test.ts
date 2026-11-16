// The view types the SDK publishes (src/views.ts) are the core's own, written out plainly: the file is what the
// generator writes now, and each type is the core's both ways (checked by the compiler, below).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Proto from "@waifucave/moss-protocol";
import type * as Views from "../src/views";
import { viewsSource } from "../scripts/views";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(_: T) => undefined;
same<Same<Views.BotView, Proto.BotView>>(true);
same<Same<Views.SessionView, Proto.SessionView>>(true);
same<Same<Views.ArchivedSessionView, Proto.ArchivedSessionView>>(true);
same<Same<Views.ComputerView, Proto.ComputerView>>(true);
same<Same<Views.DeviceView, Proto.DeviceView>>(true);
same<Same<Views.PluginSummary, Proto.PluginSummary>>(true);
same<Same<Views.PluginDetail, Proto.PluginDetail>>(true);
same<Same<Views.CardMeta, Proto.CardMeta>>(true);
same<Same<Views.SessionKind, Proto.SessionKind>>(true);
same<Same<Views.FileStat, Proto.FileStat>>(true);
same<Same<Views.UiPluginView, Proto.UiPluginView>>(true);
same<Same<Views.UiSettings, Proto.UiSettings>>(true);

describe("the view types", () => {
  test("src/views.ts is what the generator writes now (run `bun run generate` after a schema changes)", () => {
    expect(readFileSync(join(import.meta.dir, "..", "src", "views.ts"), "utf8")).toBe(viewsSource());
  });
  test("they import nothing: the published types stand alone", () => {
    expect(readFileSync(join(import.meta.dir, "..", "src", "views.ts"), "utf8")).not.toMatch(/\bimport\b/);
  });
});
