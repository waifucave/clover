// Every conversation state the gallery shows. Each story is plain data rendered through the real
// components, with the mock runtime drawing what the core would (sealed frames, MCP Apps views).
import type { ReactNode } from "react";
import { ConversationView, type ConversationViewProps } from "../client/ConversationView";
import type { MessageContext } from "../client/context";
import { QuestionMessage } from "../client/messages/QuestionMessage";
import { ThinkingRow } from "../client/messages/ThinkingRow";
import { UiRuntimeProvider } from "../client/sdk";
import type { BotItem, ConversationItem, ToolCall } from "../client/types";
import {
  APPROVAL_PENDING,
  APPROVAL_STATES,
  ATTACHMENTS,
  BASIC,
  BLENDER_CALL_ID,
  BOT,
  DEVICE,
  DEVICES,
  EVENTS,
  FORMAT,
  GREETING,
  INTERRUPT,
  NOTES,
  NOW,
  QUESTION_ANSWERED,
  QUESTION_EXPIRED,
  QUESTION_FREE,
  QUESTION_MULTI,
  QUESTION_PREVIEW,
  QUESTION_SINGLE,
  SEALED_CARDS,
  STATUS_RETRYING,
  STREAMING,
  THINKING,
  TOOL_APPS,
  TOOLS,
  TOOLS_OPEN,
  at,
  longConversation,
  thinking,
} from "./fixtures";
import { MockChart, mockRuntime } from "./mock-runtime";
import type { Story } from "./story";

const noop = () => undefined;

const runtime = mockRuntime({
  cards: SEALED_CARDS,
  apps: Object.fromEntries(
    Object.entries(TOOL_APPS).map(([callId, app]) => [
      callId,
      {
        resourceUri: app.resourceUri,
        body: (
          <MockChart
            bars={[
              { label: "Mon", value: 412 },
              { label: "Tue", value: 388 },
              { label: "Wed", value: 506 },
              { label: "Thu", value: 297 },
              { label: "Fri", value: 301 },
            ]}
          />
        ),
      },
    ]),
  ),
});

const COMMON: Omit<ConversationViewProps, "items"> = {
  bot: BOT,
  now: NOW,
  device: DEVICE,
  format: FORMAT,
  onAnswerQuestion: noop,
  onOpenLink: noop,
  onOpenFile: noop,
  onOpenDiff: noop,
  onOpenThread: noop,
  onOpenAgent: noop,
  onCopy: noop,
};

function View(props: Partial<ConversationViewProps> & { items: readonly ConversationItem[] }) {
  return (
    <UiRuntimeProvider runtime={runtime}>
      <ConversationView {...COMMON} {...props} />
    </UiRuntimeProvider>
  );
}

/** Message parts on their own, in the conversation's column, for states a whole view cannot hold
 *  still (an opened row, a half-made answer). */
function Parts({ children }: { children: ReactNode }) {
  return (
    <UiRuntimeProvider runtime={runtime}>
      <div className="cl-conv" style={{ height: "auto" }}>
        <div className="cl-conv__column">{children}</div>
      </div>
    </UiRuntimeProvider>
  );
}

const CTX: MessageContext = { botName: BOT.name, now: NOW, format: FORMAT, device: DEVICE, turnLive: false, actions: COMMON };

/** The `tool.result` spot in use: a plugin draws its own tool's result. */
function blenderResult(call: ToolCall): ReactNode | undefined {
  if (call.callId !== BLENDER_CALL_ID) return undefined;
  return (
    <figure className="story-render">
      <div className="story-render__image" aria-label="island-preview.png" />
      <figcaption>island-preview.png · 1920 × 1080 · drawn by the Blender plugin</figcaption>
    </figure>
  );
}

/** The `conversation.message` spot in use: a visual-novel speech box for the bot, plus an add-on
 *  under every message (`conversation.message.extra`). */
function SpeechBox({ item }: { item: BotItem; ctx: MessageContext; final?: boolean }) {
  return (
    <div className="story-speech">
      <div className="story-speech__name">{BOT.name}</div>
      <div className="story-speech__text">{item.text}</div>
    </div>
  );
}

export const stories: Story[] = [
  { id: "conversation/empty", title: "A new conversation", render: () => <View items={[]} /> },
  { id: "conversation/greeting", title: "The bot's greeting", render: () => <View items={GREETING} /> },
  {
    id: "conversation/basic",
    title: "An exchange, across two days",
    notes: "Markdown: headings, lists, quotes, a table, a code block with copy, links. The last message came from the phone.",
    render: () => <View items={BASIC} />,
  },
  {
    id: "conversation/streaming",
    title: "An answer streaming in",
    notes: "A live thinking row, tool calls, and the answer arriving mid code block with the caret.",
    render: () => <View items={STREAMING} turn={{ running: true, phase: "thinking" }} />,
  },
  {
    id: "conversation/thinking",
    title: "Thinking titles",
    notes: "Titled, untitled and hidden blocks once done; a live one breathing while the turn runs.",
    render: () => <View items={THINKING} turn={{ running: true, phase: "thinking" }} />,
  },
  {
    id: "conversation/thinking-open",
    title: "A thinking row opened",
    render: () => (
      <Parts>
        <OpenThinking />
      </Parts>
    ),
  },
  {
    id: "conversation/tools",
    title: "Tool runs in every state",
    notes: "Grouped runs, outputs cut at 40 lines, diffs, web sites, an MCP Apps page, a plugin's own result view (tool.result), a failure, an interruption, and a call under the safety check.",
    render: () => (
      <View items={TOOLS} turn={{ running: true, phase: "working" }} initialExpanded={TOOLS_OPEN} renderToolResult={blenderResult} />
    ),
  },
  {
    id: "conversation/approval",
    title: "An approval waiting for the user",
    notes: "Every word inside the card is a sealed frame the core draws; the plugin only places them.",
    render: () => <View items={APPROVAL_PENDING} turn={{ running: true, phase: "waiting" }} />,
  },
  {
    id: "conversation/approval-states",
    title: "Approvals after the fact, and one with a deadline",
    notes: "Approved on the phone, denied, expired, withdrawn by an interrupt; a routine's card is denied after 10 minutes.",
    render: () => <View items={APPROVAL_STATES} />,
  },
  {
    id: "conversation/questions",
    title: "Questions waiting for an answer",
    notes: "One choice; several questions with chips and a multi-select; free text with a deadline.",
    render: () => <View items={[QUESTION_SINGLE, QUESTION_MULTI, QUESTION_FREE]} turn={{ running: true, phase: "waiting" }} />,
  },
  {
    id: "conversation/question-states",
    title: "A half-made answer with a preview, answered, expired",
    render: () => (
      <Parts>
        <QuestionMessage item={QUESTION_PREVIEW} ctx={CTX} initialDraft={[{ selected: ["Stage left"], other: "" }]} />
        <QuestionMessage item={QUESTION_ANSWERED} ctx={CTX} />
        <QuestionMessage item={QUESTION_EXPIRED} ctx={CTX} />
      </Parts>
    ),
  },
  {
    id: "conversation/events",
    title: "Routines, background agents and other bots",
    notes: "Routine results from side threads; an agent reporting mid-work; another bot's message; finished, stalled and command notifications.",
    render: () => <View items={EVENTS} />,
  },
  {
    id: "conversation/notes",
    title: "Notes",
    notes: "A compaction divider, the core's notices, a plugin's note, a hook's warning, an error.",
    render: () => <View items={NOTES} />,
  },
  {
    id: "conversation/interrupt",
    title: "The user interrupts",
    notes: "The answer, the running command and the pending card stop at once; the new message starts the next step.",
    render: () => <View items={INTERRUPT} turn={{ running: true, phase: "thinking" }} />,
  },
  {
    id: "conversation/devices",
    title: "Messages from other devices",
    notes: "From the phone and the web page; a message that arrived late keeps its send time.",
    render: () => <View items={DEVICES} />,
  },
  {
    id: "conversation/status",
    title: "The turn's status line",
    notes: "A provider retry, a compaction, waiting on the user.",
    render: () => (
      <div className="story-stack">
        {(
          [
            { running: true, phase: "retrying", retry: { attempt: 3, maxRetries: 10, status: 529 } },
            { running: true, phase: "compacting" },
            { running: true, phase: "waiting" },
          ] as const
        ).map((turn) => (
          <View key={turn.phase} items={STATUS_RETRYING} turn={turn} />
        ))}
      </div>
    ),
  },
  {
    id: "conversation/attachments",
    title: "A message with images and a file",
    render: () => <View items={ATTACHMENTS} />,
  },
  {
    id: "conversation/long",
    title: "Scrolled up in a long conversation",
    notes: "Older messages load on demand; new output below offers the way back without moving the reader.",
    height: 420,
    render: () => <View items={longConversation()} hasEarlier onLoadEarlier={noop} initialFollow={false} />,
  },
  {
    id: "conversation/replaced-parts",
    title: "Parts replaced by a plugin",
    notes: "A plugin fills conversation.message for `bot` with a speech box, and adds a line under every message.",
    render: () => (
      <View
        items={BASIC.slice(2)}
        renderers={{ bot: SpeechBox }}
        renderMessageExtra={(item) => (item.kind === "bot" ? <span className="story-extra">♡ 2 reactions</span> : null)}
      />
    ),
  },
];

function OpenThinking() {
  const items = [
    thinking(at(0, 15, 2), {
      title: "Mapping what the old sync stores",
      durationMs: 12_400,
      text: "The old sync keeps a cursor per device and a pending queue.\n\nThe new one keeps an append-only log with a lease epoch per event, so the cursor maps onto the last seen sequence number and the queue becomes unsent events.",
      truncated: true,
    }),
    thinking(at(0, 15, 3), { reasoning: "hidden", durationMs: 3_100 }),
  ];
  return (
    <>
      {items.map((item) => (
        <ThinkingRow key={item.id} item={item} ctx={CTX} defaultOpen />
      ))}
    </>
  );
}
