# native

Clover's per-OS helpers (plan §7), one area per folder. Each area is built by its own tool and has its own `README.md` saying what it is, how to build and test it on each OS, and what it may touch (`docs/clover-layout.md`).

| Area | What | Lane |
| :- | :- | :- |
| `sandbox/` | the OS sandboxes the daemon runs tools in | C |
| `input/` | the desktop app's native input helpers | E |
| `mounts/` | the folder tree's mounts | J |
| `link-sidecar/` | the link's transport, if Bun can't load iroh | H |

Each area arrives with its lane; until then its folder may be missing or hold only its README.
