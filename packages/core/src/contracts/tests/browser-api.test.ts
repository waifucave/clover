// Runs the BrowserApi conformance suite against FakeBrowser.
import { runBrowserApiConformance } from "../conformance/browser-api";
import { FakeBrowser } from "../fakes/browser-api";

runBrowserApiConformance((...args) => new FakeBrowser(...args));
