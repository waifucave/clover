// Every bot editor state the gallery shows.
import { useState } from "react";
import { BotEditor } from "../client/BotEditor";
import type { BotEditorProps, BotField } from "../client/types";
import { ALPHA, AVATARS, MODELS, THEMES } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** The editor over the fixtures, its picks kept in the story. */
export function BotEditorDemo({ own = [], avatars = AVATARS, waiting }: { own?: BotField[]; avatars?: BotEditorProps["avatars"]; waiting?: BotField }) {
  const [state, setState] = useState({ own, model: "openai/gpt-6", effort: "medium", avatar: own.includes("avatar") ? AVATARS[1]!.file : undefined, theme: own.includes("theme") ? THEMES[1]!.id : undefined });
  return (
    <BotEditor
      bot={ALPHA}
      own={state.own}
      model={{ value: state.model, effort: state.effort, models: MODELS }}
      voice={{ provider: "Fish Audio", voice: "Alpha" }}
      avatars={avatars}
      {...(state.avatar ? { avatar: state.avatar } : {})}
      themes={THEMES}
      {...(state.theme ? { theme: state.theme } : {})}
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
            ...(patch.avatar ? { avatar: patch.avatar.file } : patch.avatar === null ? { avatar: undefined } : {}),
            ...(typeof patch.theme === "string" ? { theme: patch.theme } : patch.theme === null ? { theme: undefined } : {}),
          };
        })
      }
      onBack={noop}
    />
  );
}

export const botEditorStories: Story[] = [
  { id: "bot-editor/plugin-defaults", title: "The bot editor, nothing changed yet", notes: "Every field is the bot's plugin's; nothing to reset.", width: 900, height: 980, render: () => <BotEditorDemo /> },
  { id: "bot-editor/user-layer", title: "Some fields set by the user", notes: "The avatar, the theme and the instructions are the user's own, each with Reset.", width: 900, height: 980, render: () => <BotEditorDemo own={["avatar", "theme", "instructions"]} /> },
  { id: "bot-editor/no-packs", title: "No avatar packs installed", notes: "The avatar row says where packs come from.", width: 900, height: 820, render: () => <BotEditorDemo avatars={[]} /> },
  { id: "bot-editor/waiting", title: "A change waiting on a card", notes: "The model change came back as a card: the row says so until it is answered.", width: 900, height: 820, render: () => <BotEditorDemo waiting="model" /> },
];
