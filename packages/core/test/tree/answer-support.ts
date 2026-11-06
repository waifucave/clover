// The user's signed answers in tests (review N2): each computer's own card for a call (its "built-in table", here one
// plain card per method), and a phone that signs the user's approve. The phone's key lives in memory (lane B's
// FakeDevice); nothing touches the OS store.
import { createHash, randomBytes } from "node:crypto";
import { callBindingInput, cardAnswerSigningInput, cardHashInput, type Card, type CardContent, type SignedCardAnswer } from "@waifucave/clover-protocol";
import type { AnswerDevices, CallCardRenderer } from "../../src/contracts/approval-broker";
import { MemoryAnswerLedger } from "../../src/contracts/fakes/approval-broker";
import { FakeDeviceRegistry, makeFakeDevice, toBase64, type FakeDevice } from "../../src/contracts/fakes/device-registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A computer's own card for a call: what it approves, bound to exactly that call. */
export const renderCard: CallCardRenderer = ({ computer, method, params }) => ({
  kind: "tool",
  binds: { computer, method, params: sha256(callBindingInput(method, params)) },
  fields: { title: { type: "text", text: method }, computer: { type: "text", text: computer } },
  options: [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
});

export interface Phone {
  device: FakeDevice;
  /** The device list every computer checks answers against: the phone, paired. */
  devices: AnswerDevices;
  /** The user's approve for `computer`'s own card for a call. */
  approve(computer: string, method: string, params: unknown): Promise<SignedCardAnswer>;
}

export async function makePhone(): Promise<Phone> {
  const device = await makeFakeDevice();
  const { registry } = await FakeDeviceRegistry.create({ clock: { now: () => Date.now() }, name: "Studio" });
  await registry.add({ id: device.id, name: "Phone", kind: "phone", runsCore: false, publicKey: device.publicKey }, { via: "terminal" });
  return {
    device, devices: registry,
    approve: (computer, method, params) => sign(device, computer, renderCard({ computer, method, params })!),
  };
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
