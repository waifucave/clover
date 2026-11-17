// The offer (ruling 2): at the first start of a fresh home, when an old install's home is there (`locate.ts`), ONE
// card drawn by the core (a `change` card, subject `home-copy`; no plugin is involved) asks: bring the data over (it
// is copied; the old install is left as it is), or start fresh. The answer is kept in the new home (`choice.ts`), so
// it is never asked again. While the old engine runs (ruling 3) the card says to quit it first and offers to check
// again; nothing is copied. On "bring it over" the copy is staged (`copy.ts`) and the engine restarts to swap it in
// (`swap.ts`); after the swap, one notice says what didn't come over (`left-behind.ts`) and, when the old engine is set
// to start at login, offers the one button that runs its own `autostart disable` (`login-item.ts`).
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CardOption, SealedValue } from "@waifucave/moss-protocol";
import type { ApprovalBroker, ApprovalRequest } from "../../contracts/approval-broker";
import { OLD_APP_NAME as OLD } from "../../other-installs";
import { isFresh, readChoice, writeChoice } from "./choice";
import { copyOldHome, OldEngineRunning } from "./copy";
import { leftBehindLines, type LeftBehind } from "./left-behind";
import { disableOldLoginItem, oldLoginItem, type OldLoginItem } from "./login-item";
import { oldHomePaths } from "./paths";

export interface OfferDeps {
  home: string;
  oldHome: string;
  broker: Pick<ApprovalBroker, "request">;
  alive: () => Promise<{ alive: boolean; how?: string }>;
  /** Called once the copy is staged: the engine restarts to swap it in. Absent: it is swapped at the next start. */
  requestRestart?: () => void;
  copy?: typeof copyOldHome;
  loginItem?: () => OldLoginItem | undefined;
  disableLoginItem?: (item: OldLoginItem) => Promise<{ ok: boolean; why?: string }>;
  log?: (line: string) => void;
  now?: () => number;
}

export type OfferOutcome = "not-fresh" | "no-old-home" | "already-chosen" | "fresh" | "staged" | "unanswered" | "notice-shown";

/** The card's words, each from this table (sealed fields hold the built-in tables' strings only). */
export const OFFER_TEXT = {
  offer: {
    title: `Bring your data over from ${OLD}?`,
    what: `MOSS found ${OLD}'s data on this computer: your bots, conversations, memory, routines, plugins and settings.`,
    detail: [
      `Bring my data over: MOSS copies it. ${OLD}'s own folder is left exactly as it is, so ${OLD} keeps working and stays your way back.`,
      "Start fresh: MOSS starts empty, and won't ask again.",
      `Sign-ins, keys and paired devices stay with ${OLD}: after the copy, MOSS lists which to set up again.`,
      "MOSS restarts once to finish the copy.",
    ],
    copy: "Bring my data over",
    fresh: "Start fresh",
  },
  running: {
    title: `Quit ${OLD} first`,
    what: `${OLD} is running, so its data can't be copied whole right now.`,
    detail: [`Quit ${OLD} (and its background service), then press Check again.`, `Nothing has been copied, and ${OLD}'s folder is untouched.`],
    check: "Check again",
    fresh: "Start fresh",
  },
  failed: (why: string) => `The copy didn't finish (${why}). Nothing changed here or in ${OLD}'s folder; you can try again.`,
  notice: {
    title: `Your data is here from ${OLD}`,
    what: `Your bots, conversations, memory, routines, plugins and settings were copied. ${OLD}'s own folder was left exactly as it was.`,
    kept: "Your approval levels, trusted folders and saved \"Always allow\" choices came over as they were.",
    plugins: "Plugins you installed yourself wait for your OK again, as their files were updated for MOSS: switch each one on in Plugins to see its card.",
    login: `${OLD} still starts when you log in, so both would run your routines. "Turn off ${OLD}'s login start" runs ${OLD}'s own autostart disable command for its folder: this changes ${OLD}'s own login setting (${OLD} moves its login item into its own folder). ${OLD} stays installed and can still be opened; nothing else of it changes.`,
    setAside: (folder: string) => `What this computer's MOSS held before the copy (conversations or settings made before you pressed) is kept, set aside, in ${folder}.`,
    loginOff: `Turn off ${OLD}'s login start`,
    leave: "Leave it on",
    ok: "OK",
  },
  loginFailed: (why: string) => `${OLD}'s login start couldn't be turned off (${why}). Turn it off in ${OLD}'s own settings instead.`,
} as const;

const text = (t: string): SealedValue => ({ type: "text", text: t });
const list = (items: readonly string[]): SealedValue => ({ type: "list", items: [...items] });

function card(fields: ApprovalRequest["fields"], options: CardOption[]): ApprovalRequest {
  return { kind: "change", change: "home-copy", origin: "user", computers: [], effect: "other", fields, options };
}

/** The folder the swap set the fresh home's entries aside in, when the person had used the fresh home before the press
 *  (a conversation in its session index, or more than its first start's files), else undefined. */
function setAside(home: string): string | undefined {
  const root = oldHomePaths(home).replaced;
  let latest: string | undefined;
  try {
    latest = readdirSync(root).sort().pop();
  } catch {
    return undefined;
  }
  if (latest === undefined) return undefined;
  const dir = join(root, latest);
  // A first start leaves its settings, an empty index and a bot's empty conversation; a conversation the person had
  // (a log or transcript past a few kilobytes) is their own. Read with stat and readdir only, at most a few levels.
  const used = (rel: string, depth: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(join(dir, rel));
    } catch {
      return false;
    }
    return names.some((n) => {
      try {
        const st = statSync(join(dir, rel, n));
        return st.isDirectory() ? depth < 3 && used(join(rel, n), depth + 1) : n !== "index.db" && st.size > 4096;
      } catch {
        return false;
      }
    });
  };
  return used("sessions", 0) || used("transcripts", 0) ? dir : undefined;
}

/** Whether the old home holds anything to bring over: read with `lstat` only. */
export function oldHomeHasData(oldHome: string): boolean {
  try {
    if (!lstatSync(oldHome).isDirectory()) return false;
  } catch {
    return false;
  }
  return ["settings.json", "sessions", "bots"].some((e) => existsSync(join(oldHome, e)));
}

/** Runs the offer, or the notice after a copy, to its end (see the file's header). */
export async function runOldHomeOffer(d: OfferDeps): Promise<OfferOutcome> {
  const log = d.log ?? (() => {});
  const chosen = readChoice(d.home);
  if (chosen?.choice === "copied") {
    if (chosen.noticeShown === true) return "already-chosen";
    // Said once: kept as said once the person answered it (a stop that cancels it says it again at the next start).
    if (!(await notice(d))) return "unanswered";
    writeChoice(d.home, { ...chosen, noticeShown: true });
    return "notice-shown";
  }
  if (chosen !== undefined) return "already-chosen";
  if (!isFresh(d.home)) return "not-fresh";
  if (!oldHomeHasData(d.oldHome)) return "no-old-home";
  let failed: string | undefined;
  for (;;) {
    const running = await d.alive();
    const req = running.alive
      ? card({ title: text(OFFER_TEXT.running.title), what: text(OFFER_TEXT.running.what), detail: list(OFFER_TEXT.running.detail) }, [
        { id: "check", kind: "approve", label: OFFER_TEXT.running.check },
        { id: "fresh", kind: "deny", label: OFFER_TEXT.running.fresh },
      ])
      : card({ title: text(OFFER_TEXT.offer.title), what: text(OFFER_TEXT.offer.what), detail: list(failed === undefined ? OFFER_TEXT.offer.detail : [OFFER_TEXT.failed(failed), ...OFFER_TEXT.offer.detail]) }, [
        { id: "copy", kind: "approve", label: OFFER_TEXT.offer.copy },
        { id: "fresh", kind: "deny", label: OFFER_TEXT.offer.fresh },
      ]);
    const decision = await d.broker.request(req);
    if (decision.by !== "card") {
      log(`old home: the offer wasn't answered (${decision.by}); it is made again at the next start`);
      return "unanswered";
    }
    if (decision.optionId === "fresh") {
      writeChoice(d.home, { v: 1, choice: "fresh", at: (d.now ?? Date.now)() });
      log("old home: the person chose to start fresh; not asked again");
      return "fresh";
    }
    if (decision.optionId === "check") continue;
    if ((await d.alive()).alive) continue;
    try {
      await (d.copy ?? copyOldHome)({ oldHome: d.oldHome, home: d.home, alive: d.alive, log, ...(d.now ? { now: d.now } : {}) });
    } catch (err) {
      if (err instanceof OldEngineRunning) continue;
      failed = err instanceof Error ? err.message.slice(0, 300) : String(err);
      log(`old home: the copy failed (${failed}); nothing changed, and the offer is made again`);
      continue;
    }
    log("old home: the copy is staged; the engine restarts to swap it in");
    d.requestRestart?.();
    return "staged";
  }
}

/** The notice after a copy; true once the person answered it. */
async function notice(d: OfferDeps): Promise<boolean> {
  let left: LeftBehind | undefined;
  try {
    left = JSON.parse(readFileSync(oldHomePaths(d.home).leftBehind, "utf8")) as LeftBehind;
  } catch {
    left = undefined;
  }
  const item = (d.loginItem ?? (() => oldLoginItem(d.oldHome)))();
  const aside = setAside(d.home);
  const lines = [...(left === undefined ? [] : leftBehindLines(left)), OFFER_TEXT.notice.kept, OFFER_TEXT.notice.plugins, ...(aside === undefined ? [] : [OFFER_TEXT.notice.setAside(aside)]), ...(item === undefined ? [] : [OFFER_TEXT.notice.login])];
  const options: CardOption[] = item === undefined
    ? [{ id: "ok", kind: "approve", label: OFFER_TEXT.notice.ok }]
    : [{ id: "login-off", kind: "approve", label: OFFER_TEXT.notice.loginOff }, { id: "leave", kind: "deny", label: OFFER_TEXT.notice.leave }];
  const decision = await d.broker.request(card({ title: text(OFFER_TEXT.notice.title), what: text(OFFER_TEXT.notice.what), detail: list(lines) }, options));
  if (decision.by !== "card") return false;
  if (item === undefined || decision.optionId !== "login-off") return true;
  const r = await (d.disableLoginItem ?? ((i: OldLoginItem) => disableOldLoginItem(i, d.oldHome)))(item);
  if (r.ok) {
    d.log?.("old home: the old engine's own autostart disable turned its login start off");
    return true;
  }
  d.log?.(`old home: the old engine's autostart disable didn't turn its login start off (${r.why ?? "no reason given"})`);
  await d.broker.request(card({ title: text(OFFER_TEXT.notice.title), what: text(OFFER_TEXT.loginFailed(r.why ?? "it gave no reason")) }, [{ id: "ok", kind: "approve", label: OFFER_TEXT.notice.ok }]));
  return true;
}
