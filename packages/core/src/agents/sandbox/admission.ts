// Which agents' own sandboxes Clover counts as holding the fence (spec §9.3 "The fence reaches agents through their
// own settings"; spike S8 §8.3). The rule from S8: protection is admitted per exact backend, OS and version, on
// evidence, never on a vendor's word or a flag's name. Only an admitted ("protected") sandbox makes `detect` report
// `sandboxed: true`; every other agent starts only after the user's OK, which says it could read Clover's logins
// and approve its own cards (oks.ts), and Settings marks it.
//
// A protected backend also needs a writer: the fenced set denied in its own format (writers.ts). A row here and its
// writer land together, with the S8-style gates that admit them (`spikes/s8-secrets/agent-floor-gates.py`).
import type { Os } from "@waifucave/clover-protocol";
import type { SandboxPolicy } from "../../contracts/fence";
import type { Obj } from "@waifucave/clover-agent-sdk/acp";
import { versionSatisfies } from "../version";

export type SandboxAdmission =
  /** Gates like S8's passed for this exact configuration. */
  | { status: "protected"; versions: string; evidence: string; writer: SandboxWriter }
  /** It has a sandbox, but nothing here has shown it holds the fence. */
  | { status: "unverified"; reason: string }
  /** Shown not to hold the fence, or no sandbox at all on this OS. */
  | { status: "unsupported"; reason: string };

/** What a writer adds to an agent's start: the fenced set in the backend's own format. Files are written into the
 *  session's own folder (never the user's own config), which the paths in `args`, `env` and `meta` may name. */
export interface SandboxSetup {
  args?: string[];
  env?: Record<string, string>;
  /** Merged into `session/new`'s `_meta` (the Claude adapter's `_meta.claudeCode.options`). */
  meta?: Obj;
  files?: { name: string; content: string }[];
}

export type SandboxWriter = (policy: SandboxPolicy, ctx: { root: string; dir: string }) => SandboxSetup;

/** S8 §8.3, November 5, for the backends lane K runs today. */
export const ADMISSIONS: Readonly<Record<string, Partial<Record<Os, SandboxAdmission>>>> = {
  cursor: {
    macos: { status: "unsupported", reason: "S8: its sandbox let outside-root reads and writes through, and wrote a hidden file on the host" },
    linux: { status: "unsupported", reason: "S8: its unsupported-backend preflight fails closed" },
    windows: { status: "unsupported", reason: "S8: its helper isolates the network only, not files" },
  },
  antigravity: {
    macos: { status: "unverified", reason: "it has a terminal sandbox flag, but no sandbox-only entry point to test it without a model" },
    linux: { status: "unverified", reason: "its namespace sandbox is documented, not tested" },
    windows: { status: "unverified", reason: "its AppContainer sandbox is documented, not tested" },
  },
};

const NONE: SandboxAdmission = { status: "unsupported", reason: "no sandbox of its own is known to hold the fence here" };

/** The admission for one backend on one OS at one version; a protected row counts only inside its versions. */
export function admissionFor(table: Readonly<Record<string, Partial<Record<Os, SandboxAdmission>>>>, backend: string, os: Os, version: string | undefined): SandboxAdmission {
  const row = table[backend]?.[os] ?? NONE;
  if (row.status !== "protected") return row;
  if (version === undefined || !versionSatisfies(version, row.versions)) {
    return { status: "unverified", reason: `its sandbox was admitted for ${row.versions}, not ${version ?? "an unknown version"}` };
  }
  return row;
}
