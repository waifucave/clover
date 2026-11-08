// The cloud computer cards (spec §9.2; lane J's `CloudCard`, computers/cloud.ts) as sealed cards through the broker
// (C-M3, the controller's ruling of November 7). Each is a `change` card (`computer-create`, `computer-resize`,
// `computer-delete`, `device-add` for pairing again, `main-computer`), so it is never remembered: no "always" (rule 1), answered on its own each time.
//
// What the card says: its title, question and buttons are Clover's own table strings (`text`). Every name and id comes
// from the user's settings or a provider plugin (a folder, a provider, a server id, a region, a size), so they go in a
// `code` field, the hiding characters out (`plainOf`), never in a sentence (#267's review, item 5).
//
// A second VM with a folder's label (`cloud-duplicate`, J's #284) says whether each VM's device is paired, and offers
// to delete the duplicate only when the VM Clover keeps ranks strictly above it (`deletable`); otherwise the card only
// reports both VMs, with nothing to delete.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import type { ApprovalBroker, ApprovalRequest } from "../contracts/approval-broker";
import type { CloverApprovalRequest } from "./broker";
import { plainOf } from "./strings";

/** One VM a duplicate card names. */
export interface CloudVmRef {
  serverId: string;
  region?: string;
  /** Whether the device that paired with it is in the device list now. */
  paired: boolean;
}

/** J's cloud cards (`CloudCard`), with what J's #284 fix round adds to the duplicate. */
export type CloudCardRequest =
  | { kind: "cloud-create"; name: string; provider: string; size: string; region: string; folder: string }
  | { kind: "cloud-resize"; name: string; provider: string; from: string; to: string }
  | { kind: "cloud-delete"; name: string; provider: string; why: "folder-removed" | "asked" }
  | {
    kind: "cloud-duplicate"; name: string; provider: string; serverId: string; region: string;
    /** Whether this VM's device is paired. */
    paired?: boolean;
    /** The VM Clover keeps. */
    keeper?: CloudVmRef;
    /** True only when the keeper ranks strictly above this one: then, and only then, the card offers to delete it. */
    deletable?: boolean;
  }
  | { kind: "cloud-repair"; name: string; provider: string; why: "token-expired" | "main-changed" }
  | { kind: "cloud-make-main"; name: string };

/** Clover's own words for each card. */
export const CLOUD_CARD_TEXT = {
  "cloud-create": { title: "Create a cloud computer", what: "Create a cloud computer for this folder? It costs money while it exists.", yes: "Create", no: "Not now" },
  "cloud-resize": { title: "Resize a cloud computer", what: "Change this cloud computer's size? Its price changes with it.", yes: "Resize", no: "Not now" },
  "cloud-delete-folder-removed": { title: "Delete a cloud computer", what: "Its folder was removed. Delete this cloud computer and its disk?", yes: "Delete", no: "Keep it" },
  "cloud-delete-asked": { title: "Delete a cloud computer", what: "Delete this cloud computer and its disk?", yes: "Delete", no: "Keep it" },
  "cloud-duplicate": { title: "A second cloud computer", what: "A second cloud computer for this folder exists. Delete it?", yes: "Delete it", no: "Keep both" },
  "cloud-duplicate-report": {
    title: "A second cloud computer",
    what: "A second cloud computer for this folder exists. Clover can't tell which one to keep, so it deletes neither; check both with the provider.",
    ok: "OK",
  },
  "cloud-repair-token-expired": { title: "Pair a cloud computer again", what: "This cloud computer didn't pair before its code expired. Pair it again?", yes: "Pair again", no: "Not now" },
  "cloud-repair-main-changed": { title: "Pair a cloud computer again", what: "The main computer changed before this cloud computer paired. Pair it again from here?", yes: "Pair again", no: "Not now" },
  "cloud-make-main": { title: "Make it the main computer", what: "Make this cloud computer the main computer? Your bots run there from then on.", yes: "Make it the main", no: "Not now" },
} as const;

const yesNo = (t: { yes: string; no: string }): NonNullable<ApprovalRequest["options"]> => [
  { id: "approve", kind: "approve", label: t.yes }, { id: "deny", kind: "deny", label: t.no },
];

/** The longest value a card line shows; a provider's longer string is cut and marked. */
export const CLOUD_VALUE_MAX = 120;

/** `key: "value"` lines in a code field: each value with its hiding characters (newlines included) out, so none makes
 *  a line of its own; cut at `CLOUD_VALUE_MAX` code points (never inside a surrogate pair); and quoted, JSON-style, so
 *  where it starts and ends is plain. */
function details(lines: readonly (readonly [string, string | undefined])[]): { type: "code"; code: string } {
  const value = (v: string) => {
    const points = Array.from(plainOf(v));
    return JSON.stringify(points.length > CLOUD_VALUE_MAX ? `${points.slice(0, CLOUD_VALUE_MAX - 1).join("")}…` : points.join(""));
  };
  return { type: "code", code: lines.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${value(v!)}`).join("\n") };
}

/** Whether each VM's device is paired: Clover's own fact, in a text field from this table, never next to a
 *  provider's string. */
export const CLOUD_PAIRED_TEXT: Record<string, string> = {
  "yes-yes": "This one's device is paired, and so is the one kept.",
  "yes-no": "This one's device is paired; the one kept's isn't.",
  "no-yes": "This one's device isn't paired; the one kept's is.",
  "no-no": "Neither one's device is paired.",
};
const pairedKey = (p: boolean | undefined) => (p === undefined ? "unknown" : p ? "yes" : "no");
const PAIRED_UNKNOWN = "Clover doesn't know whether these devices are paired.";

/** The broker's request for one cloud card. `origin`: what started it (the reconcile is the daemon's own by default).
 *  It waits for the person whatever started it (`waitsForUser`): a cloud card is never denied by a timeout, since a
 *  timeout read as "keep" would bill a duplicate forever (the controller's ruling on #290). */
export function cloudCardRequest(card: CloudCardRequest, origin: TurnOrigin = "routine"): CloverApprovalRequest {
  const base = { kind: "change" as const, origin, computers: [] as string[], effect: "other" as const, waitsForUser: true };
  const title = (t: string) => ({ type: "text" as const, text: t });
  switch (card.kind) {
    case "cloud-create": {
      const t = CLOUD_CARD_TEXT["cloud-create"];
      return { ...base, change: "computer-create", options: yesNo(t), fields: {
        title: title(t.title), what: title(t.what), computer: details([["name", card.name]]),
        detail: details([["folder", card.folder], ["provider", card.provider], ["size", card.size], ["region", card.region]]),
      } };
    }
    case "cloud-resize": {
      const t = CLOUD_CARD_TEXT["cloud-resize"];
      return { ...base, change: "computer-resize", options: yesNo(t), fields: {
        title: title(t.title), what: title(t.what), computer: details([["name", card.name]]),
        detail: details([["provider", card.provider], ["from", card.from], ["to", card.to]]),
      } };
    }
    case "cloud-delete": {
      const t = CLOUD_CARD_TEXT[card.why === "folder-removed" ? "cloud-delete-folder-removed" : "cloud-delete-asked"];
      return { ...base, change: "computer-delete", options: yesNo(t), fields: {
        title: title(t.title), what: title(t.what), computer: details([["name", card.name]]), detail: details([["provider", card.provider]]),
      } };
    }
    case "cloud-duplicate": {
      // Each provider string on its own line; whether each device is paired is Clover's, in its own text field.
      const vms = details([
        ["folder", card.name], ["provider", card.provider],
        ["this one", card.serverId], ["this one's region", card.region || undefined],
        ["the one kept", card.keeper?.serverId ?? "not known"], ["the one kept's region", card.keeper?.region || undefined],
      ]);
      const paired = CLOUD_PAIRED_TEXT[`${pairedKey(card.paired)}-${pairedKey(card.keeper?.paired)}`] ?? PAIRED_UNKNOWN;
      const deletable = card.deletable === true;
      const t = deletable ? CLOUD_CARD_TEXT["cloud-duplicate"] : CLOUD_CARD_TEXT["cloud-duplicate-report"];
      return {
        ...base, change: "computer-delete",
        // Nothing to delete unless the kept VM ranks strictly above: then one button, which answers no.
        options: deletable ? yesNo(CLOUD_CARD_TEXT["cloud-duplicate"]) : [{ id: "ok", kind: "deny", label: CLOUD_CARD_TEXT["cloud-duplicate-report"].ok }],
        fields: { title: title(t.title), what: title(t.what), reason: title(paired), detail: vms },
      };
    }
    case "cloud-repair": {
      const t = CLOUD_CARD_TEXT[card.why === "token-expired" ? "cloud-repair-token-expired" : "cloud-repair-main-changed"];
      return { ...base, change: "device-add", options: yesNo(t), fields: {
        title: title(t.title), what: title(t.what), computer: details([["name", card.name]]), detail: details([["provider", card.provider]]),
      } };
    }
    case "cloud-make-main": {
      const t = CLOUD_CARD_TEXT["cloud-make-main"];
      return { ...base, change: "main-computer", options: yesNo(t), fields: { title: title(t.title), what: title(t.what), computer: details([["name", card.name]]) } };
    }
  }
}

/** How a cloud card ended:
 *  * `approved` / `declined`: the person answered;
 *  * `stale`: what it asked about is gone (the VM no longer exists, the folder was removed), so it was closed unanswered;
 *  * `unanswered`: only with an outer bound (`maxWaitMs`): no answer by then. Lane J asks again on a later reconcile (at
 *    most once a day per server), never reading it as "keep". */
export type CloudCardOutcome = "approved" | "declined" | "stale" | "unanswered";

/** What a card is about, for `stale` and for one open card per kind and subject: a duplicate's server, the folder a
 *  create or make-main card is for, else the computer by provider and name. */
export function cloudCardSubject(card: CloudCardRequest): string {
  // An encoding no two different subjects share (a `/` inside a provider or an id can't shift where one part ends):
  // opaque to callers, who always take it from here.
  switch (card.kind) {
    case "cloud-duplicate": return JSON.stringify(["server", card.provider, card.serverId]);
    case "cloud-create": return JSON.stringify(["folder", card.folder]);
    case "cloud-make-main": return JSON.stringify(["folder", card.name]);
    default: return JSON.stringify(["computer", card.provider, card.name]);
  }
}

/** A card's whole content, keys sorted, to tell an identical ask from a changed one. */
function contentOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contentOf).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${contentOf((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface OpenCloudCard { card: CloudCardRequest; content: string; subject: string; outcome: Promise<CloudCardOutcome>; close: (why: "stale" | "unanswered") => void }

/** The cloud cards through the broker, each waiting for the person until it is answered or closed as stale. */
export class CloudCardDesk {
  readonly #broker: Pick<ApprovalBroker, "request">;
  readonly #origin: TurnOrigin;
  readonly #maxWaitMs: number | undefined;
  /** Open cards by kind and subject: one each. */
  readonly #open = new Map<string, OpenCloudCard>();

  constructor(broker: Pick<ApprovalBroker, "request">, o: { origin?: TurnOrigin; maxWaitMs?: number } = {}) {
    this.#broker = broker;
    this.#origin = o.origin ?? "routine";
    this.#maxWaitMs = o.maxWaitMs;
  }

  /** Raises the card and waits for how it ends; the same kind and subject asked again while open gets the open one.
   *  Only the person's answer (`by: "card"`) is approved or declined: a card ended any other way (withdrawn, cancelled,
   *  denied by anything but the person) is `unanswered`, never a no. */
  ask(card: CloudCardRequest): Promise<CloudCardOutcome> {
    const subject = cloudCardSubject(card);
    const key = JSON.stringify([card.kind, subject]);
    const content = contentOf(card);
    const open = this.#open.get(key);
    if (open !== undefined) {
      // The same card: its answer. A changed one (now deletable, another keeper): the old card is out of date.
      if (open.content === content) return open.outcome;
      open.close("stale");
      this.#open.delete(key);
    }
    const ac = new AbortController();
    let closed: "stale" | "unanswered" | undefined;
    let entry: OpenCloudCard | undefined;
    const timer = this.#maxWaitMs === undefined ? undefined : setTimeout(() => entry?.close("unanswered"), this.#maxWaitMs);
    (timer as { unref?: () => void } | undefined)?.unref?.();
    const outcome = (async (): Promise<CloudCardOutcome> => {
      try {
        const d = await this.#broker.request(cloudCardRequest(card, this.#origin), { signal: ac.signal });
        if (closed !== undefined) return closed;
        if (d.by !== "card") return "unanswered";
        return d.allowed ? "approved" : "declined";
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.#open.get(key) === entry) this.#open.delete(key);
      }
    })();
    entry = { card, content, subject, outcome, close: (why) => { closed ??= why; ac.abort(); } };
    this.#open.set(key, entry);
    return outcome;
  }

  /** J's `confirm`: true only when the person approved the card. */
  async confirm(card: CloudCardRequest): Promise<boolean> {
    return (await this.ask(card)) === "approved";
  }

  /** Closes, as `stale`, every open card about `subject` (`cloudCardSubject`: the server that's gone, the folder that
   *  was removed, the computer); how many. */
  stale(subject: string): number {
    let n = 0;
    for (const e of [...this.#open.values()]) if (e.subject === subject) { e.close("stale"); n++; }
    return n;
  }

  /** The cards waiting for the person now. */
  pending(): CloudCardRequest[] {
    return [...this.#open.values()].map((e) => e.card);
  }
}

/** J's `confirm` over the broker: true only when the person approved the card. */
export function cloudCardConfirm(broker: Pick<ApprovalBroker, "request">, o: { origin?: TurnOrigin } = {}): (card: CloudCardRequest) => Promise<boolean> {
  const desk = new CloudCardDesk(broker, o);
  return (card) => desk.confirm(card);
}
