// `clover-core code-agent` (K-M3b): Clover's coding agent for an outside ACP client (Zed and others), which starts this
// as its agent server. A thin relay: it says hello on the daemon's endpoint as `cli` with the user's terminal token from
// the secret store (never from its arguments or environment, and never written anywhere), opens one coding session for
// the folder it was started in (`codeAgent.open`), then moves ACP lines between its stdio and that session, each
// bounded (`CODE_AGENT_MAX_LINE`). The daemon runs the agent: no credential, setting or run home of the model's ever
// crosses here. It exits when either side closes.
import { CLOVER_PROTOCOL_VERSION, CODE_AGENT_LINE_NOTIFICATION, CODE_AGENT_MAX_LINE, encodeLine, LineDecoder, METHODS, NDJSON_MAX_LINE_BYTES } from "@waifucave/clover-protocol";
import { KeychainSecretStore } from "../../auth/secret-store";
import { TOKEN_NAMES } from "../../auth/tokens";

export interface CodeAgentRelayOptions {
  /** The daemon's endpoint (`<home>/run/core.sock`, or the home's pipe on Windows). */
  endpoint: string;
  /** The folder the client started it in (the process's own by default). */
  cwd?: string;
  /** The user's terminal token (the secret store's by default). */
  token?: () => Promise<string | null | undefined>;
  /** The client's lines (the process's stdin by default). */
  input?: AsyncIterable<Uint8Array>;
  /** Lines to the client (the process's stdout by default). False when it can take no more until `onDrain`. */
  output?: (text: string) => boolean | void;
  /** Calls `fn` once the output can take more (stdout's `drain` by default). */
  onDrain?: (fn: () => void) => void;
  /** What a person reading the client's log should know (the process's stderr by default). Never the token. */
  say?: (text: string) => void;
}

const CLIENT_NAME = "clover-code-agent";
/** The daemon's lines carry an ACP line inside a JSON string: room for it however it was escaped. */
const FROM_DAEMON_MAX_BYTES = 8 * CODE_AGENT_MAX_LINE;
/** A client line in UTF-8, at most four bytes a character. */
const FROM_CLIENT_MAX_BYTES = 4 * CODE_AGENT_MAX_LINE;

/** `clover-core code-agent`: runs the relay on the process's stdio and exits with its code. */
export async function codeAgentMain(endpoint: string): Promise<never> {
  process.exit(await runCodeAgentRelay({ endpoint }));
}

/** The relay; resolves with the exit code when either side closed (0), or it couldn't start (1). */
export async function runCodeAgentRelay(o: CodeAgentRelayOptions): Promise<number> {
  const say = o.say ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const output = o.output ? (text: string) => o.output!(text) !== false : (text: string) => process.stdout.write(text);
  const onDrain = o.onDrain ?? ((fn: () => void) => void process.stdout.once("drain", fn));
  let token: string | null | undefined;
  try {
    token = await (o.token ?? (() => new KeychainSecretStore().get(TOKEN_NAMES.harness)))();
  } catch {
    token = undefined;
  }
  if (!token) {
    say("clover-code-agent: Clover's sign-in for this computer's terminal wasn't found; start Clover once, then try again.");
    return 1;
  }

  let done!: (code: number) => void;
  const finished = new Promise<number>((r) => (done = r));
  let open = false;
  const decoder = new LineDecoder(FROM_DAEMON_MAX_BYTES);
  const pending = new Map<number, { ok(v: unknown): void; fail(e: { code?: number; message: string }): void }>();
  const queue: Uint8Array[] = [];
  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  // The client's side may be slower than the daemon's: past what it takes, the socket's reading pauses until it drains,
  // and the lines already read wait here, in order.
  const held: string[] = [];
  let blocked = false;
  const deliver = () => {
    while (!blocked && held.length > 0) {
      if (output(held.shift()!)) continue;
      blocked = true;
      socket?.pause();
      onDrain(() => {
        blocked = false;
        deliver();
        if (!blocked) socket?.resume();
      });
    }
  };
  const flush = () => {
    while (socket && queue.length > 0) {
      const head = queue[0]!;
      const n = socket.write(head);
      if (n < head.length) {
        queue[0] = head.subarray(Math.max(0, n));
        return;
      }
      queue.shift();
    }
  };
  const send = (bytes: Uint8Array) => {
    queue.push(bytes);
    if (queue.length === 1) flush();
  };
  let over = false;
  const finish = (code: number) => {
    // Once: the first reason to stop gives the exit code (ending the socket calls its close at once).
    if (over) return;
    over = true;
    done(code);
    for (const p of pending.values()) p.fail({ message: "the daemon closed the connection" });
    pending.clear();
    try {
      socket?.end();
    } catch {
      // Already closed.
    }
  };
  try {
    socket = await Bun.connect({
      unix: o.endpoint,
      socket: {
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = decoder.push(chunk);
          } catch {
            say("clover-code-agent: the daemon sent a line too long to relay; stopping.");
            return finish(1);
          }
          for (const line of lines) {
            let m: { id?: unknown; method?: unknown; params?: { line?: unknown }; result?: unknown; error?: { code?: number; message?: string } };
            try {
              m = JSON.parse(line);
            } catch {
              continue;
            }
            if (m.method === CODE_AGENT_LINE_NOTIFICATION && typeof m.params?.line === "string") {
              held.push(`${m.params.line}\n`);
              continue;
            }
            const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
            if (!p) continue;
            pending.delete(m.id as number);
            if (m.error) p.fail({ ...(m.error.code === undefined ? {} : { code: m.error.code }), message: m.error.message ?? "refused" });
            else p.ok(m.result);
          }
          deliver();
        },
        drain() {
          flush();
        },
        close() {
          finish(open ? 0 : 1);
        },
      },
    });
  } catch {
    say("clover-code-agent: Clover isn't running on this computer; start it, then try again.");
    return 1;
  }
  let next = 1;
  const request = (method: string, params: unknown) => new Promise<unknown>((ok, fail) => {
    const id = next++;
    const bytes = encodeLine({ jsonrpc: "2.0", id, method, params });
    // The daemon's endpoint takes no line over its bound, however the message's characters encoded.
    if (bytes.length > NDJSON_MAX_LINE_BYTES) {
      fail({ message: `a message of ${bytes.length} bytes encoded is over the endpoint's ${NDJSON_MAX_LINE_BYTES}` });
      return;
    }
    pending.set(id, { ok, fail });
    send(bytes);
  });

  try {
    await request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "cli", token, clientName: CLIENT_NAME });
  } catch (err) {
    say(`clover-code-agent: Clover refused the connection: ${(err as { message: string }).message}`);
    finish(1);
    return finished;
  }
  token = undefined;
  try {
    await request("codeAgent.open", { cwd: o.cwd ?? process.cwd() });
  } catch (err) {
    say(`clover-code-agent: Clover's coding agent couldn't start here: ${(err as { message: string }).message}`);
    finish(1);
    return finished;
  }
  open = true;

  // The client's lines, in order; one the daemon refuses ends the relay.
  void (async () => {
    const lines = new LineDecoder(FROM_CLIENT_MAX_BYTES);
    try {
      for await (const chunk of o.input ?? (Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>)) {
        let got: string[];
        try {
          got = lines.push(chunk);
        } catch {
          say(`clover-code-agent: a message from the client was over ${CODE_AGENT_MAX_LINE} characters and can't be relayed; stopping.`);
          return finish(1);
        }
        for (const raw of got) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line.trim() === "") continue;
          if (line.length > CODE_AGENT_MAX_LINE) {
            say(`clover-code-agent: a message from the client was over ${CODE_AGENT_MAX_LINE} characters and can't be relayed; stopping.`);
            return finish(1);
          }
          request("codeAgent.send", { line }).catch((err: { message: string }) => {
            say(`clover-code-agent: Clover refused a message: ${err.message}; stopping.`);
            finish(1);
          });
        }
      }
    } catch {
      // The client's side closed.
    }
    finish(0);
  })();
  return finished;
}
