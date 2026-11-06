// Sample usage for the gallery and the tests: 30 days of rows from every source on two computers, and plan readings.
// Made from a fixed seed and a fixed "now", so every picture and every count is the same on every run. Sample data,
// never a user's.

import type { PlanReading, UsageRow, UsageSource } from "./model/usage";

/** 2026-11-05 15:20 UTC. */
export const NOW = Date.UTC(2026, 10, 5, 15, 20, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface Kind {
  source: UsageSource;
  model: string;
  provider: string;
  /** Dollars per million input and output tokens; none for a subscription. */
  price?: [number, number];
  bots?: string[];
  weight: number;
}

const KINDS: Kind[] = [
  { source: "clover", model: "claude-sonnet-4-6", provider: "anthropic", price: [3, 15], bots: ["alpha", "scout"], weight: 5 },
  { source: "clover", model: "gpt-5.4-mini", provider: "openai", price: [0.4, 1.6], bots: ["scout"], weight: 3 },
  { source: "clover", model: "grok-4-fast", provider: "xai", price: [0.2, 0.5], bots: ["alpha"], weight: 2 },
  { source: "codex", model: "gpt-5.4", provider: "openai", weight: 4 },
  { source: "claude-code", model: "claude-opus-4-6", provider: "anthropic", weight: 3 },
  { source: "opencode", model: "openrouter/qwen3-coder", provider: "openrouter", price: [0.3, 1.2], weight: 1 },
];

export function sampleRows(days = 30, seed = 7): UsageRow[] {
  const random = prng(seed);
  const rows: UsageRow[] = [];
  const total = KINDS.reduce((s, k) => s + k.weight, 0);
  let n = 0;
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = Math.floor((NOW - d * DAY) / DAY) * DAY;
    // Quieter at the weekend, busier mid-week; today only up to now.
    const weekday = new Date(dayStart).getUTCDay();
    const busy = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const turns = Math.round((8 + random() * 22) * busy);
    for (let i = 0; i < turns; i++) {
      const at = dayStart + Math.floor(random() * DAY);
      if (at > NOW) continue;
      let pick = random() * total;
      const kind = KINDS.find((k) => (pick -= k.weight) < 0) ?? KINDS[0]!;
      const inputTokens = Math.round(2_000 + random() * 60_000);
      const outputTokens = Math.round(200 + random() * 6_000);
      const computer = random() < 0.75 ? "Studio" : "Pocket laptop";
      rows.push({
        id: `${computer}:${++n}`,
        computer,
        source: kind.source,
        at,
        provider: kind.provider,
        model: kind.model,
        bot: kind.bots ? kind.bots[Math.floor(random() * kind.bots.length)] : undefined,
        session: kind.source === "clover" ? `s-${Math.floor(random() * 9)}` : undefined,
        inputTokens,
        outputTokens,
        costUsd: kind.price ? (inputTokens * kind.price[0] + outputTokens * kind.price[1]) / 1e6 : undefined,
      });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

export const SAMPLE_PLANS: PlanReading[] = [
  { source: "codex", computer: "Studio", plan: "Pro", window: "5h", usedPercent: 81, resetsAt: NOW + 2 * HOUR + 14 * 60_000, readAt: NOW - 4 * 60_000 },
  { source: "codex", computer: "Studio", plan: "Pro", window: "weekly", usedPercent: 46, resetsAt: NOW + 3 * DAY, readAt: NOW - 4 * 60_000 },
  { source: "claude-code", computer: "Studio", plan: "Max", window: "5h", usedPercent: 23, resetsAt: NOW + 4 * HOUR, readAt: NOW - 2 * 60_000 },
  { source: "claude-code", computer: "Studio", plan: "Max", window: "weekly", usedPercent: 94, resetsAt: NOW + 26 * HOUR, readAt: NOW - 2 * 60_000 },
  { source: "antigravity", computer: "Studio", plan: "Free", window: "daily", usedPercent: 100, resetsAt: NOW + 9 * HOUR, readAt: NOW - 9 * HOUR },
];
