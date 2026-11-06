// A layer document's boot (spec §5.5): it learns which mount it is, loads the plugin's client module from the layer's
// own origin (the `clover` layer: the bundle of everything under `clover`, built with the app), and renders the
// entry's component. React and the UI API come from the layer's one copy, through the document's import map.
import { createRoot } from "react-dom/client";
import { configureLayer, LayerRoot, type ClientModule } from "@waifucave/clover-plugin-sdk/ui";
import type { MountInfo } from "@waifucave/clover-plugin-sdk/ui/bridge";

function fail(text: string): void {
  const p = document.createElement("p");
  p.className = "clover-part-missing";
  p.setAttribute("role", "status");
  p.textContent = text;
  document.getElementById("clover-root")?.replaceChildren(p);
}

/** A dynamic import the bundler leaves alone: the module is served at run time from this origin. */
const load = (url: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ url);

async function boot(): Promise<void> {
  const bridge = window.cloverLayer;
  if (bridge === undefined) return fail("This part can't reach Clover.");
  let info: MountInfo;
  try {
    info = await bridge.describe();
  } catch (err) {
    return fail(`This part couldn't start: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (info.module === undefined) {
    configureLayer({ bridge });
    return fail(`${info.pluginId}'s client entry isn't a built JavaScript module.`);
  }
  // The `clover` bundle carries a module per child plugin; any other layer's module is its plugin's own. A module
  // that never delivers (a bad bundle, an old build served somewhere) still says so: an unhandled rejection would
  // leave the document empty.
  let mod: Record<string, unknown>;
  try {
    mod = await load(info.module);
  } catch (err) {
    return fail(`This part couldn't start: its client module failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  const modules = (mod.modules as Record<string, ClientModule> | undefined) ?? { [info.pluginId]: mod as ClientModule };
  configureLayer({ bridge, modules });
  createRoot(document.getElementById("clover-root")!).render(<LayerRoot info={info} />);
}

void boot();
