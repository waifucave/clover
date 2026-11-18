// MOSS's side of one release for everything (spec §3.1 "One release for everything"; R4; lane PK). The logic is the apps'
// shared one (`@waifucave/moss-app-release/release`: `createRelease`, its `ReleaseCatchUp` and `BringWatch`), the same MOSS
// Code runs; this file says it in MOSS's words and offers the person's two choices:
//
//   * BEHIND (the hello was refused, or `release_changed` says a newer app brings a newer engine): MOSS updates itself before it
//     connects. Its window says it is updating, or plainly that it is offline and connects once it has updated, or that it
//     can't update (and the command that starts over with this copy's engine).
//   * AHEAD (served the release door only): MOSS asks the engine to bring its release (`release.bring`, from its own bundle),
//     says it waits for work to finish, and offers "Switch now"; through the switch, if the new engine never answers, it says
//     so and offers "Try again".
//
// The window draws the words in its connection banner (shared/view.ts `connection.reason`); the two choices are a sheet on
// MOSS's window (index.ts), since MOSS's window draws no button of the engine's.
// Pure: the tests drive it under Bun.
import type { ReleaseNotice } from "@waifucave/moss-app-release/release";
import type { ConnectionKind } from "../shared/view";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What MOSS's banner says for a release notice: the connection's kind (MOSS isn't connected while any notice is up) and
 *  its words. */
export function releaseBanner(n: ReleaseNotice): { kind: ConnectionKind; reason: string } {
  switch (n.kind) {
    case "updating":
      return n.phase === "installing"
        ? { kind: "behind", reason: `Installing the MOSS update (release ${n.needs}). MOSS opens again by itself.` }
        : { kind: "behind", reason: `Updating MOSS to release ${n.needs}, the engine's, before it connects…` };
    case "offline":
      return { kind: "behind", reason: `MOSS needs release ${n.needs} to talk to the engine and can't reach the update server. It keeps trying, and connects once it has updated.` };
    case "cannot":
      return { kind: "behind", reason: `MOSS needs release ${n.needs} to talk to the engine and couldn't update itself.${n.command !== undefined ? ` To start over with this copy's engine, quit MOSS and MOSS Code, then run: ${n.command}` : ""}` };
    case "waiting": {
      const work = [n.turns > 0 ? plural(n.turns, "turn") : undefined, n.agents > 0 ? plural(n.agents, "agent") : undefined].filter((x) => x !== undefined);
      return { kind: "connecting", reason: `This MOSS (release ${n.incoming}) is newer than the engine: it is waiting for work to finish${work.length > 0 ? ` (${work.join(" and ")} running)` : ""} before the engine switches to it.` };
    }
    case "switching":
      return { kind: "starting-engine", reason: `Switching the engine to release ${n.incoming}…` };
    case "engine-down":
      return { kind: "unavailable", reason: `The engine hasn't answered since it switched to release ${n.incoming}.` };
  }
}

/** The person's choice a notice offers, as a sheet on MOSS's window: "Switch now" while it waits, "Try again" when the new
 *  engine never answered; none otherwise. */
export function releaseChoice(n: ReleaseNotice | undefined): { act: "switch" | "retry"; message: string; detail: string; buttons: [string, string] } | undefined {
  if (n?.kind === "waiting") return { act: "switch", message: "Switch to the newer MOSS now?", detail: `${releaseBanner(n).reason} Switching now stops what is running.`, buttons: ["Switch now", "Keep waiting"] };
  if (n?.kind === "engine-down") return { act: "retry", message: "The engine hasn't started", detail: releaseBanner(n).reason, buttons: ["Try again", "Not now"] };
  return undefined;
}

/** Whether a new notice asks the person again: a new kind of choice, or the same one for another release (the waiting counts
 *  changing doesn't ask twice). */
export function asksAgain(before: ReleaseNotice | undefined, now: ReleaseNotice | undefined): boolean {
  const a = releaseChoice(before), b = releaseChoice(now);
  if (b === undefined) return false;
  if (a === undefined || a.act !== b.act) return true;
  const rel = (n: ReleaseNotice | undefined) => (n !== undefined && "incoming" in n ? n.incoming : undefined);
  return rel(before) !== rel(now);
}
