# The repo layout

How the Clover repo is laid out (plan §7) and the conventions every package follows. `scripts/layout.test.ts` checks the ones a test can check.

## Where things live

```text
packages/<name>          shared code: protocol, core, cli, plugin-sdk, test-harness
apps/desktop             the Electron app (lane E; its browser parts, src/main/browser/, lane L)
plugins/clover/          Clover's own plugin: its clover.json, and one folder per child
plugins/clover/<child>   a child of it, such as shell, composer, pill or forwarder
plugins/alpha/           Alpha, a top-level plugin of its own, with its children inside
services/<service>       Cloudflare Workers and the web companion
services/shared          source the Workers share; not a package (each Worker's tsconfig includes it)
native/<area>            per-OS helpers in their own languages: sandbox, input, mounts, link-sidecar
apple/                   WinterKit and WinterProtocol for the iOS app; ComputerUse and apple/Winter for reference only, not built
extensions/              Winter for Chrome, until opensky
spikes/<spike>           the spike lanes' experiments, one folder each
examples/<example>       example plugins for the plugin SDK
scripts/                 repo tools, including scripts/heavy (the heavy-job limiter, plan §8)
docs/                    the spec, the plan, these conventions, and research reports
```

## Workspaces

* One workspace list, in the root `package.json` (`workspaces`) and mirrored in `pnpm-workspace.yaml`:
  * `packages/*`, `apps/*`, `services/*`, `native/*`, `spikes/*`, `examples/*`;
  * `plugins/*` for a top-level plugin's own package, and `plugins/*/*` for its children's.
  * A folder is a workspace package when one of these globs matches it and it holds a `package.json`. A deeper folder is not one; ask the controller for a glob if a lane needs it.
* One lockfile: `bun.lock` at the root, with `pnpm-lock.yaml` beside it for pnpm. A package keeps no lockfile of its own (no `package-lock.json`).
* Bun is the runtime and the package manager (`.bun-version` pins it).

## A package

* **Name:** `@waifucave/clover-<name>`, by folder:

  | Folder | Name |
  | :- | :- |
  | `packages/<name>` | `@waifucave/clover-<name>` |
  | `apps/<app>` | `@waifucave/clover-<app>` |
  | `plugins/clover/<child>` | `@waifucave/clover-plugin-<child>` |
  | `plugins/<plugin>` and `plugins/<plugin>/<child>` | `@waifucave/clover-plugin-<plugin>` and `@waifucave/clover-plugin-<plugin>-<child>` |
  | `services/<service>` | `@waifucave/clover-service-<service>` |
  | `native/<area>`, when it has a `package.json` | `@waifucave/clover-native-<area>` |

  Spikes and examples keep the names they have: they are never published.
* **`package.json`:** `"private": true` (nothing here is published from a workspace yet), `"type": "module"`, and a `test` script. A package with TypeScript of its own has a `typecheck` script, `tsc --noEmit -p .`.
* **`tsconfig.json`:** extends `../../tsconfig.base.json` (or `../../../` one level deeper), the one shared base.
* **Tests:** each package runs its own: `bun test` unless it names another runner in its `test` script (a Worker's tests may run under `vitest` with the Workers pool, for example). A test never touches a real home, a real secret store or the network outside the machine: it uses `@waifucave/clover-test-harness` (temp homes, throwaway secret stores, several daemons joined by a fake link, a fake app client, the Workers emulator and a stand-in for the sign-in service).
* **CI:** `scripts/workspaces.ts` lists the packages and runs a script in each. CI runs every package's `test` on macOS, Linux and Windows unless its `package.json` narrows it:

  ```json
  "cloverCi": { "os": ["macos", "linux"] }
  ```

  `"cloverCi": { "ownJob": true }` says `ci.yml` runs its tests in a job of its own (core and cli, which need the built agent binary).

## A plugin

* A top-level plugin is a folder under `plugins/` with a `clover.json` (spec §5.9): `"manifest": 1`, an `id` equal to the folder name, and a `name`. A folder whose manifest an open pull request adds is named in the layout test's `MANIFEST_AWAITS` until it lands.
* A child is a folder inside it with its own `clover.json`, with no `id`: it takes its parent's id and namespace.
* A plugin's code (its host entry, its client entry, its tests) is a workspace package in the same folder, named as above.

## A gallery

* A package with a gallery (a plugin's parts, the base theme) has a `gallery` script. It builds the gallery and renders every story to PNG files, light and dark, under `$CLOVER_GALLERY_OUT/<the package's folder name>/`, with a renderer it brings itself (Playwright, as a devDependency, installing its own Chromium).
* CI's `gallery` job runs every package's `gallery` script on Linux and keeps the PNGs as one artifact for review. A lane keeps no workflow of its own: `.github/workflows/` is CI's (lane M), and the layout test refuses a `lane-*.yml` there.

## A service

* A Cloudflare Worker: `wrangler.jsonc` (or `wrangler.json`, `wrangler.toml`) beside `src/`, with `main`, `compatibility_date` and its bindings.
* Code two Workers share lives in `services/shared/`, which is not a package and has no `package.json`: each Worker's `tsconfig.json` includes it and its bundle imports it by relative path.
* Its tests run it locally: `@waifucave/clover-test-harness/workers` starts the Worker in Miniflare on `127.0.0.1` from its own wrangler config, with in-memory storage. Nothing is deployed until the live gates (plan §8, §10). `services/hello` is the example.

## A native area

* `native/<area>` holds one per-OS helper in the language it needs (C#, Rust, Go, Swift), built by its own tool (`dotnet`, `cargo`, `go`, `swift`). Each area has a `README.md` saying what it is, which lane owns it, how to build and test it on each OS, and what it is allowed to touch. `native/README.md` lists the areas.

## Spikes

* `spikes/<spike>` is one experiment, with a `README.md` saying what it measures and what it found. A spike with a `package.json` is a workspace package; it is not built into the product.
