// The fence's node_modules denies follow the development folders live (#234's check 5, K3).
import { expect, test } from "bun:test";
import { selfGrantDenyWrite } from "../../runtime-sdk/mode-options";
import { registerPluginLoadFolders } from "../../runtime-sdk/plugin-load-folders";

test("a development folder added now is in the next deny list, and one removed leaves it", () => {
  let dev: string[] = [];
  const unregister = registerPluginLoadFolders("/h", () => dev);
  try {
    expect(selfGrantDenyWrite("/h")).not.toContain("/x/dev/node_modules");
    dev = ["/x/dev/luna"];
    expect(selfGrantDenyWrite("/h")).toEqual(expect.arrayContaining(["/x/dev/luna/node_modules", "/x/dev/node_modules", "/x/node_modules", "/node_modules"]));
    dev = [];
    expect(selfGrantDenyWrite("/h")).not.toContain("/x/dev/node_modules");
  } finally {
    unregister();
  }
  dev = ["/x/dev/luna"];
  expect(selfGrantDenyWrite("/h")).not.toContain("/x/dev/node_modules");
});
