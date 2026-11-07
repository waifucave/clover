// The user's signed answers in tests (review N2, R1): each computer's own card for a call (its "built-in table", here
// one plain card per method), and a phone that signs the user's approve for a card it is shown. The phone's key lives
// in memory (lane B's FakeDevice); nothing touches the OS store.
import { createHash, randomBytes } from "node:crypto";
import { callBindingInput, cardAnswerSigningInput, cardHashInput, type Card, type CardContent, type SignedCardAnswer, type TreeTransferParams } from "@waifucave/clover-protocol";
import type { AnswerDevices, CallCardRenderer } from "../../src/contracts/approval-broker";
import { MemoryAnswerLedger } from "../../src/contracts/fakes/approval-broker";
import { FakeDeviceRegistry, makeFakeDevice, makeFakePhone, toBase64, type FakeDevice } from "../../src/contracts/fakes/device-registry";
import { TREE_TRANSFER } from "@waifucave/clover-protocol";
import { transferBinding } from "../../src/contracts/tree";
import type { AnswerAsker, NeedsAnswer } from "../../src/tree/judge";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A computer's own card for a call: what it approves, bound to exactly that call; a move or copy between two
 *  computers binds both (R15's `transferBinding`), so either end rebuilds the same card. */
export const renderCard: CallCardRenderer = ({ computer: self, method, params }) => {
  const computer = method === TREE_TRANSFER ? (params as TreeTransferParams).destination : self;
  return {
    kind: "tool",
    binds: method === TREE_TRANSFER ? transferBinding(params as TreeTransferParams, sha256) : { computer, method, params: sha256(callBindingInput(method, params)) },
    fields: { title: { type: "text", text: method }, computer: { type: "text", text: computer } },
    options: [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
  };
};

export interface Phone {
  device: FakeDevice;
  /** The device list every computer checks answers against: the phone, paired. */
  devices: AnswerDevices;
  /** The user's approve for `computer`'s own card for a call. */
  approve(computer: string, method: string, params: unknown): Promise<SignedCardAnswer>;
  /** R1's calling side: shows the user the holder's card and signs their approve (or nothing, when `deny`). */
  ask: AnswerAsker;
  /** The cards `ask` was shown, in order. */
  shown: NeedsAnswer[];
  deny: boolean;
}

export async function makePhone(): Promise<Phone> {
  const device = await makeFakePhone();
  const { registry } = await FakeDeviceRegistry.create({ clock: { now: () => Date.now() }, name: "Studio" });
  await registry.add({ id: device.id, name: "Phone", kind: "phone", runsCore: false, publicKey: device.publicKey, answerKey: device.answerKey }, { via: "terminal" });
  const phone: Phone = {
    device, devices: registry, shown: [], deny: false,
    approve: (computer, method, params) => sign(device, computer, renderCard({ computer, method, params })!),
    ask: async (need) => {
      phone.shown.push(need);
      if (phone.deny || !need.card) return null;
      return sign(device, need.computer, need.card);
    },
  };
  return phone;
}

/** The whole card for a holder's content, shown now, and the phone's signed approve. */
export async function sign(device: FakeDevice, computer: string, content: CardContent, option = "approve"): Promise<SignedCardAnswer> {
  const now = Date.now();
  const body: Omit<Card, "hash"> = {
    id: `card_${randomBytes(9).toString("base64url")}`, computer, origin: "user", issuedAt: now, expiresAt: null,
    kind: content.kind, fields: content.fields, options: content.options,
    ...(content.binds ? { binds: content.binds } : {}), ...(content.change ? { change: content.change } : {}),
  };
  const card = { ...body, hash: sha256(cardHashInput(body)) } as Card;
  const signature = toBase64(await device.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at: now }))));
  return { card, option, device: device.id, at: now, signature };
}

/** What each computer checks a signed answer with. */
export function answersFor(phone: Phone) {
  return { devices: phone.devices, ledger: new MemoryAnswerLedger(), render: renderCard };
}
