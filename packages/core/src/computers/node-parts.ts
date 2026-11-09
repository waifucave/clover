// The computer node's own parts in the daemon (lane J; the controller's wiring ruling): what `startDaemonParts`
// hands `startComputerNode` beyond its links, built here so the daemon's file holds one block.
//
// * Terminals: a paste of several lines raises a `confirm` card through the approval broker (`pasteCardRequest`).
//   Until the daemon's broker exists the node gets none, and such a paste is refused with a reason the panel shows
//   (`PASTE_CANT_ASK`, tree/terminals.ts), never dropped silently.
// * The safety reviewer, for another computer's calls here at "ask for risky actions" (R1): the daemon's `BashReviewer` (agent/reviewer.ts),
//   with the internal-jobs model and credentials the daemon already resolves for it (docs/claude/internal-jobs.md),
//   adapted to the node's `PeerReviewer` (`peerReviewer`). It fails closed: no reviewer, no runnable model, a timeout or
//   any other failure is `unavailable`, which needs the user's answer; it never passes a call by default.
// * The executor, for Bash on this computer's tree (its own sessions' and another computer's `tool.run`): lane C's fenced
//   process (`fencedSpawner`, C-M2 part 2) under `fencedExecutor`, when the daemon hands over its spawner. Without one
//   the node gets no executor, and such a call is refused ("no executor"); it never runs unsandboxed.
// * Answers, for another computer's call that needs the user's answer here (R1, R15): this computer's paired devices
//   check the signature, the card ids used are kept on disk (`FileAnswerLedger`, `levels/used-answers.json`), and
//   this computer's own call cards (`callCardRenderer`) are what an answer's card must match.
// * askUser, the calling computer's side (R1): another computer's card, raised as it is through the approval broker,
//   and the device's signature that approved it handed back (`brokerAsker`). Without a broker (or one without `get`),
//   none: such a call stays refused.
// * Not here: the fence (the daemon's one CloverFence, passed in the node options, which the spawner is built on) and
//   MCP (lane A's host).
import type { Caller, Os, TurnOrigin } from "@waifucave/clover-protocol";
import type { ReviewInput, ReviewVerdict } from "../agent/reviewer";
import type { CloverApprovalRequest } from "../approvals/broker";
import { plainOf } from "../approvals/strings";
import { createHash } from "node:crypto";
import type { AnswerDevices, ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { brokerAsker } from "./ask-user";
import { callCardRenderer } from "./call-cards";
import { FileAnswerLedger, usedAnswersPath } from "./store";
import type { FencedSpawner } from "../fence/spawn";
import type { PeerReviewer } from "../tree/judge";
import { hostOs } from "../tree/names";
import { fencedExecutor } from "./fenced-executor";
import type { ComputerNodeOptions } from "./node";

/** Clover's own words for the paste card. */
export const PASTE_CARD_TEXT = {
  title: "Paste several lines",
  what: "Paste these lines into the terminal? A shell runs each line as a command.",
  yes: "Paste",
  no: "Don't paste",
  more: (n: number) => `…and ${n} more line${n === 1 ? "" : "s"}`,
} as const;

/** The most lines the card shows, and the longest line. */
export const PASTE_CARD_LINES = 200;
export const PASTE_CARD_LINE_MAX = 4000;

/** The broker's request for a paste of several lines into terminal `terminalId` on `computer`: a `confirm` card (always
 *  a card, never an "always", denied after 10 minutes unanswered), each line of the paste on its own, its hiding
 *  characters out. */
export function pasteCardRequest(text: string, o: { computer: string; terminalId: string; origin?: TurnOrigin }): CloverApprovalRequest {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((l) => {
    const p = Array.from(plainOf(l));
    return p.length > PASTE_CARD_LINE_MAX ? `${p.slice(0, PASTE_CARD_LINE_MAX - 1).join("")}…` : p.join("");
  });
  const shown = lines.length > PASTE_CARD_LINES ? [...lines.slice(0, PASTE_CARD_LINES - 1), PASTE_CARD_TEXT.more(lines.length - PASTE_CARD_LINES + 1)] : lines;
  return {
    kind: "confirm", origin: o.origin ?? "user", computers: [o.computer], effect: "execute",
    options: [{ id: "approve", kind: "approve", label: PASTE_CARD_TEXT.yes }, { id: "deny", kind: "deny", label: PASTE_CARD_TEXT.no }],
    fields: {
      title: { type: "text", text: PASTE_CARD_TEXT.title },
      what: { type: "text", text: PASTE_CARD_TEXT.what },
      computer: { type: "code", code: JSON.stringify(plainOf(o.computer)) },
      command: { type: "list", items: shown },
    },
  };
}

/** The terminals' `confirmPaste` through the broker: true only when the person approved the card. */
export function confirmPasteVia(broker: Pick<ApprovalBroker, "request">, computer: () => string): (text: string, terminalId: string) => Promise<boolean> {
  return async (text, terminalId) => (await broker.request(pasteCardRequest(text, { computer: computer(), terminalId }))).allowed;
}

/** What the reviewer needs: the daemon's `BashReviewer` (agent/reviewer.ts), or anything with its `review`. */
export interface SafetyReviewer {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewVerdict>;
}

const PRECIS_MAX = 600;
const cut = (s: string) => {
  const p = Array.from(plainOf(s));
  return p.length > PRECIS_MAX ? `${p.slice(0, PRECIS_MAX - 1).join("")}…` : p.join("");
};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const who = (as: Caller) => (as.kind === "peer" ? `another of the user's computers (device ${as.device})` : `a ${as.kind} caller`);

/** What the reviewer is shown for one call: a Bash command as a command, another tool as an external call (its name
 *  and a slice of its input), and a change to the folder tree as a write target (its paths and size, never its
 *  content). */
export function reviewInputFor(call: Parameters<PeerReviewer>[0]): ReviewInput {
  const p = (call.params ?? {}) as Record<string, unknown>;
  const why = `Asked of ${call.computer} by ${who(call.as)}.`;
  if (call.method === "tool.run") {
    const tool = str(p.tool) ?? "unknown";
    const input = (p.input ?? {}) as Record<string, unknown>;
    if (tool === "Bash" && typeof input.command === "string") return { class: "bash", command: input.command, justification: why };
    return { class: "external", precis: cut(`${tool} ${JSON.stringify(input)} (${why})`) };
  }
  const paths = ["path", "from", "to", "target", "source", "destination"]
    .flatMap((k) => (str(p[k]) !== undefined ? [`${k}: ${str(p[k])}`] : typeof p[k] === "object" && p[k] && str((p[k] as { path?: unknown }).path) ? [`${k}: ${(p[k] as { path: string }).path}`] : []));
  const data = p.data as { text?: unknown; base64?: unknown } | undefined;
  const size = typeof data?.text === "string" ? `, ${data.text.length} characters` : typeof data?.base64 === "string" ? `, ${Math.floor((data.base64.length * 3) / 4)} bytes` : "";
  return { class: "fs", precis: cut(`${call.method} ${paths.join(", ")}${size} (${why})`) };
}

/** The node's reviewer for another computer's calls at "ask for risky actions": `safe` only on the reviewer's own
 *  safe verdict; `risky` on unsafe; `unavailable` (the user's answer, then) with no reviewer, no runnable model, or any
 *  failure: it fails closed. */
export function peerReviewer(reviewer: SafetyReviewer | undefined, log?: (line: string) => void): PeerReviewer {
  return async (call) => {
    if (!reviewer) return "unavailable";
    try {
      const v = await reviewer.review(reviewInputFor(call));
      return v.verdict === "safe" ? "safe" : "risky";
    } catch (e) {
      log?.(`the safety reviewer couldn't judge ${call.method} from another computer, so it needs the user's answer: ${e instanceof Error ? e.message : String(e)}`);
      return "unavailable";
    }
  };
}

/** The node's own parts: its terminals' paste card (when there is a broker), its safety reviewer, and the broker's
 *  own record of a card for a level raise (`cardRecord`, #342): always given, so with no broker it finds no card and
 *  no card raises a level (fails closed); the registry judges the raise on that record, never the caller's copy. */
export function nodeParts(o: {
  computer: () => string;
  approvals?: Pick<ApprovalBroker, "request" | "get">;
  reviewer?: SafetyReviewer;
  /** Lane C's fenced process on this computer (`fencedSpawner({ fence })`) and the user's home: the node's Bash. */
  bash?: { spawner: FencedSpawner; home: string; temp?: string; cloverHome?: string; os?: Os };
  /** This computer's paired devices and its Clover home: the node takes another computer's signed answers. */
  answers?: { devices: AnswerDevices; cloverHome: string; clock: Pick<Clock, "now"> };
  log?: (line: string) => void;
}): Pick<ComputerNodeOptions, "terminals" | "reviewer" | "cardRecord" | "executor" | "answers" | "askUser"> {
  const approvals = o.approvals;
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    ...(approvals && typeof approvals.get === "function" ? { askUser: brokerAsker({ broker: approvals, ...(o.log ? { log: o.log } : {}) }) } : {}),
    ...(o.answers ? { answers: { devices: o.answers.devices, ledger: new FileAnswerLedger(usedAnswersPath(o.answers.cloverHome), o.answers.clock), render: callCardRenderer(sha256) } } : {}),
    ...(o.bash ? { executor: fencedExecutor({ spawner: o.bash.spawner, home: o.bash.home, ...(o.bash.temp === undefined ? {} : { temp: o.bash.temp }), ...(o.bash.cloverHome === undefined ? {} : { cloverHome: o.bash.cloverHome }), os: o.bash.os ?? hostOs() }) } : {}),
    terminals: approvals ? { confirmPaste: confirmPasteVia(approvals, o.computer) } : {},
    reviewer: peerReviewer(o.reviewer, o.log),
    // A broker (or a late-bound proxy for one) without `get` finds no card: a clean "no such card", not a TypeError.
    cardRecord: (id) => (typeof approvals?.get === "function" ? approvals.get(id) : undefined),
  };
}
