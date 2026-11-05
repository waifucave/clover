#!/usr/bin/env bun
// MCP stub over stdio. The ACP agent starts it from the `mcpServers` entry the probe
// passes at `session/new`. It logs every message it receives (and what it sent back) to
// the file named by --log, never to stdout, which carries the protocol.
//
//   bun src/mcp/stdio-stub.ts --log /abs/mcp-stdio.ndjson [--name s5-stdio] [--tool s5_stdio_echo]
//
// Env: S5_NONCE and S5_INSTRUCTION_WORD (what the tool result and the instructions carry),
// S5_BRIDGE_TOKEN (checked by hash only, standing in for the bridge's per-session token).
import { appendFileSync } from "node:fs";
import { handleMcp, type JsonRpcMessage, type StubConfig } from "./handler.ts";
import { Redactor, sha12 } from "../util/log.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) {
    process.stderr.write(`stdio-stub: missing --${name}\n`);
    process.exit(2);
  }
  return (v ?? fallback)!;
}

const logPath = arg("log");
const cfg: StubConfig = {
  serverName: arg("name", "s5-stdio"),
  toolName: arg("tool", "s5_stdio_echo"),
  nonce: process.env.S5_NONCE ?? "no-nonce",
  instructionWord: process.env.S5_INSTRUCTION_WORD ?? "no-word",
};
const redactor = new Redactor();
const token = process.env.S5_BRIDGE_TOKEN;
if (token) redactor.add(token, "bridge-token");
const t0 = Date.now();

function log(record: Record<string, unknown>) {
  appendFileSync(logPath, JSON.stringify({ ms: Date.now() - t0, ...(redactor.scrub(record) as object) }) + "\n");
}

log({
  kind: "start",
  server: cfg.serverName,
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  // Names only: shows what environment the agent hands an MCP server it starts.
  envNames: Object.keys(process.env).sort(),
  bridgeCheck: token ? `present sha256=${sha12(token)}` : "missing",
});

let buffer = "";
const decoder = new TextDecoder();

function onLine(line: string) {
  if (!line.trim()) return;
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    log({ kind: "bad-json", line: line.slice(0, 500) });
    return;
  }
  const { response, note } = handleMcp(cfg, msg);
  log({ kind: "in", note, msg });
  if (response) {
    process.stdout.write(JSON.stringify(response) + "\n");
    log({ kind: "out", id: response.id, error: response.error ?? undefined });
  }
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    onLine(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
  }
}
log({ kind: "stdin-closed" });
