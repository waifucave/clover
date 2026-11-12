// Every bot editor state the gallery shows.
import { useState } from "react";
import { BotEditor } from "../client/BotEditor";
import type { BotField } from "../client/types";
import { ALPHA, MODELS, THEMES } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** The editor over the fixtures, its picks kept in the story. */
export function BotEditorDemo({ own = [], waiting }: { own?: BotField[]; waiting?: BotField }) {
  const lanOn = own.includes("lan");
  const [state, setState] = useState({ own, model: "openai/gpt-6", effort: "medium", theme: own.includes("theme") ? THEMES[1]!.id : undefined, lan: lanOn });
  return (
    <BotEditor
      bot={ALPHA}
      own={state.own}
      model={{ value: state.model, effort: state.effort, models: MODELS }}
      voice={{ provider: "Fish Audio", voice: "Alpha" }}
      themes={THEMES}
      {...(state.theme ? { theme: state.theme } : {})}
      lan={state.lan}
      {...(waiting ? { waiting } : {})}
      onChange={(patch) =>
        setState((s) => {
          const fields = Object.keys(patch) as BotField[];
          const cleared = fields.filter((f) => patch[f] === null);
          return {
            ...s,
            own: [...s.own.filter((f) => !cleared.includes(f)), ...fields.filter((f) => patch[f] !== null && !s.own.includes(f))],
            ...(typeof patch.model === "string" ? { model: patch.model } : {}),
            ...(typeof patch.effort === "string" ? { effort: patch.effort } : {}),
            ...(typeof patch.theme === "string" ? { theme: patch.theme } : patch.theme === null ? { theme: undefined } : {}),
            ...(patch.lan !== undefined ? { lan: patch.lan === true } : {}),
          };
        })
      }
      onBack={noop}
    />
  );
}

export const botEditorStories: Story[] = [
  { id: "bot-editor/plugin-defaults", title: "The bot editor, nothing changed yet", notes: "Every field is the bot's plugin's; nothing to reset.", width: 900, height: 1060, render: () => <BotEditorDemo /> },
  { id: "bot-editor/user-layer", title: "Some fields set by the user", notes: "The theme and the instructions are the user's own, each with Reset.", width: 900, height: 1060, render: () => <BotEditorDemo own={["theme", "instructions"]} /> },
  { id: "bot-editor/lan-on", title: "The LAN switch on", notes: "The bot's browser tabs may reach the local network; the switch is the whole field, so it has no Reset.", width: 900, height: 1060, render: () => <BotEditorDemo own={["lan"]} /> },
  { id: "bot-editor/waiting", title: "A change waiting on a card", notes: "The model change came back as a card: the row says so until it is answered.", width: 900, height: 900, render: () => <BotEditorDemo waiting="model" /> },
];
