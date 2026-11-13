// cdp.ts against a stand-in DevTools endpoint (no browser): a target attached before its page loaded is named by its
// first address (about:blank), and `Target.targetInfoChanged` gives it its own address, as a surface window (the island)
// gets once it loads. The 14e gate's row 42 found no island target without it.
import { afterEach, expect, test } from "bun:test";
import { Cdp } from "./cdp";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

test("a target's address follows Target.targetInfoChanged after it attached as about:blank", async () => {
  let socket: { send(data: string): void } | undefined;
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser` });
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("no", { status: 404 });
    },
    websocket: {
      open(ws) { socket = ws; },
      // Every command answers at once with an empty result.
      message(ws, data) { const m = JSON.parse(String(data)) as { id: number }; ws.send(JSON.stringify({ id: m.id, result: {} })); },
    },
  });
  const cdp = await Cdp.connect(server.port!);
  const send = (m: object) => socket!.send(JSON.stringify(m));
  send({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "about:blank" } } });
  send({ method: "Target.attachedToTarget", params: { sessionId: "S2", targetInfo: { targetId: "T2", type: "page", url: "clover-core://app/" } } });
  await Bun.sleep(50);
  expect(cdp.frames.get("S1")?.url).toBe("about:blank");
  send({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "T1", type: "page", url: "clover-core://app/?surface=island" } } });
  await Bun.sleep(50);
  expect(cdp.frames.get("S1")?.url).toBe("clover-core://app/?surface=island");
  // Another target's change touches only its own.
  expect(cdp.frames.get("S2")?.url).toBe("clover-core://app/");
  expect([...cdp.frames.values()].find((f) => f.type === "page" && f.url.startsWith("clover-core://app/?surface=island"))?.session).toBe("S1");
  cdp.close();
});
