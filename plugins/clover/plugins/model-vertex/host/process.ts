// clover/model-vertex in a process of its own (spec §5.2): its adapter signs with its secret, so it runs where
// `secrets.get` exists and nowhere else. Clover's plugin host runs `index.ts` in a Bun process of its own
// (`host.process: "own"`); this entry serves the same adapter over a process's stdin and stdout (provider-runtime's
// `serveModelAdapterProcess`), which the core's conformance kit runs it through.
import { serveModelAdapterProcess } from "@waifucave/clover-provider-runtime";
import { modelAdapter } from "./index";

await serveModelAdapterProcess(() => modelAdapter);
