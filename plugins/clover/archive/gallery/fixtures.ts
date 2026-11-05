// Mocked old Winter sessions (lane B's `ArchivedSessionView`) and one's events, for the gallery and the tests.
import type { ArchivedSessionView } from "../../shell/runtime/types";

/** Thursday, November 5, 2026, 16:30 UTC (the gallery's clock). */
export const NOW = Date.UTC(2026, 10, 5, 16, 30);
const day = (d: number, h = 12) => Date.UTC(2026, 10, 5 - d, h);

export const ARCHIVED: ArchivedSessionView[] = [
  { id: "w-1", title: "Release notes for 0.123", mode: "code", project: "/Users/sam/projects/winter", model: "openai/gpt-5.5", createdAt: day(3, 9), updatedAt: day(3, 11), messages: 42 },
  { id: "w-2", title: "Trip to Kyoto: what to book first", mode: "chat", model: "anthropic/claude-sonnet-5", createdAt: day(6), updatedAt: day(6, 14), messages: 18 },
  { id: "w-3", title: "Clean up the Downloads folder", mode: "dispatch", createdAt: day(9), updatedAt: day(9, 13), messages: 7 },
  { id: "w-4", title: "Profile the daemon's idle wakeups", mode: "code", project: "/Users/sam/projects/winter", model: "openai/gpt-5.5", createdAt: day(14), updatedAt: day(14, 18), messages: 63 },
  { id: "w-5", mode: "chat", createdAt: day(400), updatedAt: day(400), messages: 2 },
];

/** w-1's transcript, as `archive.history` returns it: the inherited events, with an old approval. */
export const HISTORY: Record<string, unknown>[] = [
  { type: "user_message", seq: 1, ts: day(3, 9), text: "Draft the release notes for 0.123 from the merged PRs." },
  { type: "turn_started", seq: 2, ts: day(3, 9) },
  { type: "tool_call", seq: 3, ts: day(3, 9), callId: "c1", name: "Bash", argsJson: JSON.stringify({ command: "gh pr list --state merged --limit 30" }) },
  { type: "approval_requested", seq: 4, ts: day(3, 9), toolName: "Bash", summary: "gh pr list --state merged --limit 30" },
  { type: "approval_resolved", seq: 5, ts: day(3, 9), approved: true },
  { type: "tool_result", seq: 6, ts: day(3, 9), callId: "c1", output: "#412 Image input in code mode\n#409 SDK 0.0.36\n#401 Tool-result images" },
  { type: "assistant_message", seq: 7, ts: day(3, 9), text: "Here's a draft:\n\n- **Images in code mode.** Paste an image and the agent sees it.\n- Tool results can carry images (SDK 0.0.36).\n\nWant me to add the fixes too?" },
  { type: "turn_completed", seq: 8, ts: day(3, 9), stopReason: "end_turn" },
];
