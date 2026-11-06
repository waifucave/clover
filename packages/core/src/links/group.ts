// The group of the user's account-less devices at the handshake (spec §6.4: one group record holds their lease), kept
// by each of its computers (H-M2: ruling R18, lane I's "Group recovery" proposal adopted, H-M1's review):
//
// * **Keys.** Members tell each other their group keys over the link (`link.group.info`), so the lease's holder, a
//   member key, maps to a device on every member, not only on the one that admitted it.
// * **Merging (R18).** Two groups merge only inside a pairing the user confirmed: both group ids are in the transcript
//   whose words they checked, and the host's group survives (links/pairing.ts). The joiner takes its key along (the
//   service moves it out of the old group), and then invites its old group's computers (`link.group.invite`). Each
//   asks its user with a card before it follows, and invites the computers it checked on that card, hop by hop. A vote
//   never carries across groups: a mover votes at once only if the host group's quorum admitted it (a one-voter host
//   group is one), else after 7 days. A computer never moves on what a peer says of its group alone, and never goes
//   back on its own to a group it left.
// * **Voters and the quorum (proposal 1, 2).** The keeper reads from the service who votes and from when. Removing
//   another member takes a quorum of voters: this computer asks the other voters over the link
//   (`link.group.cosign`), and each one asks its user with a card first. A computer never co-signs on its own.
// * **Recovery (proposal 5).** A computer the service no longer names, though it never left, was removed by another
//   member; a computer whose revoke can't reach a quorum leaves on its own. Either founds a new group and, after a
//   card that names each computer it would invite, invites the ones the user checked. Each asks its user in turn.
// * **Fresh signatures.** A pair registration or group request the service never took, whose statements are past the
//   service's 10-minute window, is signed again. The peer's half comes over the link (`link.pair.resign`,
//   `link.group.admit`).
//
// Who admits: this computer signs an admit only for a computer it invited to move (with the key that computer holds
// in the group it leaves), or to sign a pending join again (the key it paired with, not yet at the service), and never
// for a device that already has a live key in the group. Pairing admits on its own, inside the confirmed pairing.
import type { ApprovalRequest } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { SecretStore } from "../contracts/secret-store";
import type { CardOpener } from "../devices/rpc";
import type { FileDeviceRegistry, GroupLeaving, GroupRecord } from "../devices/registry";
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "../identity/bytes";
import { ed25519FromSecret, generateEd25519, type Ed25519Key, verifyEd25519 } from "../identity/keys";
import {
  admitStatement, groupKeyRef, groupStatement, HandshakeError, joinStatement, pairKeyRef, pairStatement, quorumOf, removeStatement,
  ROLLBACK_MS, STATEMENT_FRESH_MS, type GroupMember, type HandshakeClient,
} from "./handshake";

export const GROUP_LINK = {
  /** Both sides' group, key and size; the receiver answers with its own. */
  info: "link.group.info",
  /** "Admit this key into your group": the member's admit statement. */
  admit: "link.group.admit",
  /** "Agree to remove this member": a voter's remove statement, after its user's card. */
  cosign: "link.group.cosign",
  /** "Follow me to my new group" (recovery): the receiver's user decides by card. */
  invite: "link.group.invite",
  /** "Sign our pair's registration again at this `t`". */
  resign: "link.pair.resign",
} as const;

/** What each side of a link says about its group. */
export interface GroupInfo {
  group: string | null;
  key: string | null;
  /** Members at the service, as of its last read. */
  size: number;
  /** Signed in: groups are only for account-less devices (ruling R17). */
  account: boolean;
  /** The group it replaced after it was removed from that one. */
  recoveredFrom: string | null;
  /** The sender's group key's signature over `groupKeyStatement(group, its device id)`, base64url: that it holds the
   *  key it names (H-M2's check 2). */
  proof: string | null;
}

export interface GroupKeeperOptions {
  registry: FileDeviceRegistry;
  store: SecretStore;
  handshake: HandshakeClient;
  transport: Pick<LinkTransport, "connect" | "handle" | "links" | "watch">;
  clock: Clock;
  signedIn(): Promise<boolean> | boolean;
  /** Asks this device's user (lane C's broker, `brokerCardOpener`). Without it nothing is co-signed and no invite is
   *  taken. */
  openCard?: CardOpener;
  /** Called before this computer leaves a group: it releases its lease there if it holds it. */
  beforeLeave?(group: string): Promise<void>;
  /** The group changed (joined, merged, founded after a removal): the lease's scope follows. */
  onChanged?(): void;
  /** How long a co-signature or an invite waits for its card (5 minutes, inside the statements' 10-minute window). */
  cardTimeoutMs?: number;
  log?(line: string): void;
}

const CARD_TIMEOUT_MS = 5 * 60_000;

export class GroupKeeper {
  readonly #o: GroupKeeperOptions;
  readonly #offs: Unsubscribe[] = [];
  /** One change to the group at a time. */
  #chain: Promise<unknown> = Promise.resolve();
  /** Co-signatures asked for and declined, so a retry doesn't show the same card again: `<device>|<target key>`. */
  readonly #declined = new Set<string>();
  readonly #asking = new Map<string, Promise<{ by: string; sig: string } | undefined>>();
  /** Computers this one invited to move into its group, with the key each brings: the only admits it signs. */
  readonly #expected = new Map<string, { group: string; key: string }>();
  /** The keys the user chose to keep in a removal (or that they declined it), by `<group>|<member>`. */
  readonly #keeps = new Map<string, readonly string[] | "declined">();
  #closed = false;

  constructor(o: GroupKeeperOptions) {
    this.#o = o;
    const t = o.transport;
    this.#offs.push(t.handle(GROUP_LINK.info, async (raw, from) => {
      this.#mustBeMember(from);
      const theirs = parseInfo(raw);
      if (!theirs) throw new ContractError("invalid", "link.group.info: bad params");
      // After the answer: the loser of a merge acts, the other only learns the key.
      setTimeout(() => void this.#serial(() => this.#consider(from, theirs)).catch((e: unknown) => this.#log(`after ${from}'s info: ${errText(e)}`)), 0);
      return this.#info();
    }));
    this.#offs.push(t.handle(GROUP_LINK.admit, async (raw, from) => this.#admitFor(raw, from)));
    this.#offs.push(t.handle(GROUP_LINK.cosign, async (raw, from) => this.#cosignFor(raw, from)));
    this.#offs.push(t.handle(GROUP_LINK.invite, async (raw, from) => this.#invited(raw, from)));
    this.#offs.push(t.handle(GROUP_LINK.resign, async (raw, from) => this.#resignFor(raw, from)));
    const up = new Set<string>();
    this.#offs.push(t.watch((v) => {
      if (v.up && !up.has(v.peer)) {
        up.add(v.peer);
        if (this.#isMember(v.peer)) void this.exchange(v.peer).catch((e: unknown) => this.#log(`exchanging with ${v.peer}: ${errText(e)}`));
      } else if (!v.up) up.delete(v.peer);
    }));
  }

  /** Tells a linked computer this one's group and takes in its own. */
  async exchange(peer: string): Promise<void> {
    if (this.#closed) return;
    const link = await this.#o.transport.connect(peer);
    const theirs = parseInfo(await link.request<unknown>(GROUP_LINK.info, await this.#info()));
    if (!theirs) throw new ContractError("invalid", "a bad link.group.info answer");
    await this.#serial(() => this.#consider(peer, theirs));
  }

  /** Re-reads the group at the service (its voters, its size, whether this device is still in it) and sends what the
   *  service hasn't taken, signed again if its statements went stale. The links' `refresh` calls it. */
  async refresh(): Promise<void> {
    await this.#serial(async () => {
      await this.#resignPending();
      await this.#read();
    });
    // And the linked computers again: a merge the service turned away (rate-limited, unreachable) goes on.
    this.#tellLinked();
  }

  /** Removes a member other than this device: with this computer's remove, and as many of the other voters' as a quorum
   *  needs, each asked over the link and agreed to by its user. Refused (`refused`) short of a quorum: the revocation
   *  keeps the step and tries again (S5). */
  async removeMember(group: string, member: string, device?: string): Promise<void> {
    const g = this.#o.registry.group();
    // This device left that group already: nothing of its own is there to remove.
    if (!g || g.id !== group) return;
    const key = await this.#key(g);
    if (!key) throw new ContractError("not_found", "the group's key is gone");
    const read = await this.#o.handshake.readGroup(group, key);
    const target = read.members.find((m) => m.key === member);
    if (!target) return;
    // A service without group recovery yet (v1: no member shows `votesFrom`) takes any member's removal alone.
    if (read.members.every((m) => m.votesFrom === undefined)) return this.#o.handshake.removeGroupMember(group, key, member);
    const now = this.#o.handshake.now();
    const name = (device && this.#o.registry.get(device)?.name) ?? "the device";
    // The keys its removal would roll back: the user keeps the ones they recognise (the controller's ruling).
    // The service's own preview when it has one, else this computer's reading of the same rule.
    const preview = await this.#o.handshake.rollbackPreview(group, key, member).catch(() => undefined);
    // This computer is never dropped by its own removal's rollback, so its card never lists it.
    const dropped = (preview ? read.members.filter((m) => preview.drops.includes(m.key)) : rolledBack(read.members, member, now)).filter((m) => m.key !== g.ownKey);
    const keeps = await this.#keepsFor(g, group, member, name, dropped);
    const eligible = eligibleVoters(read.members, member, now);
    const need = quorumOf(eligible.length);
    const t = now;
    const removes: { by: string; sig: string }[] = [];
    if (eligible.some((m) => m.key === g.ownKey)) removes.push({ by: g.ownKey, sig: toBase64Url(key.sign(removeStatement(group, member, t, keeps))) });
    if (removes.length < need) {
      const others = eligible.filter((m) => m.key !== g.ownKey).map((m) => ({ key: m.key, device: deviceOfKey(g, m.key) }));
      const asked = others.filter((o) => o.device !== undefined && !this.#declined.has(`${o.device}|${member}`) && this.#isMember(o.device));
      const results = await firstN(asked.map((o) => this.#askCosign(o.device!, group, member, t, keeps, name)), need - removes.length);
      removes.push(...results);
    }
    if (eligible.length === 0 || removes.length < need) {
      // No quorum to remove it: this computer leaves instead, founds a new group and invites the others (the
      // reviewer's fallback). The revoked device is never invited.
      this.#log(`no quorum to remove ${name}: starting a new group`);
      await this.#serial(() => this.#startOver(g, "left"));
      return;
    }
    await this.#o.handshake.removeGroupMember(group, key, member, { t, removes, ...(keeps.length > 0 ? { keep: [...keeps] } : {}) });
  }

  /** Asks this device's user which of the keys a removal would roll back to keep: one card, a checkbox each, none
   *  checked. Asked once per removal while the daemon runs; a declined card stops the removal there. */
  async #keepsFor(g: GroupRecord, group: string, member: string, name: string, dropped: GroupMember[]): Promise<readonly string[]> {
    if (dropped.length === 0) return [];
    const id = `${group}|${member}`;
    const known = this.#keeps.get(id);
    if (known === "declined") throw new ContractError("refused", "the user didn't go on with the removal");
    if (known) return known;
    const ids = dropped.map((_, i) => `k${i + 1}`);
    const answer = await this.#ask({
      kind: "change", origin: "user", computers: [], effect: "other", change: "device-revoke",
      fields: {
        title: { type: "text", text: `Remove ${name} from your devices' group?` },
        detail: { type: "list", items: [`${name} let these in during the last 7 days. They leave with it, unless you keep them. Keep only the ones you recognise.`] },
      },
      children: dropped.map((m, i) => ({ id: ids[i]!, label: `Keep ${this.#labelOf(g, m)}`, checked: false })),
    }, { noTimeout: true });
    if (!answer.ok) {
      this.#keeps.set(id, "declined");
      throw new ContractError("refused", "the user didn't go on with the removal");
    }
    const keeps = dropped.filter((_, i) => answer.checked.includes(ids[i]!)).map((m) => m.key);
    this.#keeps.set(id, keeps);
    return keeps;
  }

  #labelOf(g: GroupRecord, m: GroupMember): string {
    const d = deviceOfKey(g, m.key);
    const name = d ? this.#o.registry.get(d)?.name : undefined;
    // One this computer never linked to: when it joined, and its key's start, so two on one day differ.
    const at = new Date(m.joinedAt).toISOString();
    return name ?? `a device that joined on ${at.slice(0, 10)} at ${at.slice(11, 16)} UTC (key ${m.key.slice(0, 8)})`;
  }

  close(): void {
    this.#closed = true;
    for (const off of this.#offs.splice(0)) off();
  }

  // ---- what each side says ----

  async #info(): Promise<GroupInfo> {
    const g = this.#o.registry.group();
    const key = g ? await this.#key(g) : undefined;
    return {
      group: g?.id ?? null, key: g?.ownKey ?? null, size: g ? sizeOf(g) : 0,
      account: await this.#o.signedIn(), recoveredFrom: g?.recoveredFrom ?? null,
      proof: g && key ? toBase64Url(key.sign(groupKeyStatement(g.id, this.#o.registry.self().id))) : null,
    };
  }

  /** A linked member of the same group says its key. It's bound only if it proves holding the key, the service lists
   *  the key, the device has no key bound yet, and no other device has that one (H-M2's check 2: a paired member
   *  can't rebind its own key or take another's). Nothing else follows from what a peer says of its group. */
  async #consider(peer: string, theirs: GroupInfo): Promise<void> {
    if (this.#closed || theirs.account || (await this.#o.signedIn())) return;
    const mine = this.#o.registry.group();
    if (theirs.group === null || mine?.id !== theirs.group || !theirs.key || !theirs.proof) return;
    const bound = mine.members[peer];
    if (bound) return;
    if (theirs.key === mine.ownKey || Object.values(mine.members).some((m) => m.key === theirs.key)) return;
    const raw = fromBase64Url(theirs.key);
    const sig = fromBase64Url(theirs.proof);
    if (!raw || raw.length !== 32 || !sig || !verifyEd25519(raw, groupKeyStatement(mine.id, peer), sig)) return;
    const key = await this.#key(mine);
    if (!key) return;
    const listed = (await this.#o.handshake.readGroup(mine.id, key)).members.some((m) => m.key === theirs.key);
    if (listed) this.#o.registry.addGroupMember(peer, theirs.key);
  }

  // ---- joining and leaving ----

  /** This device moved into another group in a confirmed pairing (pairing.ts `onMerged`): its old group's computers
   *  are invited to follow, each by its own card. */
  merged(old: GroupRecord, via: string): void {
    const group = this.#o.registry.group()?.id;
    if (!group) return;
    const devices = Object.keys(old.members).filter((d) => d !== via && this.#isMember(d));
    this.#inviteAll(old, group, "merge", devices);
  }

  /** Moves into `group` with `peer`'s admit, taking this computer's key along from `old`, then invites the computers
   *  its user checked. */
  async #moveVia(peer: string, group: string, old: GroupRecord, reason: "merge" | "recovery", next: string[]): Promise<void> {
    const hs = this.#o.handshake;
    const key = await this.#key(old);
    if (!key) throw new ContractError("not_found", "the group's key is gone");
    const mine = old.ownKey;
    const t = hs.now();
    const link = await this.#o.transport.connect(peer);
    const admit = await link.request<{ by: string; sig: string }>(GROUP_LINK.admit, { group, key: mine, t });
    if (typeof admit?.by !== "string" || typeof admit.sig !== "string") throw new ContractError("invalid", "a bad admit");
    await this.#o.beforeLeave?.(old.id).catch(() => undefined);
    await this.#o.store.set(groupKeyRef(group), key.seed(), { synced: false });
    try {
      await hs.joinGroup(group, { key: mine, t, sig: toBase64Url(key.sign(joinStatement(group, mine, t, old.id))), by: admit.by, bysig: admit.sig, from: old.id });
    } catch (err) {
      await this.#o.store.delete(groupKeyRef(group));
      throw err;
    }
    // The service took the key out of the old group with the join; a service that didn't takes its own removal.
    await this.#leave(old, "moved", true);
    this.#o.registry.setGroup({ id: group, joinedAt: this.#o.clock.now(), ownKey: mine, members: { [peer]: { key: admit.by, since: this.#o.clock.now() } } });
    this.#o.onChanged?.();
    await this.#readQuiet();
    this.#tellLinked(peer);
    this.#inviteAll(old, group, reason, next.filter((d) => d !== peer));
  }

  /** Invites `devices` of `old` to move into `group`, expecting each to bring its key from `old`. */
  #inviteAll(old: GroupRecord, group: string, reason: "merge" | "recovery", devices: string[]): void {
    for (const device of devices) {
      const k = old.members[device]?.key;
      if (!k || !this.#isMember(device)) continue;
      this.#expected.set(device, { group, key: k });
      void (async () => {
        const link = await this.#o.transport.connect(device);
        await link.request(GROUP_LINK.invite, { group, reason, from: old.id }, { timeoutMs: 24 * 3600_000 });
      })().catch((e: unknown) => this.#log(`inviting ${device}: ${errText(e)}`));
    }
  }

  async #leave(old: GroupRecord, how: GroupLeaving, removeSelf: boolean): Promise<void> {
    await this.#o.beforeLeave?.(old.id).catch(() => undefined);
    const key = await this.#key(old);
    if (key && removeSelf) {
      try {
        await this.#o.handshake.removeGroupMember(old.id, key, old.ownKey);
      } catch (err) {
        this.#log(`leaving ${old.id}: ${errText(err)}`);
      }
    }
    if (this.#o.registry.group()?.id === old.id) {
      await this.#o.store.delete(groupKeyRef(old.id));
      this.#o.registry.leaveGroup(how);
    }
  }

  /** The other linked computers hear of the change: the old group's follow, the new group's learn the key. */
  #tellLinked(except?: string): void {
    for (const l of this.#o.transport.links()) {
      if (!l.up || l.peer === except || !this.#isMember(l.peer)) continue;
      void this.exchange(l.peer).catch((e: unknown) => this.#log(`telling ${l.peer}: ${errText(e)}`));
    }
  }

  // ---- reading the group ----

  async #read(): Promise<void> {
    const g = this.#o.registry.group();
    if (!g || g.pendingCreate || g.pendingJoin) return;
    const key = await this.#key(g);
    if (!key) return;
    let members: GroupMember[];
    try {
      members = (await this.#o.handshake.readGroup(g.id, key)).members;
    } catch (err) {
      if (err instanceof HandshakeError && (err.code === "not_member" || err.status === 410 || err.status === 404)) return this.#removed(g);
      throw err;
    }
    if (!members.some((m) => m.key === g.ownKey)) return this.#removed(g);
    const own = members.find((m) => m.key === g.ownKey)!;
    const byDevice: Record<string, number | null> = {};
    for (const [device, m] of Object.entries(g.members)) {
      const at = members.find((x) => x.key === m.key);
      if (at) byDevice[device] = at.votesFrom ?? null;
    }
    const known = new Set([g.ownKey, ...Object.values(g.members).map((m) => m.key)]);
    const unknown = members.filter((m) => !known.has(m.key)).length;
    this.#o.registry.groupRead(g.id, { size: members.length, self: own.votesFrom ?? null, members: byDevice, unknown });
  }

  async #readQuiet(): Promise<void> {
    await this.#read().catch((e: unknown) => this.#log(`reading the group: ${errText(e)}`));
  }

  /** The service no longer names this device, and it never left: another member removed it. */
  async #removed(g: GroupRecord): Promise<void> {
    this.#log(`removed from group ${g.id} by another member`);
    await this.#startOver(g, "removed");
  }

  /** Founds a new group in place of `old` (proposal 5; with an account, the account replaces the group, proposal 6),
   *  then shows a card naming each computer it would invite. */
  async #startOver(old: GroupRecord, how: "removed" | "left"): Promise<void> {
    await this.#leave(old, how, how === "left");
    if (await this.#o.signedIn()) return;
    const hs = this.#o.handshake;
    const key = generateEd25519();
    const id = toBase64Url(randomBytes(16));
    const mine = toBase64Url(key.publicKey);
    const t = hs.now();
    const create = { group: id, key: mine, t, sig: toBase64Url(key.sign(groupStatement(id, mine, t))) };
    await this.#o.store.set(groupKeyRef(id), key.seed(), { synced: false });
    this.#o.registry.setGroup({ id, joinedAt: this.#o.clock.now(), ownKey: mine, members: {}, recoveredFrom: old.id, pendingCreate: create });
    try {
      await hs.createGroup(create);
      const { pendingCreate: _c, ...rest } = this.#o.registry.group()!;
      this.#o.registry.setGroup(rest);
    } catch (err) {
      this.#log(`founding the new group: ${errText(err)}`);
    }
    this.#o.onChanged?.();
    // A card first, naming each computer it would invite, so the user can leave one out (the controller's ruling). A
    // computer the user revoked, as lost or otherwise, is never on it.
    const computers = Object.keys(old.members).filter((d) => this.#isMember(d));
    if (computers.length > 0) void this.#inviteByCard(old, id, computers).catch((e: unknown) => this.#log(`inviting: ${errText(e)}`));
  }

  async #inviteByCard(old: GroupRecord, group: string, computers: string[]): Promise<void> {
    const picked = await this.#pick({
      title: "Start a new group for your devices?",
      detail: "This computer can't stay in your devices' group: another device removed it, or its revoke couldn't get your devices' agreement. The computers you check are asked to move with it; leave out any you don't trust.",
    }, computers);
    if (picked) this.#inviteAll(old, group, "recovery", picked);
  }

  /** A card with a checked box for each computer; the ones still checked when the user agrees, or undefined. */
  async #pick(text: { title: string; detail: string }, computers: string[], change: "device-add" | "device-revoke" = "device-add"): Promise<string[] | undefined> {
    const ids = computers.map((_, i) => `c${i + 1}`);
    const answer = await this.#ask({
      kind: "change", origin: "user", computers: [], effect: "other", change,
      fields: { title: { type: "text", text: text.title }, detail: { type: "list", items: [text.detail] } },
      ...(computers.length > 0 ? { children: computers.map((d, i) => ({ id: ids[i]!, label: this.#o.registry.get(d)?.name ?? "a computer", checked: true })) } : {}),
    }, { noTimeout: true });
    if (!answer.ok) return undefined;
    return computers.filter((_, i) => answer.checked.includes(ids[i]!));
  }

  // ---- what the others ask ----

  async #admitFor(raw: unknown, from: string): Promise<{ by: string; sig: string }> {
    this.#mustBeMember(from);
    const p = raw as { group?: unknown; key?: unknown; t?: unknown } | undefined;
    if (typeof p?.group !== "string" || typeof p.key !== "string" || typeof p.t !== "number" || fromBase64Url(p.key)?.length !== 32) {
      throw new ContractError("invalid", "link.group.admit takes a group, a key and t");
    }
    if (await this.#o.signedIn()) throw new ContractError("refused", "a signed-in device keeps no group");
    const g = this.#o.registry.group();
    if (!g || g.id !== p.group || g.pendingCreate || g.pendingJoin) throw new ContractError("refused", "not this computer's group");
    if (Math.abs(p.t - this.#o.handshake.now()) > STATEMENT_FRESH_MS) throw new ContractError("invalid", "t is out of the service's window");
    const key = await this.#key(g);
    if (!key) throw new ContractError("not_found", "the group's key is gone");
    // Only a computer this one invited, with the key it was expected to bring, or a pending join signed again with the
    // key it paired with. One key per device: never one that already has a live key here.
    const expected = this.#expected.get(from);
    const invited = expected !== undefined && expected.group === p.group && expected.key === p.key;
    // The key bound at pairing (bindings are never overwritten), and only while its join is pending (not live below).
    const resign = g.members[from]?.key === p.key;
    if (!invited && !resign) throw new ContractError("refused", "this computer didn't invite that key");
    const live = new Set((await this.#o.handshake.readGroup(g.id, key)).members.map((m) => m.key));
    const known = g.members[from]?.key;
    if (live.has(p.key) || (known !== undefined && live.has(known))) throw new ContractError("refused", "that device already has a key in the group");
    if (invited) this.#expected.delete(from);
    this.#o.registry.addGroupMember(from, p.key);
    return { by: g.ownKey, sig: toBase64Url(key.sign(admitStatement(p.group, p.key, p.t))) };
  }

  async #cosignFor(raw: unknown, from: string): Promise<{ by: string; sig: string }> {
    this.#mustBeMember(from);
    const p = raw as { group?: unknown; key?: unknown; t?: unknown; keeps?: unknown; name?: unknown } | undefined;
    if (typeof p?.group !== "string" || typeof p.key !== "string" || typeof p.t !== "number") throw new ContractError("invalid", "link.group.cosign takes a group, a member key and t");
    const keeps = Array.isArray(p.keeps) ? p.keeps.filter((k): k is string => typeof k === "string").slice(0, 32) : [];
    const g = this.#o.registry.group();
    if (!g || g.id !== p.group || g.members[from] === undefined) throw new ContractError("refused", "not a member of this computer's group");
    if (p.key === g.ownKey) throw new ContractError("refused", "this computer doesn't agree to its own removal");
    if (Math.abs(p.t - this.#o.handshake.now()) > STATEMENT_FRESH_MS) throw new ContractError("invalid", "t is out of the service's window");
    const key = await this.#key(g);
    if (!key) throw new ContractError("not_found", "the group's key is gone");
    const target = deviceOfKey(g, p.key);
    // Its name as this computer knows it, else as the asker named it.
    const name = (target && this.#o.registry.get(target)?.name) ?? (typeof p.name === "string" ? p.name.slice(0, 64) : "a device this computer doesn't know");
    const asker = this.#o.registry.get(from)?.name ?? "another computer";
    const keptNames = keeps.map((k) => {
      const d = deviceOfKey(g, k);
      return (d && this.#o.registry.get(d)?.name) ?? "a device this computer doesn't know";
    });
    const { ok } = await this.#ask({
      kind: "change", origin: "user", computers: [], effect: "other", change: "device-revoke",
      fields: {
        title: { type: "text", text: `Remove ${name} from your devices?` },
        detail: { type: "list", items: [`${asker} asks, to revoke it`, name, ...keptNames.map((n) => `Kept: ${n}`)] },
      },
    });
    if (!ok) throw new ContractError("refused", "the user didn't agree");
    return { by: g.ownKey, sig: toBase64Url(key.sign(removeStatement(p.group, p.key, p.t, keeps))) };
  }

  async #invited(raw: unknown, from: string): Promise<{ joined: boolean }> {
    this.#mustBeMember(from);
    const p = raw as { group?: unknown; reason?: unknown; from?: unknown } | undefined;
    if (typeof p?.group !== "string" || typeof p.from !== "string" || (p.reason !== "merge" && p.reason !== "recovery")) {
      throw new ContractError("invalid", "link.group.invite takes a group, a reason and the group left");
    }
    if (await this.#o.signedIn()) throw new ContractError("refused", "a signed-in device keeps no group");
    const mine = this.#o.registry.group();
    if (mine?.id === p.group) return { joined: true };
    if (this.#o.registry.groupLeft(p.group)) throw new ContractError("refused", "this computer left that group");
    // Only from a computer of this computer's own group, about leaving that group.
    if (!mine || mine.id !== p.from || mine.members[from] === undefined) throw new ContractError("refused", "not from this computer's group");
    const asker = this.#o.registry.get(from)?.name ?? "Another computer";
    const others = Object.keys(mine.members).filter((d) => d !== from && this.#isMember(d));
    const picked = await this.#pick(p.reason === "merge"
      ? {
        title: `Move this computer into ${asker}'s new group?`,
        detail: `${asker} was paired with another of your devices and moved into its group. The computers you check are asked to move too.`,
      }
      : {
        title: `Move this computer to ${asker}'s new group?`,
        detail: `${asker} can't stay in your devices' group: another device removed it, or its revoke couldn't get your devices' agreement. Say yes only if you know why. The computers you check are asked to move too.`,
      }, others);
    if (!picked) throw new ContractError("refused", "the user didn't agree");
    await this.#serial(() => this.#moveVia(from, p.group as string, mine, p.reason as "merge" | "recovery", picked));
    return { joined: true };
  }

  async #resignFor(raw: unknown, from: string): Promise<{ sig: string }> {
    const p = raw as { pair?: unknown; t?: unknown } | undefined;
    if (typeof p?.pair !== "string" || typeof p.t !== "number") throw new ContractError("invalid", "link.pair.resign takes a pair and t");
    const pr = this.#o.registry.pairWith(from);
    if (!pr || pr.pairId !== p.pair || !pr.registration) throw new ContractError("refused", "no such pair with this device");
    if (Math.abs(p.t - this.#o.handshake.now()) > STATEMENT_FRESH_MS) throw new ContractError("invalid", "t is out of the service's window");
    const stored = await this.#o.store.get(pairKeyRef(pr.pairId));
    if (!stored) throw new ContractError("not_found", "the pair's key is gone");
    return { sig: toBase64Url(ed25519FromSecret(stored.value).sign(pairStatement(pr.pairId, pr.registration.keys, p.t))) };
  }

  // ---- fresh signatures for what the service never took ----

  async #resignPending(): Promise<void> {
    const hs = this.#o.handshake;
    const now = hs.now();
    for (const pr of this.#o.registry.pairs()) {
      if (pr.registeredAt !== undefined || pr.endedAt !== undefined || !pr.registration || now - pr.registration.t <= STATEMENT_FRESH_MS) continue;
      try {
        const stored = await this.#o.store.get(pairKeyRef(pr.pairId));
        if (!stored) continue;
        const t = hs.now();
        const link = await this.#o.transport.connect(pr.peer);
        const { sig } = await link.request<{ sig: string }>(GROUP_LINK.resign, { pair: pr.pairId, t });
        const own = toBase64Url(ed25519FromSecret(stored.value).sign(pairStatement(pr.pairId, pr.registration.keys, t)));
        const sigs: [string, string] = pr.registration.keys[0] === pr.ownKey ? [own, sig] : [sig, own];
        this.#o.registry.setPairRegistration(pr.pairId, { t, keys: pr.registration.keys, sigs });
        await hs.registerPair({ pair: pr.pairId, keys: pr.registration.keys, t, sigs });
        this.#o.registry.markPairRegistered(pr.pairId);
      } catch (err) {
        this.#log(`signing pair ${pr.pairId} again: ${errText(err)}`);
      }
    }
    const g = this.#o.registry.group();
    if (!g) return;
    const key = await this.#key(g);
    if (!key) return;
    if (g.pendingCreate && now - g.pendingCreate.t > STATEMENT_FRESH_MS) {
      const t = hs.now();
      const create = { group: g.id, key: g.ownKey, t, sig: toBase64Url(key.sign(groupStatement(g.id, g.ownKey, t))) };
      this.#o.registry.setGroup({ ...g, pendingCreate: create });
      try {
        await hs.createGroup(create);
        const { pendingCreate: _c, ...rest } = this.#o.registry.group()!;
        this.#o.registry.setGroup(rest);
      } catch (err) {
        this.#log(`founding the group again: ${errText(err)}`);
      }
    }
    const g2 = this.#o.registry.group()!;
    if (g2.pendingJoin && now - g2.pendingJoin.t > STATEMENT_FRESH_MS) {
      const by = g2.pendingJoin.via ?? deviceOfKey(g2, g2.pendingJoin.by);
      if (!by) return;
      try {
        const t = hs.now();
        const link = await this.#o.transport.connect(by);
        const admit = await link.request<{ by: string; sig: string }>(GROUP_LINK.admit, { group: g2.id, key: g2.ownKey, t });
        const from = g2.pendingJoin.from;
        const join = { key: g2.ownKey, t, sig: toBase64Url(key.sign(joinStatement(g2.id, g2.ownKey, t, from))), by: admit.by, bysig: admit.sig, ...(from ? { from } : {}) };
        this.#o.registry.setGroup({ ...g2, pendingJoin: join });
        await hs.joinGroup(g2.id, join);
        const { pendingJoin: _j, ...rest } = this.#o.registry.group()!;
        this.#o.registry.setGroup(rest);
        this.#o.onChanged?.();
      } catch (err) {
        this.#log(`joining the group again: ${errText(err)}`);
      }
    }
  }

  // ---- helpers ----

  #askCosign(device: string, group: string, member: string, t: number, keeps: readonly string[], name: string): Promise<{ by: string; sig: string } | undefined> {
    const id = `${device}|${member}|${t}`;
    const running = this.#asking.get(id);
    if (running) return running;
    const p = (async () => {
      try {
        const link = await this.#o.transport.connect(device);
        const r = await link.request<{ by: string; sig: string }>(GROUP_LINK.cosign, { group, key: member, t, keeps: [...keeps], name }, { timeoutMs: (this.#o.cardTimeoutMs ?? CARD_TIMEOUT_MS) + 30_000 });
        return typeof r?.by === "string" && typeof r.sig === "string" ? r : undefined;
      } catch (err) {
        if (err instanceof ContractError && err.code === "refused") this.#declined.add(`${device}|${member}`);
        return undefined;
      } finally {
        this.#asking.delete(id);
      }
    })();
    this.#asking.set(id, p);
    return p;
  }

  async #ask(req: ApprovalRequest, o: { noTimeout?: boolean } = {}): Promise<{ ok: boolean; checked: readonly string[] }> {
    if (!this.#o.openCard) return { ok: false, checked: [] };
    const opened = await this.#o.openCard(req);
    const ms = this.#o.cardTimeoutMs ?? CARD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ok = await (o.noTimeout ? opened.allowed : Promise.race([opened.allowed, new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]));
      return { ok, checked: ok ? ((await opened.checked) ?? []) : [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #key(g: GroupRecord): Promise<Ed25519Key | undefined> {
    const stored = await this.#o.store.get(groupKeyRef(g.id));
    return stored ? ed25519FromSecret(stored.value) : undefined;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** A member device this keeper deals with: any paired, unrevoked device but this one. Phones are voting members of
   *  the group too (the controller's ruling); they never hold or take the lease, which only computers run. */
  #isMember(id: string): boolean {
    const d = this.#o.registry.get(id);
    return d !== undefined && d.revokedAt === undefined && id !== this.#o.registry.self().id;
  }

  #mustBeMember(id: string): void {
    if (!this.#isMember(id)) throw new ContractError("refused", "only a paired device speaks for the group");
  }

  #log(line: string): void {
    this.#o.log?.(`[group] ${line}`);
  }
}

/** The voters a change to `target` counts: those who vote now, not the target, and not the keys it admitted lately
 *  (a quorum's removal of it undoes those). */
export function eligibleVoters(members: GroupMember[], target: string, now: number): GroupMember[] {
  // Transitively, as lane I's service counts them: those keys can't co-sign either (403 not_voter).
  const lately = new Set(rolledBack(members, target, now).map((m) => m.key));
  return members.filter((m) => m.key !== target && m.votesFrom != null && m.votesFrom <= now && !lately.has(m.key));
}

/** The members a quorum's removal of `target` would roll back: the keys it admitted in the last 7 days, and theirs. */
export function rolledBack(members: GroupMember[], target: string, now: number): GroupMember[] {
  const since = now - ROLLBACK_MS;
  const out = new Map<string, GroupMember>();
  const walk = (k: string) => {
    for (const m of members) {
      if (out.has(m.key) || m.key === target || m.joinedAt < since || !(m.admittedBy ?? []).includes(k)) continue;
      out.set(m.key, m);
      walk(m.key);
    }
  };
  walk(target);
  return [...out.values()];
}

function sizeOf(g: GroupRecord): number {
  return g.size ?? 1 + Object.keys(g.members).length;
}

function deviceOfKey(g: GroupRecord, key: string): string | undefined {
  for (const [device, m] of Object.entries(g.members)) if (m.key === key) return device;
  return undefined;
}

function parseInfo(raw: unknown): GroupInfo | undefined {
  const p = raw as Partial<GroupInfo> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    group: str(p.group), key: str(p.key), size: typeof p.size === "number" && Number.isFinite(p.size) ? p.size : 0,
    account: p.account === true, recoveredFrom: str(p.recoveredFrom), proof: str(p.proof),
  };
}

/** What a member signs with its group key to show it holds the key it names for its device. */
export function groupKeyStatement(group: string, device: string): Uint8Array {
  return utf8(`clover/group-key/1\n${group}\n${device}`);
}

/** The first `n` defined results of `ps`, as soon as they're in (or all there are, once every one has settled). */
async function firstN<T>(ps: Promise<T | undefined>[], n: number): Promise<T[]> {
  const out: T[] = [];
  if (n <= 0 || ps.length === 0) return out;
  return new Promise((resolve) => {
    let left = ps.length;
    for (const p of ps) {
      void p.then((v) => {
        if (v !== undefined && out.length < n) out.push(v);
        left--;
        if (out.length >= n || left === 0) resolve(out.slice());
      });
    }
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
