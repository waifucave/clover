// `pluginLoadDenies` on Windows' path forms (#234's check 5): a UNC share and a `\\?\` path keep a form the Windows
// sandbox matches, and a write there is refused.
import { expect, test } from "bun:test";
import { pluginLoadDenies, writesPluginLoadDeny } from "../fence";

test("a UNC share's denies stop at the share, in backslashes", () => {
  const d = pluginLoadDenies(["\\\\server\\share\\home\\plugins"]);
  expect(d).toEqual(["\\\\server\\share\\home\\plugins\\node_modules", "\\\\server\\share\\home\\node_modules", "\\\\server\\share\\node_modules"]);
  expect(writesPluginLoadDeny({ op: "write", path: "\\\\server\\share\\node_modules\\dep\\index" }, d, "windows")).toBe("\\\\server\\share\\node_modules");
  expect(writesPluginLoadDeny({ op: "write", path: "\\\\SERVER\\Share\\Node_Modules\\dep" }, d, "windows")).toBe("\\\\server\\share\\node_modules");
  expect(writesPluginLoadDeny({ op: "write", path: "\\\\server\\share\\notes.txt" }, d, "windows")).toBeUndefined();
});

test("a \\\\?\\ path is denied both as written and in its plain form", () => {
  const d = pluginLoadDenies(["\\\\?\\C:\\Users\\me\\plugins"]);
  expect(d).toEqual(expect.arrayContaining(["\\\\?\\C:\\Users\\node_modules", "C:\\Users\\node_modules", "C:\\node_modules", "C:\\Users\\me\\plugins\\node_modules"]));
  for (const path of ["C:\\Users\\node_modules\\dep\\index", "c:\\users\\NODE_MODULES\\dep", "\\\\?\\C:\\Users\\node_modules\\dep"]) {
    expect([path, writesPluginLoadDeny({ op: "write", path }, d, "windows") !== undefined]).toEqual([path, true]);
  }
  const unc = pluginLoadDenies(["\\\\?\\UNC\\server\\share\\p"]);
  expect(unc).toEqual(expect.arrayContaining(["\\\\?\\UNC\\server\\share\\node_modules", "\\\\server\\share\\node_modules"]));
  expect(writesPluginLoadDeny({ op: "write", path: "\\\\server\\share\\node_modules\\x" }, unc, "windows")).toBe("\\\\server\\share\\node_modules");
});

test("a drive path and a POSIX path climb to their roots", () => {
  expect(pluginLoadDenies(["C:\\Users\\me\\plugins"])).toEqual(["C:\\Users\\me\\plugins\\node_modules", "C:\\Users\\me\\node_modules", "C:\\Users\\node_modules", "C:\\node_modules"]);
  expect(pluginLoadDenies(["/Users/me/plugins"])).toEqual(["/Users/me/plugins/node_modules", "/Users/me/node_modules", "/Users/node_modules", "/node_modules"]);
});
