// clover/model-vertex in a process of its own (spec §5.2): its adapter signs with its secret, so it runs where
// `secrets.get` exists and nowhere else. The plugin host starts this entry; it serves the adapter over the process's
// stdin and stdout (provider-runtime's `serveModelAdapterProcess`), asking the host for the secret per call.
import { serveModelAdapterProcess } from "@waifucave/clover-provider-runtime";
import { modelAdapter } from "./index";

await serveModelAdapterProcess(() => modelAdapter);
