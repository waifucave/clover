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

/** `key: value` lines in a code field, the values' hiding characters out. */
function details(lines: readonly (readonly [string, string | undefined])[]): { type: "code"; code: string } {
  return { type: "code", code: lines.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${plainOf(v!)}`).join("\n") };
}

const pairedText = (p: boolean | undefined) => (p === undefined ? "not known" : p ? "yes" : "no");

/** The broker's request for one cloud card. `origin`: what started it (the reconcile is the daemon's own by default, so
 *  an unanswered card is denied after 10 minutes, rule 6). */
export function cloudCardRequest(card: CloudCardRequest, origin: TurnOrigin = "routine"): ApprovalRequest {
  const base = { kind: "change" as const, origin, computers: [] as string[], effect: "other" as const };
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
      const vms = details([
        ["folder", card.name],
        ["this one", `${card.provider} ${card.serverId}${card.region ? ` (${card.region})` : ""}, device paired: ${pairedText(card.paired)}`],
        ["the one kept", card.keeper === undefined ? "not known"
          : `${card.provider} ${card.keeper.serverId}${card.keeper.region ? ` (${card.keeper.region})` : ""}, device paired: ${pairedText(card.keeper.paired)}`],
      ]);
      if (card.deletable === true) {
        const t = CLOUD_CARD_TEXT["cloud-duplicate"];
        return { ...base, change: "computer-delete", options: yesNo(t), fields: { title: title(t.title), what: title(t.what), detail: vms } };
      }
      // Nothing to delete: one button, which answers no.
      const t = CLOUD_CARD_TEXT["cloud-duplicate-report"];
      return { ...base, change: "computer-delete", options: [{ id: "ok", kind: "deny", label: t.ok }], fields: { title: title(t.title), what: title(t.what), detail: vms } };
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

/** J's `confirm` over the broker: true only when the person approved the card. */
export function cloudCardConfirm(broker: Pick<ApprovalBroker, "request">, o: { origin?: TurnOrigin } = {}): (card: CloudCardRequest) => Promise<boolean> {
  return async (card) => (await broker.request(cloudCardRequest(card, o.origin ?? "routine"))).allowed;
}
