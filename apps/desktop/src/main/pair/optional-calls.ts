// A setup call the daemon may not serve yet (a lane's method not wired, or a daemon older than the app): its absence
// leaves that part at the defaults and is said once, instead of failing the whole setup. Anything else still throws.
import { RpcCallError, type DaemonClient } from "../protocol/client";

const METHOD_NOT_FOUND = -32601;

/** Whether `err` is the daemon saying it doesn't serve the method: JSON-RPC's "method not found", or the daemon's own
 *  "is not served yet" message. */
export function notServed(err: unknown): boolean {
  return err instanceof RpcCallError && (err.code === METHOD_NOT_FOUND || /not served yet/i.test(err.message));
}

export class OptionalCalls {
  readonly #said = new Set<string>();
  constructor(private readonly log: (line: string) => void) {}

  /** The method's answer, or `undefined` when the daemon doesn't serve it yet (said once per method). */
  async call(client: Pick<DaemonClient, "request">, method: string): Promise<unknown | undefined> {
    try {
      return await client.request<unknown>(method);
    } catch (err) {
      if (!notServed(err)) throw err;
      if (!this.#said.has(method)) {
        this.#said.add(method);
        this.log(`pair: the daemon doesn't serve ${method} yet; the app runs without it and asks again`);
      }
      return undefined;
    }
  }
}
