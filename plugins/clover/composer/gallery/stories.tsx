// Every composer state the gallery shows.
import { useState, type ReactNode } from "react";
import { Composer } from "../client/Composer";
import { CLOVER_LEVELS, DEFAULT_LEVEL } from "../client/levels";
import type { ComposerAttachment, ComposerLevel, ComposerModelChoice, ComposerProps } from "../client/types";
import type { Story } from "./story";

const noop = () => undefined;

export const MODELS: ComposerModelChoice = {
  model: "openai/gpt-6",
  effort: "medium",
  models: [
    { id: "openai/gpt-6", label: "GPT-6", detail: "OpenAI" },
    { id: "xai/grok-5", label: "Grok 5", detail: "xAI" },
    { id: "moonshot/kimi-k3", label: "Kimi K3", detail: "Moonshot" },
    { id: "studio/qwen-4", label: "Qwen 4", detail: "On Studio" },
  ],
  efforts: ["low", "medium", "high", "max"],
  onChange: noop,
};

export const LEVEL: ComposerLevel = { level: DEFAULT_LEVEL, levels: CLOVER_LEVELS, onChange: noop };

function swatch(a: string, b: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="56" height="56" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const ATTACHMENTS: ComposerAttachment[] = [
  { id: "a1", kind: "image", name: "island-a.png", path: "home/Studio/Desktop/island-a.png", previewUrl: swatch("#8ccbf0", "#2b5d7d") },
  { id: "a2", kind: "image", name: "island-b.png", path: "home/Studio/Desktop/island-b.png", previewUrl: swatch("#f3c4d8", "#7d2b55") },
  { id: "a3", kind: "file", name: "notes-from-the-design-review.md", path: "home/Studio/Desktop/notes-from-the-design-review.md" },
];

/** A composer holding its own draft, so the gallery page can be typed into. */
function Demo(props: Partial<ComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? "");
  const [attachments, setAttachments] = useState(props.attachments ?? []);
  return (
    <Composer
      botName="Alpha"
      value={value}
      onChange={setValue}
      onSend={() => setValue("")}
      onAttach={noop}
      onRemoveAttachment={(id) => setAttachments((all) => all.filter((a) => a.id !== id))}
      onAddFiles={noop}
      onStop={noop}
      model={MODELS}
      level={LEVEL}
      voice={{ listening: false, onPressStart: noop, onPressEnd: noop }}
      {...props}
      attachments={attachments}
    />
  );
}

/** The composer at the bottom of a frame, where it lives. */
function Bottom({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>{children}</div>;
}

const many: ComposerAttachment[] = Array.from({ length: 21 }, (_, i) => ({ id: `m${i}`, kind: "file", name: `scan-${i + 1}.pdf` }));

export const stories: Story[] = [
  { id: "composer/empty", title: "Empty", render: () => <Demo /> },
  {
    id: "composer/draft",
    title: "A draft over several lines",
    render: () => <Demo initial={"Can you look at the island tab?\nThe badge overlaps the notch on the 14-inch screen,\nand the Usage tab still shows yesterday."} />,
  },
  { id: "composer/attachments", title: "Images and a file attached", render: () => <Demo initial="Which of these reads better?" attachments={ATTACHMENTS} /> },
  { id: "composer/too-many", title: "Too many attachments", render: () => <Demo attachments={many} /> },
  { id: "composer/running", title: "While the bot works, nothing typed", notes: "The round button stops the turn.", render: () => <Demo running /> },
  {
    id: "composer/running-draft",
    title: "While the bot works, with a draft",
    notes: "Sending interrupts at once; Stop stands beside it.",
    render: () => <Demo running initial="Actually, use the staging database." />,
  },
  {
    id: "composer/asleep",
    title: "The bot is asleep",
    notes: "No computer running the bot can be reached: the draft stays and sending waits.",
    render: () => <Demo initial="Remind me to call the bank tomorrow." asleep={{ reason: "Studio can't be reached" }} />,
  },
  {
    id: "composer/model-menu",
    title: "Picking the model and effort",
    notes: "The menu opens inside the composer, above the box: it never lies over the conversation, where a card's buttons may sit. The next turn uses the choice.",
    render: () => (
      <Bottom>
        <Demo initialMenu="model" />
      </Bottom>
    ),
  },
  {
    id: "composer/level-menu",
    title: "Picking the approval level",
    notes: "Clover's five levels (spec §9.1), ask-when-risky the default.",
    render: () => (
      <Bottom>
        <Demo initialMenu="level" />
      </Bottom>
    ),
  },
  {
    id: "composer/card-pending",
    title: "While a card waits",
    notes: "With a sealed card in the conversation, the pills wait and no menu opens.",
    render: () => <Demo cardPending running initial="" />,
  },
  {
    id: "composer/listening",
    title: "Holding to talk",
    render: () => <Demo voice={{ listening: true, onPressStart: noop, onPressEnd: noop }} />,
  },
  {
    id: "composer/minimal",
    title: "With no attach, model, level or voice",
    notes: "A bot with no voice plugin, in a host that offers nothing else.",
    render: () => <Demo model={undefined} level={undefined} voice={undefined} onAttach={undefined} />,
  },
  {
    id: "composer/replaced-action",
    title: "A plugin dressing one button",
    notes: "composer.action in use: the voice button replaced, attach hidden.",
    render: () => (
      <Demo
        renderAction={(id, standard) =>
          id === "voice" ? (
            <button type="button" className="story-suggest">
              ✦ Suggest
            </button>
          ) : id === "attach" ? null : (
            standard
          )
        }
      />
    ),
  },
];
