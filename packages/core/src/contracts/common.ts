// What every contract in `packages/core/src/contracts/` shares: typed failures and listener sets.
//
// The contracts are the spine's interfaces between lanes (plan §3). Each one has an in-memory fake in `fakes/`, and
// the tests in `tests/` pin each fake's behaviour, so a lane can build against the fake and trust it to act as the real
// implementation will. The real implementations live in their owners' folders and pass the same tests where a test
// is not about the fake itself. After the spine merges, a contract changes only through the controller (plan §3).
import { CLOVER_ERR } from "@waifucave/clover-protocol";

export type Unsubscribe = () => void;

/** The failures a contract reports. Lanes branch on the code, never on a message's text. */
export const CONTRACT_ERROR_CODES = [
  /** The computer is off or unreachable; answered at once, never after a hang (§9.1). */
  "computer_offline",
  /** The plugin is stopped (after crashes, or by the user); the message carries the reason (§5.1). */
  "plugin_stopped",
  /** A call names a plugin, handler or command that isn't installed (§5.4). */
  "not_installed",
  /** No live connection to the computer running the bot, so the user's message can't be sent (§6.4). */
  "bot_asleep",
  /** The fence refuses the path (§9.1). */
  "fenced",
  /** This device doesn't hold the main computer's lease, or may no longer act on it (§6.4). */
  "not_main",
  /** The secret store is locked: no approved key store, or not yet unlocked (S8). */
  "locked",
  /** The peer device can't be reached over any path (§8.2). */
  "offline",
  /** Another session holds the app, window or tab (§9.2, §12.1). */
  "held",
  /** The user is working in that app; their message or a card answer lifts the mark (§9.2). */
  "user_working",
  /** The agent needs its own sign-in, which the user does themselves (spike S5 §7). */
  "sign_in",
  "not_found",
  "timeout",
  "cancelled",
  /** Refused by a rule this contract states (a capability, a viewport, a size, an id already taken). */
  "refused",
  "conflict",
  /** The other side is in the middle of something (a session running a turn); the same call succeeds once it ends, so
   *  a caller tries again rather than giving up. */
  "busy",
  "invalid",
  "closed",
  /** Handler code threw; the message is the handler's, never a secret. */
  "failed",
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

/** The JSON-RPC error code each contract failure travels as, where the protocol has one (`CLOVER_ERR`). */
export const RPC_ERROR_OF: Partial<Record<ContractErrorCode, number>> = {
  computer_offline: CLOVER_ERR.COMPUTER_OFFLINE,
  plugin_stopped: CLOVER_ERR.PLUGIN_STOPPED,
  not_installed: CLOVER_ERR.NOT_INSTALLED,
  bot_asleep: CLOVER_ERR.BOT_ASLEEP,
  fenced: CLOVER_ERR.FENCED,
  not_main: CLOVER_ERR.NOT_MAIN,
};

/** A contract's typed failure. Its message and detail never hold a secret's value. */
export class ContractError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ContractError";
  }

  /** As it crosses a link or the socket: structured-clone data. */
  toJSON(): { code: ContractErrorCode; message: string; detail?: Readonly<Record<string, unknown>> } {
    return this.detail === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, detail: this.detail };
  }

  static fromJSON(value: unknown): ContractError {
    const v = (typeof value === "object" && value !== null ? value : {}) as { code?: unknown; message?: unknown; detail?: unknown };
    const code = (CONTRACT_ERROR_CODES as readonly string[]).includes(String(v.code)) ? (v.code as ContractErrorCode) : "failed";
    const detail = typeof v.detail === "object" && v.detail !== null ? (v.detail as Record<string, unknown>) : undefined;
    return new ContractError(code, typeof v.message === "string" ? v.message : "failed", detail);
  }
}

export function isContractError(err: unknown, code?: ContractErrorCode): err is ContractError {
  return err instanceof ContractError && (code === undefined || err.code === code);
}

/** A set of listeners; a listener that throws never stops the others. */
export class Listeners<T> {
  readonly #fns = new Set<(value: T) => void>();
  add(fn: (value: T) => void): Unsubscribe {
    this.#fns.add(fn);
    return () => {
      this.#fns.delete(fn);
    };
  }
  emit(value: T): void {
    for (const fn of [...this.#fns]) {
      try {
        fn(value);
      } catch {
        // A listener's own failure is its own; the contract keeps going.
      }
    }
  }
  get size(): number {
    return this.#fns.size;
  }
}

/** A POSIX path, normalized: `.` and `..` resolved, no trailing slash. The fakes speak POSIX paths; the real
 *  implementations canonicalize per OS (case, aliases, symlinks, drive letters, 8.3 names). */
export function normalizePosix(path: string): string {
  const abs = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const joined = out.join("/");
  if (abs) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** Whether `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
  const p = normalizePosix(path);
  const r = normalizePosix(root);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/** Base64 to bytes; null for text that isn't base64. */
export function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
