// The plan windows Codex sessions report while they run: the runtime's `rate_limit_event` frames (the agent SDK's
// subscription-shaped quota report: a five-hour or seven-day window, its status, utilization and reset), which the
// projector observes and never persists. The usage service reads them back as the Codex plan's fallback when the user's
// own Codex install can't answer (`mossCodexWindows`). Kept in memory, the latest report per window kind, since the
// daemon started. Nothing is estimated and nothing is fetched from a provider. It becomes a `usage.sources` entry with
// the rest of the readers.

/** A plan-window report, as the projector hands it over (the SDK's `SDKRateLimitInfo`). */
export interface RateLimitInfo {
  status?: unknown;
  rateLimitType?: unknown;
  resetsAt?: unknown;
  utilization?: unknown;
}

export interface ReportedPlanWindow {
  rateLimitType?: string;
  status: string;
  utilization?: number;
  /** Epoch ms. */
  resetsAt?: number;
  at: number;
  sessionId: string;
  /** The provider the reporting session's model names (`codex-oauth`, …), when known. */
  provider?: string;
}

/** Window kinds held at most (the SDK names six). */
const MAX_WINDOWS = 16;

/** PURE: the runtime's `resetsAt` (unix SECONDS: the provider runtime's `quotaEvent` writes `Math.round(resumeAt / 1000)`)
 *  as epoch ms. */
export function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v * 1000);
}

function str(v: unknown, max = 64): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export class PlanWindowReports {
  private readonly windows = new Map<string, ReportedPlanWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A `rate_limit_event`'s info, from a session's projector. Only the four named scalars are read. */
  noteRateLimit(sessionId: string, info: RateLimitInfo, provider?: string): void {
    const status = str(info.status);
    if (status === undefined) return;
    const rateLimitType = str(info.rateLimitType);
    const key = `${provider ?? ""}\u0000${rateLimitType ?? "unspecified"}`;
    const utilization = num(info.utilization);
    const resetsAt = epochMs(info.resetsAt);
    this.windows.delete(key);
    this.windows.set(key, {
      ...(rateLimitType === undefined ? {} : { rateLimitType }), status,
      ...(utilization === undefined ? {} : { utilization }), ...(resetsAt === undefined ? {} : { resetsAt }),
      at: this.now(), sessionId, ...(provider === undefined ? {} : { provider: provider.slice(0, 64) }),
    });
    while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value as string);
  }

  /** The windows a provider's sessions reported (the Codex plan's fallback: `codex-oauth`), newest first. */
  windowsFor(provider: string): ReportedPlanWindow[] {
    return [...this.windows.values()].filter((w) => w.provider === provider).sort((a, b) => b.at - a.at);
  }
}
