// The environment every test that boots a Clover daemon needs, as one preload a package's bunfig.toml can name
// (`preload = ["../../packages/test-harness/src/preload.ts"]`): one fresh temp root per test process, removed at
// exit — and, where a daemon runs (`platform.ts`), the core test preload too: a throwaway Keychain service, an
// empty legacy home, no login shell, no real usage sources, a throwaway git config (packages/core/test/preload.ts
// says why for each).
import "../../core/test/per-process-tmp";
import { daemonSupported } from "./platform";

if (daemonSupported()) await import("../../core/test/preload");
