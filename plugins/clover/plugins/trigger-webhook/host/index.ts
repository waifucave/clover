// The webhook trigger's host half (clover/trigger-webhook, spec §7). Owner: lane D.
//
// It declares `webhook.ingress`, the point the forwarder (and a tunnel, or a cloud computer) fills, so ingress entries
// come up only while this plugin is on. The core's routine engine plays the trigger's part with this plugin's own
// functions (src/webhook.ts) until lane B's plugin API carries a trigger's calls: it registers each webhook routine
// with every ingress by its key's hash, long-polls them, runs each delivery once, and acks or drops it.
//
// Exports:
//   webhook   the handler of this plugin's `triggers` entry: `check` and `label`
import { untrusted } from "../src/webhook";

export const webhook = {
  /** Whether a routine file's webhook trigger reads (`- webhook: true`). */
  check(args: { fields: unknown }): { ok: true; summary: string } | { ok: false; reason: string } {
    const f = args.fields as { webhook?: unknown } | null | undefined;
    if (f?.webhook !== true) return { ok: false, reason: "a webhook trigger is `webhook: true`" };
    return { ok: true, summary: "a webhook URL with its key" };
  },
  /** A payload as the bot sees it: labelled untrusted, fenced, cut to size. */
  label(args: { source?: string; body: string; contentType?: string }): { text: string } {
    if (typeof args.body !== "string") throw new TypeError("`body` is text");
    return { text: untrusted(args.source ?? "a webhook", args.body, args.contentType) };
  },
};
