// MOSS protocol area: surfaces, presence and where a card is drawn (spec revision 19: §3.1 "Client kinds", §3.4 "Mount
// lists", §3.5 "The router and presence", §5.5 "Only sealed buttons answer", ruling C). Owner: lane RT (the router and the
// window's card strip), with the mount lists' engine half. Shapes pinned by lane SP; nothing here is served yet.
//
// * Which surface a client is: the `app` role's hello names `surface` (`moss`, `code` or `host`); a hello without one is
//   `code`, today's app. It chooses what the engine mounts there (`SURFACE_MOUNTS`) and grants no method: all three are the
//   `app` role for the allow lists, the caller check and an answer key. The engine refuses a second live `host`.
// * Presence: the main process of each program with windows (`moss`, `code`) reports which of its windows is focused and
//   visible and which session or bot each shows (`presence.report`), never a plugin part. A report expires when its
//   connection drops or after `PRESENCE_TTL_MS` without a new one; a change places the pending cards again.
// * Placement: the router names one live place per computer for each pending card (`card_placed`, `card.placement`):
//   the conversation of the focused window showing its session or bot, else the focused window's own strip, a card with
//   no session in the focused window that asked for it, else the island, else nowhere on this computer (the phone or the
//   CLI answers). Item 91 is unchanged: every device shows a pending card and the first answer wins.
// * One answer key per (device, program): MOSS, MOSS Code and the host each register their own (`device.programKey.set`),
//   the program being the connection's signed identity, never the hello's `surface` (which stands in on Windows and
//   Linux); an answer's proof names its program (`programCardAnswerSigningInput`).
import { z } from "zod";
import { utf16 } from "./strings";
import { BotId, CardId, ChangeResult, SessionId, Timestamp } from "./common";
import { AnswerKeyAlg, AnswerKeyHolder } from "./devices";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

// -------------------------------------------------------------------------------------------------
// Surfaces and programs
// -------------------------------------------------------------------------------------------------

/** What an `app` connection is (G1): MOSS's window, MOSS Code's window, or the background host. */
export const SURFACES = ["moss", "code", "host"] as const;
export const Surface = z.enum(SURFACES);
export type Surface = z.infer<typeof Surface>;
/** A hello with no `surface` is today's app, MOSS Code's window. */
export const DEFAULT_SURFACE: Surface = "code";

/** The product's three programs, each a signed identity of its own (§2, item 120). An answer key and a press record
 *  belong to a program; the engine takes the program from the connection's signed identity (`programOfIdentifier`),
 *  never from the hello's `surface`, except on Windows and Linux, where no running image is signed and `surface` plus the
 *  caller check stand in (§3.1). The names are the surfaces' own, so one program shows one surface. */
export const MOSS_PROGRAMS = SURFACES;
export const Program = Surface;
export type Program = Surface;

/** The programs' bundle identifiers on macOS, dist and dev (item 120). The engine's own is `com.waifucave.moss.core`. */
export const PROGRAM_IDENTIFIERS: Readonly<Record<Program, { dist: string; dev: string }>> = {
  moss: { dist: "com.waifucave.moss", dev: "com.waifucave.moss.dev" },
  code: { dist: "com.waifucave.moss.code", dev: "com.waifucave.moss.code.dev" },
  host: { dist: "com.waifucave.moss.host", dev: "com.waifucave.moss.host.dev" },
};

/** The program a signed identifier names, for the profile; undefined for any other identifier. */
export function programOfIdentifier(identifier: string, profile: "dist" | "dev"): Program | undefined {
  for (const p of MOSS_PROGRAMS) if (PROGRAM_IDENTIFIERS[p][profile] === identifier) return p;
  return undefined;
}

/** The programs that have windows and so report presence; the host draws only on the screen. */
export const WINDOW_PROGRAMS = ["moss", "code"] as const satisfies readonly Program[];
export const WindowProgram = z.enum(WINDOW_PROGRAMS);
export type WindowProgram = z.infer<typeof WindowProgram>;

/** Where a plugin's part shows (§3.4): the engine alone, the screen (the host), or a window (MOSS Code's). */
export const PLACES = ["engine", "screen", "window"] as const;
export const Place = z.enum(PLACES);
export type Place = z.infer<typeof Place>;

/** What the engine mounts on each surface (§3.4, G1): the window and screen core points (§5.3) whose contributions that
 *  surface's plugin runtime loads, and whether it runs the browser's offscreen pages (§12.1, item 111). `moss` mounts
 *  nothing from plugins: MOSS's window is built in, and draws only the sealed cards the router places there. A point a
 *  plugin declares inside one of these (a spot of the shell, `island.tab`) is mounted wherever its declarer is. */
export const MountList = z.object({
  surface: Surface,
  /** The core points of §5.3 this surface's plugin runtime reads. */
  points: z.array(utf16(64, 1)).max(32),
  /** The places of §3.4 it shows. */
  places: z.array(Place).max(3),
  /** It runs the MOSS Browser's tabs (offscreen pages and the person's own views). */
  browserPages: z.boolean(),
  /** It draws the sealed cards the router places on it. */
  drawsCards: z.boolean(),
});
export type MountList = z.infer<typeof MountList>;

export const SURFACE_MOUNTS: Readonly<Record<Surface, MountList>> = {
  code: { surface: "code", points: ["themes", "locales", "app.root"], places: ["window"], browserPages: false, drawsCards: true },
  host: { surface: "host", points: ["themes", "locales", "app.surface", "app.background", "app.tray"], places: ["screen"], browserPages: true, drawsCards: true },
  moss: { surface: "moss", points: [], places: [], browserPages: false, drawsCards: true },
};

/** What a `code` hello mounts until the background host exists (Split 1): today's app also runs the screen's points and
 *  the browser's pages itself. To be retired when lane HS moves them onto the host (§3.4, §12.1). */
export const LEGACY_CODE_MOUNTS: MountList = {
  surface: "code", points: ["themes", "locales", "app.root", "app.surface", "app.background", "app.tray"], places: ["window", "screen"], browserPages: true, drawsCards: true,
};

/** Why a hello's `surface` was refused (`MOSS_ERR.SURFACE_REFUSED`'s data). `second-host`: a host is live on this home
 *  already (one per home, §3.1); `not-app`: `surface` belongs to the `app` role only; `program-mismatch`: the connection's
 *  signed program is another surface's (macOS); `older-copy`: a newer copy of the same program is live, so this older one
 *  stops (§3.1: the engine tells an older second client of a surface to stop). */
export const SurfaceRefusal = z.object({ reason: z.enum(["second-host", "not-app", "program-mismatch", "older-copy"]), surface: Surface.optional() });
export type SurfaceRefusal = z.infer<typeof SurfaceRefusal>;

// -------------------------------------------------------------------------------------------------
// Presence
// -------------------------------------------------------------------------------------------------

/** A window of one program, named by that program (stable while the window lives; at most 64 characters). */
export const WindowId = utf16(64, 1).regex(/^[A-Za-z0-9._:-]+$/);

/** What a window shows that a card can belong to: a session (MOSS Code's code sessions) or a bot (MOSS's conversation). */
export const Showing = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("bot"), id: BotId }),
]);
export type Showing = z.infer<typeof Showing>;

export const WindowPresence = z.object({
  window: WindowId,
  /** It has the OS's key focus (one window of the product at most, across programs). */
  focused: z.boolean(),
  /** On screen, not minimised and not hidden. */
  visible: z.boolean(),
  /** What it shows now; null for a page with no session or bot (Settings, the Plugins page). */
  showing: Showing.nullable(),
});
export type WindowPresence = z.infer<typeof WindowPresence>;

/** One program's whole presence, read by its main process from the OS and its own state (E1: never a plugin part). */
export const PresenceReport = z.object({
  windows: z.array(WindowPresence).max(16),
});
export type PresenceReport = z.infer<typeof PresenceReport>;

/** A report holds this long without a new one; the program sends one on every change and at least every
 *  `PRESENCE_REFRESH_MS` while it has a window. */
export const PRESENCE_TTL_MS = 10_000;
export const PRESENCE_REFRESH_MS = 3_000;

// -------------------------------------------------------------------------------------------------
// Placement
// -------------------------------------------------------------------------------------------------

/** Where the router places a pending card on this computer (ruling A, R1). One place at a time per computer. */
export const CardPlacement = z.discriminatedUnion("kind", [
  /** In the conversation of the focused window that shows the card's session or bot. */
  z.object({ kind: z.literal("conversation"), program: WindowProgram, window: WindowId }),
  /** In the focused window's own strip, drawn by the core: the window shows another session, or the card has none and
   *  that window asked for it. */
  z.object({ kind: z.literal("strip"), program: WindowProgram, window: WindowId }),
  /** On the island, on the background host: no window of the product is focused. */
  z.object({ kind: z.literal("island") }),
  /** No surface on this computer (no window, no host): the card waits for a device or the CLI. */
  z.object({ kind: z.literal("elsewhere") }),
]);
export type CardPlacement = z.infer<typeof CardPlacement>;

/** What the router reads of a card: its own session or bot, and for a card with none (a plugin's OK from a Plugins
 *  page, an update card, an answer-key card) the window it was asked from. */
export const RoutedCard = z.object({
  id: CardId,
  session: SessionId.optional(),
  bot: BotId.optional(),
  askedFrom: z.object({ program: WindowProgram, window: WindowId }).optional(),
});
export type RoutedCard = z.infer<typeof RoutedCard>;

/** Where a press on a card's sealed button came from: a window's sealed frame, or the island's. */
export type PressPlace = { kind: "window"; program: WindowProgram; window: string } | { kind: "island" };

/** Whether a press from `from` may be taken for a card placed at `placement` (the island's press gate follows the
 *  placement, never window focus, §3.5). A press is never forwarded from one program to another. Presence decides only
 *  where; the press rules of §5.5 still judge the press itself. */
export function pressMatchesPlacement(placement: CardPlacement, from: PressPlace): boolean {
  if (from.kind === "island") return placement.kind === "island";
  return (placement.kind === "conversation" || placement.kind === "strip") && placement.program === from.program && placement.window === from.window;
}

// -------------------------------------------------------------------------------------------------
// Answer keys per program
// -------------------------------------------------------------------------------------------------

/** What a program signs to register its answer key (ruling C): the device, the program, the public key, how it is held and
 *  its algorithm. A new statement beside the single-key one (`identity/answer-key.ts`), which today's app still uses for
 *  the `code` program. */
export function programAnswerKeyStatement(a: { device: string; program: Program; publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg }): string {
  return `moss/program-answer-key/1\n${a.device}\n${a.program}\n${a.publicKey}\n${a.held}\n${a.alg ?? "ed25519"}`;
}

/** What a program's current key signs to hand over to its next one (`device.programKey.set`'s `rotation`): the device, the
 *  program, both keys and the time, so one program's hand-over never replaces another program's key. */
export function programAnswerKeyRotateStatement(a: { device: string; program: Program; from: string; to: string; at: number }): string {
  return `moss/program-answer-key-rotate/1\n${a.device}\n${a.program}\n${a.from}\n${a.to}\n${a.at}`;
}

/** The input a program-keyed answer signs: the single-key answer's (`cardAnswerSigningInput`) with its program first, so a
 *  proof names its key and one program's signature never passes as another's. */
export function programCardAnswerSigningInput(a: { program: Program; id: string; hash: string; option: string; at: number; children?: readonly string[] }): string {
  const children = [...(a.children ?? [])].sort().join(",");
  return `moss/card-answer/3\n${a.program}\n${a.id}\n${a.hash}\n${a.option}\n${a.at}\n${children}`;
}

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256);

export const CardPlacedEvent = coreEvent("card_placed", {
  card: CardId,
  place: CardPlacement,
  /** Where it was before, when it moved. */
  before: CardPlacement.optional(),
});

export const SURFACES_METHODS = {
  presenceReport: defineMethod({
    /** From MOSS's and MOSS Code's main processes (`surface` `moss` or `code`); the host's connection is refused. Each
     *  report replaces the program's last; its answer says how long it holds. */
    name: "presence.report", owner: "RT", roles: ["app"],
    params: PresenceReport,
    result: z.object({ ttlMs: z.number().int().positive() }),
    doc: "A program's windows: which is focused and visible and which session or bot each shows (§3.5); it places the pending cards again.",
  }),
  cardPlacement: defineMethod({
    name: "card.placement", owner: "RT", roles: ["app"], noSessions: true,
    params: z.object({ ids: z.array(CardId).max(256).optional() }),
    result: z.object({ placements: z.array(z.object({ card: CardId, place: CardPlacement })).max(1024) }),
    doc: "Where the router places each pending card on this computer now (all of them, or the ids named).",
  }),
  deviceProgramKeySet: defineMethod({
    /** Like `device.answerKey.set`, for one program (ruling C): the program is the connection's signed identity (its
     *  surface on Windows and Linux), and `signature` is the key's own over `programAnswerKeyStatement`. The first key of a
     *  program applies at once; replacing one is a sensitive change, a sealed card (`{ applied: false, card }`). */
    name: "device.programKey.set", owner: "RT", roles: ["app"], userOnly: true,
    params: z.object({
      publicKey: Base64, held: AnswerKeyHolder, alg: AnswerKeyAlg.optional(), signature: Base64,
      rotation: z.object({ from: Base64, at: Timestamp, signature: Base64 }).optional(),
    }),
    result: ChangeResult,
    doc: "Registers this program's answer key on this desktop, proved by the key's own signature; one per program.",
  }),
} as const;

export const SURFACES_EVENTS = {
  cardPlaced: defineEvent({
    type: "card_placed", owner: "RT", roles: ["app"], schema: CardPlacedEvent, transient: true,
    fixture: { type: "card_placed", ts: 1781270000000, card: "card_abcdef", place: { kind: "island" }, before: { kind: "strip", program: "code", window: "main" } },
    doc: "A pending card's place on this computer, and where it moved from; transient (presence is live state).",
  }),
} as const;
