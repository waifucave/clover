// The core's own text, in English (spec §5.5: the `locales` point's built-in table). Packs translate it like any
// plugin's keys, except the `clover.card.` and `clover.ok.` keys, which only trusted tables may (strings.ts). The core
// root, the welcome guide and safe mode's plugin manager read these; so do the main process's menus and dialogs.
import type { LocaleValue } from "@waifucave/clover-plugin-sdk/ui/bridge";

export const CORE_STRINGS_EN: Readonly<Record<string, LocaleValue>> = {
  // The core root
  "clover.core.root.empty": "Nothing fills this window. A shell plugin may have been turned off or removed.",
  "clover.core.root.empty-safe": "Nothing fills this window, even in safe mode.",
  "clover.core.root.failed": "The window could not be drawn: {error}",
  "clover.core.root.stopped": "Clover's window stopped drawing. Its layer will start again when you reload.",
  "clover.core.root.reload": "Reload",
  "clover.core.root.restart-safe": "Restart in safe mode",

  // Safe mode (§5.8)
  "clover.core.safe.banner": "Safe mode: only Clover's own plugins run.",
  "clover.core.safe.restart-normally": "Restart normally",
  "clover.core.safe.manage": "Manage plugins",
  "clover.core.safe.title": "Plugins",
  "clover.core.safe.intro": "In safe mode no third-party UI, host half or hook runs. Turn off the plugin that broke Clover, then restart normally.",
  "clover.core.safe.loading": "Loading the plugins…",
  "clover.core.safe.none": "No plugins other than Clover's own are installed.",
  "clover.core.safe.on": "On",
  "clover.core.safe.off": "Off",
  "clover.core.safe.turn-off": "Turn off",
  "clover.core.safe.turn-on": "Turn on",
  "clover.core.safe.remove": "Remove",
  "clover.core.safe.bundled": "Clover's own",
  "clover.core.safe.state.found": "Waiting for your OK",
  "clover.core.safe.state.blocked": "Blocked",
  "clover.core.safe.state.invalid": "Invalid",
  "clover.core.safe.failed": "That didn't work: {error}",
  "clover.core.safe.close": "Close",
  "clover.core.safe.ui": "Shows UI",
  "clover.core.safe.shell": "Replaces the shell",

  // The welcome setup guide (§3.3)
  "clover.core.welcome.title": "Welcome to Clover",
  "clover.core.welcome.intro": "Clover needs a model to talk to. Sign in to a subscription you have, or paste an API key.",
  "clover.core.welcome.loading": "Looking for model providers…",
  "clover.core.welcome.none": "No model provider is installed. Install a model plugin, then come back here.",
  "clover.core.welcome.signed-in": "Signed in",
  "clover.core.welcome.sign-in": "Sign in",
  "clover.core.welcome.paste-key": "Paste your API key",
  "clover.core.welcome.save-key": "Save key",
  "clover.core.welcome.key-label": "{provider} API key",
  "clover.core.welcome.key-saved": "Saved. Clover keeps the key in your computer's own secret store.",
  "clover.core.welcome.terms": "{provider}'s terms",
  "clover.core.welcome.terms-accept": "I accept {provider}'s terms",
  "clover.core.welcome.failed": "That didn't work: {error}",
  "clover.core.welcome.waiting": "Finish signing in in your browser.",
  "clover.core.welcome.skip": "Skip for now",
  "clover.core.welcome.done": "Start",
  "clover.core.welcome.ready": { one: "{count} provider is ready.", other: "{count} providers are ready." },
  "clover.core.welcome.no-claude": "Claude subscriptions can't be used here; an Anthropic Console sign-in (billed to your API account) can.",
  "clover.core.welcome.two-factor": "Your account is the key to every computer you add, so turn on two-factor sign-in for it.",

  // The main process
  "clover.core.tray.open": "Open Clover",
  "clover.core.tray.quit": "Quit Clover",
  "clover.core.tray.safe-mode": "Restart in Safe Mode",
  "clover.core.tray.manage-plugins": "Manage Plugins…",
};

/** The core's built-in tables, by language. */
export const CORE_STRINGS: Readonly<Record<string, Readonly<Record<string, LocaleValue>>>> = { en: CORE_STRINGS_EN };
