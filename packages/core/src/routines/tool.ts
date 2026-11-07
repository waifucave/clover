// The `Routine` tool (spec §6.7, §7): a bot writes a new routine file on the computer it chooses, which then runs it.
// The bot changes a routine afterwards by editing its file with its file tools. Owner: lane D; lane A's runtime
// registers it as a core tool for a bot's sessions, beside `SendMessage` and `ListAgents`.
//
// * The file goes to `home/<Computer>/.clover/routines/<bot>/<name>.md`: here, written directly; on another computer,
//   through the folder tree (`writeRemote`, lane J's), and that computer's engine loads it.
// * A level above that computer's waits for the user's OK on a card before the routine runs at it, as the result says.
// * A webhook trigger's URL comes back; its key stays in the credential store and never reaches the model.
// * The system prompt's advice holds: a routine that must always run belongs on an always-on computer.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LEVELS, levelAbove, type Level } from "@waifucave/clover-protocol";
import { isContractError } from "../contracts/common";
import { botSegment } from "../sessions/ids";
import type { CoreToolDef } from "../bots/tools";
import { routineFilePath, type RoutineEngine } from "./engine";
import { mintRoutineId, parseRoutine, serializeRoutine } from "./file";
import { parseSpec } from "./spec";
import { isTimeZone } from "./zone";

export interface RoutineToolDeps {
  home: string;
  /** This computer's name. */
  computer: string;
  routines: Pick<RoutineEngine, "rescan" | "webhook" | "get">;
  /** The computers a routine may go to, and each one's level (lane J's registry). */
  computers(): { name: string; level: Level }[];
  /** Writes a file on another computer through the folder tree (lane J's); without it, routines go here only. */
  writeRemote?(computer: string, treePath: string, text: string): Promise<void>;
}

function fail(text: string): { text: string; isError: true } {
  return { text, isError: true };
}

export function routineToolDef(deps: RoutineToolDeps, caller: { bot: string }): CoreToolDef {
  return {
    name: "Routine",
    description: [
      "Create a routine: saved instructions that run in a side thread of yours when a trigger fires, on a schedule",
      "(`every 15m`, or a 5-field cron like `0 8 * * 1-5`, in the routine's time zone) or when its webhook URL is called.",
      "Choose the computer that runs it: a routine that must always run belongs on an always-on computer, such as a",
      "cloud computer. Its result posts into your conversation. To change or remove a routine later, edit or delete",
      "its file with your file tools.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name; it also names the file." },
        instructions: { type: "string", description: "What to do when it runs, written to stand on its own." },
        schedule: { type: "string", description: "When it runs: `every <N><s|m|h|d>` or a 5-field cron." },
        webhook: { type: "boolean", description: "Also run it when its webhook URL is called (the URL comes back)." },
        computer: { type: "string", description: "The computer that runs it; this one by default." },
        timezone: { type: "string", description: "An IANA time zone for the schedule; the user's by default." },
        level: { type: "string", enum: [...LEVELS], description: "Its approval level; the computer's by default. One above the computer's waits for the user's OK." },
        missed: { type: "string", enum: ["run-once", "skip"], description: "Runs missed while the computer was off: run once on wake (default) or skip." },
      },
      required: ["name", "instructions"],
      additionalProperties: false,
    },
    run: async (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      const name = typeof i["name"] === "string" ? i["name"].trim() : "";
      const instructions = typeof i["instructions"] === "string" ? i["instructions"].trim() : "";
      if (name === "" || name.length > 200) return fail("Routine needs a name of at most 200 characters.");
      if (instructions === "") return fail("Routine needs its instructions.");
      const schedule = typeof i["schedule"] === "string" ? i["schedule"].trim() : undefined;
      const webhook = i["webhook"] === true;
      if (schedule === undefined && !webhook) return fail("Routine needs a trigger: a schedule, a webhook, or both.");
      if (schedule !== undefined) {
        try {
          parseSpec(schedule);
        } catch (err) {
          return fail(`The schedule doesn't read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const timezone = typeof i["timezone"] === "string" ? i["timezone"] : undefined;
      if (timezone !== undefined && !isTimeZone(timezone)) return fail(`"${timezone}" isn't a time zone (try Europe/London or America/New_York).`);
      const level = typeof i["level"] === "string" ? (i["level"] as Level) : undefined;
      if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) return fail(`The level is one of ${LEVELS.join(", ")}.`);
      const missed = i["missed"] === "skip" ? "skip" : "run-once";
      const computers = deps.computers();
      const computer = typeof i["computer"] === "string" ? i["computer"] : deps.computer;
      const target = computers.find((c) => c.name === computer) ?? (computer === deps.computer ? { name: deps.computer, level: "ask-risky" as Level } : undefined);
      if (target === undefined) return fail(`There is no computer ${computer}; the computers are ${computers.map((c) => c.name).join(", ")}.`);
      const fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "routine";
      const id = mintRoutineId();
      const text = serializeRoutine({
        id, name, missed, body: instructions,
        triggers: [...(schedule === undefined ? [] : [{ type: "schedule" as const, spec: schedule }]), ...(webhook ? [{ type: "webhook" as const }] : [])],
        ...(level === undefined ? {} : { level }), ...(timezone === undefined ? {} : { timezone }),
      });
      if (!parseRoutine(text, fileName).ok) return fail("The routine couldn't be written as a file.");
      const treePath = `home/${target.name}/.clover/routines/${botSegment(caller.bot)}/${fileName}.md`;
      const notes: string[] = [];
      try {
        if (target.name === deps.computer) {
          const path = routineFilePath(deps.home, caller.bot, fileName);
          if (existsSync(path)) return fail(`${treePath} exists already; edit it with your file tools, or choose another name.`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text, { flag: "wx" });
          await deps.routines.rescan();
          if (webhook) notes.push(`Its webhook URL is ${(await deps.routines.webhook(id)).url}; its key is in the user's Settings, never here.`);
        } else {
          if (!deps.writeRemote) return fail(`This computer can't reach ${target.name}'s files yet; create the routine here, or on ${target.name}.`);
          await deps.writeRemote(target.name, treePath, text);
          if (webhook) notes.push(`${target.name} gives its webhook URL once it loads the file; the user finds it in Settings.`);
        }
      } catch (err) {
        return fail(`The routine wasn't created: ${err instanceof Error ? err.message : String(err)}${isContractError(err) ? ` (${err.code})` : ""}`);
      }
      if (level !== undefined && levelAbove(level, target.level)) notes.push(`It asks for ${level}, above ${target.name}'s level (${target.level}): it waits for the user's OK on a card before it runs at it.`);
      return { text: [`Created the routine ${id} in ${treePath}, run by ${target.name}.`, ...notes].join(" "), isError: false };
    },
  };
}
