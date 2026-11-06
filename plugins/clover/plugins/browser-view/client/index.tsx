// The browser view's client entry: fills `panel` keyed `browser`. `BrowserPanel` is the component the manifest names;
// the tab row and the chrome around the live view are exported for a host that places them itself. It imports no
// CSS: `client.css` lists the stylesheet (lane B).
export { BrowserPanel, VIEW } from "./BrowserPanel";
export { BrowserChrome } from "./BrowserChrome";
export { BrowserTabs } from "./BrowserTabs";
export { PluginApiProvider } from "./sdk";
export { normalizeAddress } from "./url";
export { TOKENS } from "./tokens";
export type * from "./types";
