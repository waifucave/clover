// Saved rules on disk: `<home>/rules/saved-rules.json`, inside the fenced set (`saved-rules`), so no bot, agent or
// plugin can write itself an "always". Written whole, owner-only, through a temp file and a rename; read back
// strictly, so a damaged file loads as no rules (every call asks again) rather than as rules no one saved.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SavedRule } from "../contracts/approval-broker";
import type { RuleStore } from "./broker";

export function savedRulesPath(cloverHome: string): string {
  return join(cloverHome, "rules", "saved-rules.json");
}

const isRule = (r: unknown): r is SavedRule => {
  const o = r as Partial<SavedRule> | null;
  return typeof o === "object" && o !== null && typeof o.ruleKey === "string" && o.ruleKey.length > 0
    && Array.isArray(o.computers) && o.computers.every((c) => typeof c === "string")
    && typeof o.cardId === "string" && typeof o.savedAt === "number";
};

export function fileRuleStore(cloverHome: string): RuleStore {
  const path = savedRulesPath(cloverHome);
  return {
    load() {
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { return []; }
      const doc = JSON.parse(text) as { version?: unknown; rules?: unknown };
      if (doc.version !== 1 || !Array.isArray(doc.rules) || !doc.rules.every(isRule)) throw new Error("saved-rules.json isn't one this broker wrote");
      return doc.rules.map((r) => ({ ruleKey: r.ruleKey, computers: [...r.computers], cardId: r.cardId, savedAt: r.savedAt }));
    },
    save(rules) {
      mkdirSync(join(cloverHome, "rules"), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
  };
}
