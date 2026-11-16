// The ActivityFeed conformance suite (spec revision 19, §3.6, G4). `runActivityFeedConformance(make)` registers every case
// against the implementation `make` builds; `tests/activity-feed.test.ts` runs it against FakeActivityFeed, and lane AF
// runs it against the engine's feed. What it pins: states and names only, readers by kind, and no repeat of an
// unchanged state.
import { describe, expect, test } from "bun:test";
import { ACTIVITY_STATES, type ActivityView } from "@waifucave/moss-protocol";
import { isContractError } from "../common";
import type { FakeActivityFeed } from "../fakes/activity-feed";

export type ActivityFeedHarness = Pick<FakeActivityFeed, keyof FakeActivityFeed>;
export type ActivityFeedFactory = () => ActivityFeedHarness;

const bot = (state: ActivityView["state"], extra: Partial<ActivityView> = {}): ActivityView => ({ subject: { kind: "bots", id: "alpha" }, state, name: "Alpha", since: 1, ...extra });
const code = (state: ActivityView["state"]): ActivityView => ({ subject: { kind: "sessions", id: "s_code1" }, state, name: "Fix the build", since: 1 });

export function runActivityFeedConformance(make: ActivityFeedFactory): void {
  describe("ActivityFeed", () => {
    test("the eight states, a name and a tool's name go in; text, arguments or card words never do", () => {
      const feed = make();
      expect([...ACTIVITY_STATES]).toEqual(["idle", "listening", "thinking", "working", "asking", "stuck", "done", "asleep"]);
      feed.set(bot("working", { tool: "Bash" }));
      expect(feed.list("bots", { kind: "user" })).toEqual([bot("working", { tool: "Bash" })]);
      for (const extra of [{ text: "hello" }, { input: { command: "rm -rf /" } }, { card: "Delete the folder?" }]) {
        expect(isContractError((() => { try { feed.set({ ...bot("asking"), ...extra } as ActivityView); } catch (e) { return e; } })(), "invalid")).toBe(true);
      }
      expect(isContractError((() => { try { feed.set(bot("working", { tool: "Bash -c 'rm'" })); } catch (e) { return e; } })(), "invalid")).toBe(true);
      expect(feed.list("bots", { kind: "user" })[0]!.state).toBe("working");
    });

    test("a plugin reads only the kinds it was granted; a watch of one kind never hears the other", () => {
      const feed = make();
      const botsOnly = { kind: "plugin" as const, capabilities: ["activity.read.bots"] };
      const heard: string[] = [];
      feed.watch("bots", botsOnly, (v) => heard.push(`${v.subject.kind}:${v.state}`));
      feed.set(code("thinking"));
      feed.set(bot("thinking"));
      expect(heard).toEqual(["bots:thinking"]);
      expect(feed.list("bots", botsOnly).length).toBe(1);
      expect(isContractError((() => { try { feed.list("sessions", botsOnly); } catch (e) { return e; } })(), "refused")).toBe(true);
      expect(isContractError((() => { try { feed.watch("sessions", { kind: "plugin", capabilities: ["conversation.read", "sessions.read"] }, () => {}); } catch (e) { return e; } })(), "refused")).toBe(true);
      expect(feed.list("sessions", { kind: "user" }).map((v) => v.subject.id)).toEqual(["s_code1"]);
    });

    test("an unchanged state is heard once; a removed subject leaves the list", () => {
      const feed = make();
      const heard: string[] = [];
      feed.watch("bots", { kind: "user" }, (v) => heard.push(v.state));
      feed.set(bot("idle"));
      feed.set(bot("idle", { since: 2 }));
      feed.set(bot("done"));
      expect(heard).toEqual(["idle", "done"]);
      feed.remove({ kind: "bots", id: "alpha" });
      expect(feed.list("bots", { kind: "user" })).toEqual([]);
    });
  });
}
