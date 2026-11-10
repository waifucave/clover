// The user's UI choices (`ui.settings`, `ui.set`, spec §5.5), which the app's plugin runtime applies: picks, list
// orders, themes, overrides, language, appearance, text size. Kept in `<home>/settings/ui.json` (a fenced folder),
// written whole through a temp file; each change is `ui_settings_changed` to the app.
//
// * From the app (the user) or the bundled `clover` tree's layer it applies; from any other layer it would be a card
//   (§5.5), which waits for the approval broker (C-M3): refused with why.
// * Token overrides pass the same check as any theme's (`isValueForToken`). CSS overrides need the theme cleaner,
//   which isn't on main: refused with why, so nothing uncleaned reaches the user's layer.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValueForToken } from "@waifucave/clover-plugin-sdk";
import { APP_EVENTS, APP_METHODS, UiSettings } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { handler, type MethodHandler } from "../rpc/handler";

const EMPTY: UiSettings = { picks: [], lists: [] };

export function uiSettingsFile(home: string): string {
  return join(home, "settings", "ui.json");
}

export function readUiSettings(home: string): UiSettings {
  try {
    const parsed = UiSettings.safeParse(JSON.parse(readFileSync(uiSettingsFile(home), "utf8")));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function uiSettingsMethods(o: { home: string; emit?: (event: { type: string; [key: string]: unknown }) => void }): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.uiSettings.name]: handler(M.uiSettings, () => readUiSettings(o.home)),
    [M.uiSet.name]: handler(M.uiSet, ({ patch }, ctx) => {
      const c = ctx.caller;
      const fromClover = c.kind === "plugin" && (c.pluginId === "clover" || c.pluginId.startsWith("clover/"));
      if (c.kind !== "user" && !fromClover) throw new ContractError("refused", "a layer's UI change is a card, which waits for the approval broker (C-M3)");
      const tokens = patch.overrides?.tokens;
      if (tokens !== undefined) {
        const bad = Object.entries(tokens).filter(([name, value]) => !isValueForToken(name, value)).map(([name]) => name);
        if (bad.length > 0) throw new ContractError("invalid", `these token overrides don't fit their tokens: ${bad.slice(0, 10).join(", ")}`);
      }
      if (patch.overrides?.css !== undefined && patch.overrides.css.trim() !== "") {
        throw new ContractError("refused", "CSS overrides aren't served on this computer yet: the theme cleaner isn't on main");
      }
      // `overrides` merges by part (#333's review): a patch of `tokens` keeps the stored `css`, and the reverse.
      const current = readUiSettings(o.home);
      const overrides = patch.overrides === undefined ? current.overrides : { ...(current.overrides ?? {}), ...patch.overrides };
      const next = UiSettings.parse({ ...current, ...patch, ...(overrides !== undefined ? { overrides } : {}) });
      const file = uiSettingsFile(o.home);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      o.emit?.({ type: APP_EVENTS.uiSettingsChanged.type, settings: next });
      return { applied: true as const };
    }),
  };
}
