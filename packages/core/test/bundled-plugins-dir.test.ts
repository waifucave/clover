// The bundled plugins folder is derived only from an installed layout, and a server's <home>/plugins (the user's own
// folder) is never treated as bundled.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { bundledPluginsDir } from "../src/bundled-plugins-dir";

const HOME = "/srv/clover-home";

test("an app's core in resources/daemon/ has resources/plugins", () => {
  expect(bundledPluginsDir("/Applications/Clover.app/Contents/Resources/daemon/clover-core", HOME)).toBe("/Applications/Clover.app/Contents/Resources/plugins");
  expect(bundledPluginsDir("/opt/Clover/resources/daemon/clover-core")).toBe("/opt/Clover/resources/plugins");
});

test("a server's core in <home>/bin/daemon/ has <home>/bin/plugins", () => {
  expect(bundledPluginsDir(join(HOME, "bin", "daemon", "clover-core"), HOME)).toBe(join(HOME, "bin", "plugins"));
});

test("a server's <home>/plugins is never bundled, whatever the layout", () => {
  for (const exec of [join(HOME, "bin", "clover-core"), join(HOME, "daemon", "clover-core"), join(HOME, "bin", "daemon", "clover-core")]) {
    expect(bundledPluginsDir(exec, HOME)).not.toBe(join(HOME, "plugins"));
  }
  // The old server layout, <home>/bin/clover-core, has none at all.
  expect(bundledPluginsDir(join(HOME, "bin", "clover-core"), HOME)).toBeUndefined();
  // A daemon folder directly in the home (whose ../plugins is <home>/plugins) has none.
  expect(bundledPluginsDir(join(HOME, "daemon", "clover-core"), HOME)).toBeUndefined();
  // A bin/daemon/ that isn't this home's.
  expect(bundledPluginsDir("/elsewhere/bin/daemon/clover-core", HOME)).toBeUndefined();
});

test("anything else (a dev checkout, plain bun) has none", () => {
  expect(bundledPluginsDir("/Users/me/clover/dist/daemon/darwin-arm64/clover-core", HOME)).toBeUndefined();
  expect(bundledPluginsDir("/opt/homebrew/bin/bun", HOME)).toBeUndefined();
  expect(bundledPluginsDir("/tmp/x/daemon/clover-core", HOME)).toBeUndefined();
});
