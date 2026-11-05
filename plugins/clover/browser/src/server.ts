// A small MCP server, written by hand on lane B's in-process `McpServerTransport`: JSON-RPC 2.0 with `initialize`,
// `notifications/initialized`, `ping`, `tools/list` and `tools/call`, and `notifications/cancelled` to stop a call.
// It needs no SDK: the transport hands over parsed messages and takes objects back.
//
// Nothing a tool does is thrown out of here. A tool's own failure is a result with `isError: true`; only a malformed
// request, an unknown method or an unknown tool gets a JSON-RPC error, as MCP says.
import type { ToolResult } from "./tool";
import type { McpServerTransport } from "./types";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
/** Versions this server speaks; a client asking for one of them gets it, any other client gets the latest. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const JSONRPC_ERRORS = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown> | { readonly [key: string]: unknown };
  annotations?: Record<string, unknown>;
}

export interface McpServerOptions {
  info: { name: string; title?: string; version: string };
  tools: readonly McpToolDefinition[];
  /** Runs one tool. `params` is the whole request's (with its `_meta`); `signal` aborts on cancellation or close. */
  call(name: string, args: unknown, request: { params: Record<string, unknown>; signal: AbortSignal }): Promise<ToolResult>;
  instructions?: string;
  /** Where the server's own trouble goes; by default the console, which is the plugin's log. */
  log?: (line: string) => void;
}

export interface McpServerHandle {
  close(): Promise<void>;
  /** Settles when the transport closes, from either side. */
  readonly closed: Promise<void>;
}

type RequestId = string | number;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRequestId = (v: unknown): v is RequestId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const idKey = (id: RequestId): string => `${typeof id}:${String(id)}`;

export async function serveMcp(transport: McpServerTransport, opts: McpServerOptions): Promise<McpServerHandle> {
  const inflight = new Map<string, AbortController>();
  let isClosed = false;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const shutDown = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    markClosed();
  };

  // A host half's console output goes to its plugin's log (§5.4).
  const log = opts.log ?? ((line: string) => console.warn(`${opts.info.name}: ${line}`));
  const send = (message: Record<string, unknown>): void => {
    if (isClosed) return;
    transport.send(message).catch((e: unknown) => log(`couldn't send a message: ${e instanceof Error ? e.message : String(e)}`));
  };
  const reply = (id: RequestId, result: Record<string, unknown>): void => send({ jsonrpc: "2.0", id, result });
  const fail = (id: RequestId | null, code: number, message: string): void => send({ jsonrpc: "2.0", id, error: { code, message } });

  const onNotification = (method: string, params: unknown): void => {
    if (method === "notifications/cancelled" && isRecord(params) && isRequestId(params.requestId)) {
      const key = idKey(params.requestId);
      inflight.get(key)?.abort();
      inflight.delete(key);
    }
    // `notifications/initialized` and anything else need nothing from a server with no state to set up.
  };

  const onRequest = async (id: RequestId, method: string, params: Record<string, unknown>): Promise<void> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...opts.info },
          ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
        });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: opts.tools.map((t) => ({ ...t })) });
        return;
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return fail(id, JSONRPC_ERRORS.INVALID_PARAMS, "tools/call needs the tool's name");
        if (!opts.tools.some((t) => t.name === name)) return fail(id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`);
        const controller = new AbortController();
        const key = idKey(id);
        inflight.set(key, controller);
        let result: ToolResult;
        try {
          result = await opts.call(name, params.arguments, { params, signal: controller.signal });
        } catch (e) {
          result = { content: [{ type: "text", text: `The ${name} tool failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
        // A cancelled request gets no answer (MCP: the receiver stops and doesn't respond).
        if (controller.signal.aborted) return;
        inflight.delete(key);
        reply(id, { ...result });
        return;
      }
      default:
        fail(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  const onMessage = async (message: unknown): Promise<void> => {
    if (!isRecord(message)) {
      fail(null, JSONRPC_ERRORS.INVALID_REQUEST, Array.isArray(message) ? "Batches aren't supported" : "Invalid request");
      return;
    }
    const hasId = message.id !== undefined;
    if (typeof message.method !== "string") {
      // A response to a request this server never sends: nothing to do.
      if (hasId && ("result" in message || "error" in message)) return;
      fail(isRequestId(message.id) ? message.id : null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid request");
      return;
    }
    if (message.jsonrpc !== "2.0") {
      if (hasId) fail(isRequestId(message.id) ? message.id : null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid request: jsonrpc must be \"2.0\"");
      return;
    }
    if (!hasId) {
      onNotification(message.method, message.params);
      return;
    }
    if (!isRequestId(message.id)) {
      fail(null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid request id");
      return;
    }
    if (message.params !== undefined && !isRecord(message.params)) {
      fail(message.id, JSONRPC_ERRORS.INVALID_PARAMS, "params must be an object");
      return;
    }
    try {
      await onRequest(message.id, message.method, message.params ?? {});
    } catch (e) {
      fail(message.id, JSONRPC_ERRORS.INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
  };

  transport.onmessage = (message) => {
    void onMessage(message);
  };
  transport.onclose = shutDown;
  transport.onerror = (e) => log(`transport error: ${e.message}`);
  await transport.start();

  return {
    closed,
    async close(): Promise<void> {
      shutDown();
      await transport.close().catch(() => undefined);
    },
  };
}
