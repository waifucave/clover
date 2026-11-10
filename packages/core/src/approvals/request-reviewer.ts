// The safety reviewer behind "ask for risky actions" (§9.1: "Winter's auto with the reviewer"), as the broker asks it:
// the daemon's one `BashReviewer` (internal-jobs model), the one the computer node already judges other computers'
// calls with. What reaches it is only what is left after the level table: an ordinary file, a page the session already
// saw and an admitted agent run without it, so a model call is spent only where it is unclear.
//
// It is shown what the card shows, never more: a command as a command, a change as its paths, a fetch or another tool
// as a short line. `safe` only on its own safe verdict; `risky` on unsafe; `unavailable` (so a card, as before) with
// no reviewer, no model that can run, or any failure: it fails closed.
import type { ApprovalRequest, Reviewer } from "../contracts/approval-broker";
import type { ReviewInput } from "../agent/reviewer";
import type { SafetyReviewer } from "../computers/node-parts";
import { plainOf } from "./strings";

const PRECIS_MAX = 600;

function cut(s: string): string {
  const p = Array.from(plainOf(s));
  return p.length > PRECIS_MAX ? `${p.slice(0, PRECIS_MAX - 1).join("")}…` : p.join("");
}

/** A sealed field as plain text. */
function fieldText(req: ApprovalRequest, name: keyof ApprovalRequest["fields"]): string | undefined {
  const f = req.fields[name];
  if (f === undefined) return undefined;
  switch (f.type) {
    case "text": return f.text;
    case "code": return f.code;
    case "list": return f.items.join("\n");
    case "rows": return f.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
  }
}

/** Who asks, in the reviewer's justification line. */
function asker(req: ApprovalRequest): string {
  const where = req.computers.length > 0 ? ` on ${req.computers.join(", ")}` : "";
  if (req.kind === "agent-permission") return `An agent${req.bot === undefined ? " the user started" : ` started by the bot ${req.bot}`}${where} asks.`;
  return `${req.bot === undefined ? "The user's session" : `The bot ${req.bot}`}${where} asks.`;
}

/** What the reviewer is shown for one request. */
export function reviewInputOf(req: ApprovalRequest): ReviewInput {
  const raw = req.agent?.rawInput as { command?: unknown } | undefined;
  const command = typeof raw?.command === "string" ? raw.command : req.effect === "execute" ? fieldText(req, "command") : undefined;
  if (req.effect === "execute" && command !== undefined) return { class: "bash", command, justification: asker(req) };
  if ((req.effect === "edit" || req.effect === "move" || req.effect === "delete") && req.paths?.length) {
    return { class: "fs", precis: cut(`${req.effect} ${req.paths.slice(0, 20).join(", ")}${req.paths.length > 20 ? ` and ${req.paths.length - 20} more` : ""} (${asker(req)})`) };
  }
  const what = [fieldText(req, "title"), fieldText(req, "what"), fieldText(req, "command"), fieldText(req, "detail")].filter((x) => x !== undefined).join(" ");
  return { class: "external", precis: cut(`${req.effect}: ${what} (${asker(req)})`) };
}

/** The broker's reviewer over the daemon's `SafetyReviewer` (none: always `unavailable`). */
export function requestReviewer(reviewer: SafetyReviewer | undefined, log?: (line: string) => void): Reviewer {
  return async (req) => {
    if (reviewer === undefined) return "unavailable";
    try {
      const v = await reviewer.review(reviewInputOf(req));
      return v.verdict === "safe" ? "safe" : "risky";
    } catch (e) {
      log?.(`the safety reviewer couldn't judge a ${req.effect} request, so it asks the user: ${e instanceof Error ? e.message : String(e)}`);
      return "unavailable";
    }
  };
}
