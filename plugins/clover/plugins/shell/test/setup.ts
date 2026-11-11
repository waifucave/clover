import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { afterEach } from "bun:test";
// The shell keeps its route in this window's session storage (Shell.tsx `KEPT_ROUTE`): each test starts with none.
afterEach(() => sessionStorage.clear());
