// The third-party model plugin's provider (fixtures/acceptance-models, row 1.91): a server on this computer, as a local
// model server is (Ollama on 127.0.0.1:11434), which the plugin's OK names by address and port. It answers a turn with
// the reply only when the key the core placed is the run's dummy, and 401 otherwise, and records per request whether
// the key matched (never the key). Nothing leaves the machine.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeModels {
  url: string;
  port: number;
  requests: { path: string; keyMatched: boolean }[];
  stop(): void;
}

export function startFakeModels(o: { key: string; reply: string }): FakeModels {
  const requests: FakeModels["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const keyMatched = req.headers.get("x-api-key") === o.key;
      requests.push({ path, keyMatched });
      if (req.method !== "POST" || path !== "/v1/turn") return new Response("not here", { status: 404 });
      return keyMatched ? new Response(o.reply) : new Response("no key", { status: 401 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, requests, stop: () => void server.stop(true) };
}

/** Copies the fixture to `dest` with its provider at `port` on this computer: its OK names `127.0.0.1:<port>` and its
 *  adapter posts there (`host/endpoint.json`). */
export function placeModelsFixture(src: string, dest: string, port: number): void {
  cpSync(src, dest, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dest, "clover.json"), "utf8")) as { capabilities: string[] };
  manifest.capabilities = [`network:127.0.0.1:${port}`];
  writeFileSync(join(dest, "clover.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dest, "host", "endpoint.json"), `${JSON.stringify({ url: `http://127.0.0.1:${port}/v1/turn` }, null, 2)}\n`);
}
