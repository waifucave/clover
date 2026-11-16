// The core's own text, in English (spec §5.5: the `locales` point's built-in table). Packs translate it like any
// plugin's keys, except the `moss.card.` and `moss.ok.` keys, which only trusted tables may (strings.ts). The core
// root, the welcome guide and safe mode's plugin manager read these; so do the main process's menus and dialogs.
import type { LocaleValue } from "@waifucave/moss-plugin-sdk/ui/bridge";

export const CORE_STRINGS_EN: Readonly<Record<string, LocaleValue>> = {
  // The core root
  "moss.core.root.empty": "Nothing fills this window. A shell plugin may have been turned off or removed.",
  "moss.core.root.starting": "Starting MOSS…",
  "moss.core.root.down": "MOSS's background service hasn't started. MOSS Code keeps trying; if this stays, quit MOSS Code and open it again, or restart the computer.",
  "moss.core.root.empty-safe": "Nothing fills this window, even in safe mode.",
  "moss.core.root.failed": "The window could not be drawn: {error}",
  "moss.core.root.stopped": "MOSS's window stopped drawing. Its layer will start again when you reload.",
  "moss.core.root.reload": "Reload",
  "moss.core.root.restart-safe": "Restart in safe mode",

  // Safe mode (§5.8)
  "moss.core.safe.banner": "Safe mode: only MOSS's own plugins run.",
  "moss.core.safe.restart-normally": "Restart normally",
  "moss.core.safe.manage": "Manage plugins",
  "moss.core.safe.title": "Plugins",
  "moss.core.safe.intro": "In safe mode no third-party UI, host half or hook runs. Turn off the plugin that broke MOSS, then restart normally.",
  "moss.core.safe.loading": "Loading the plugins…",
  "moss.core.safe.none": "No plugins other than MOSS's own are installed.",
  "moss.core.safe.on": "On",
  "moss.core.safe.off": "Off",
  "moss.core.safe.turn-off": "Turn off",
  "moss.core.safe.turn-on": "Turn on",
  "moss.core.safe.remove": "Remove",
  "moss.core.safe.bundled": "MOSS's own",
  "moss.core.safe.state.found": "Waiting for your OK",
  "moss.core.safe.state.invalid": "Invalid",
  "moss.core.safe.failed": "That didn't work: {error}",
  "moss.core.safe.close": "Close",
  "moss.core.safe.ui": "Shows UI",
  "moss.core.safe.shell": "Replaces the shell",

  // The welcome setup guide (§3.3)
  "moss.core.welcome.title": "Welcome to MOSS",
  "moss.core.welcome.intro": "MOSS needs a model to talk to. Sign in to a subscription you have, or paste an API key.",
  "moss.core.welcome.loading": "Looking for model providers…",
  "moss.core.welcome.search": "Search providers",
  "moss.core.welcome.no-match": "No provider matches that.",
  "moss.core.welcome.none": "No model provider is installed. Install a model plugin, then come back here.",
  "moss.core.welcome.signed-in": "Signed in",
  "moss.core.welcome.sign-in": "Sign in",
  "moss.core.welcome.paste-key": "Paste your API key",
  "moss.core.welcome.save-key": "Save key",
  "moss.core.welcome.key-label": "{provider} API key",
  "moss.core.welcome.key-saved": "Saved. MOSS keeps the key in your computer's own secret store.",
  "moss.core.welcome.terms": "{provider}'s terms",
  "moss.core.welcome.terms-accept": "I accept {provider}'s terms",
  "moss.core.welcome.failed": "That didn't work: {error}",
  "moss.core.welcome.waiting": "Finish signing in in your browser.",
  "moss.core.welcome.skip": "Skip for now",
  "moss.core.welcome.done": "Start",
  "moss.core.welcome.ready": { one: "{count} provider is ready.", other: "{count} providers are ready." },
  "moss.core.welcome.no-claude": "Claude subscriptions can't be used here; an Anthropic Console sign-in (billed to your API account) can.",
  "moss.core.welcome.two-factor": "Your account is the key to every computer you add, so turn on two-factor sign-in for it.",

  // The app's own key dialog (the Plugins page's keys)
  "moss.core.key.title": "{plugin}'s key",
  "moss.core.key.title-plain": "A plugin's key",
  "moss.core.key.intro": "MOSS keeps it in your computer's own secret store. {plugin} gets it only to send with its requests.",
  "moss.core.key.is-set": "{label} is saved.",
  "moss.core.key.not-set": "No {label} is saved.",
  "moss.core.key.paste": "Paste the key",
  "moss.core.key.api-key": "API key",
  "moss.core.key.save": "Save key",
  "moss.core.key.replace": "Replace key",
  "moss.core.key.remove": "Remove key",
  "moss.core.key.remove-ask": "Remove this key?",
  "moss.core.key.keep": "Keep",
  "moss.core.key.saved": "Saved.",
  "moss.core.key.removed": "Removed.",
  "moss.core.key.failed": "That didn't work: {error}",

  // The terminal's paste door
  "moss.core.terminal.paste-title": { one: "Paste {count} line into the terminal?", other: "Paste {count} lines into the terminal?" },
  "moss.core.terminal.paste-detail": "Each line may run as a command on that computer.",
  "moss.core.terminal.paste": "Paste",
  "moss.core.terminal.cancel": "Cancel",

  // The main process
  "moss.core.tray.open": "Open MOSS Code",
  "moss.core.tray.hide-item": "Hide {title}",
  "moss.core.tray.show-item": "Show {title}",
  "moss.core.tray.four-finger-tap": "Four-Finger Tap Hides and Shows {titles}",
  "moss.core.tray.mute-sound": "Mute Sound from Plugins",
  "moss.core.tray.quit": "Quit MOSS Code",
  "moss.core.tray.safe-mode": "Restart in Safe Mode",
  "moss.core.tray.restart-normally": "Restart Normally",
  "moss.core.tray.manage-plugins": "Manage Plugins…",

  // The app's own update (updater.ts), once downloaded
  "moss.core.update.ready.title": "MOSS Code {version} is ready",
  "moss.core.update.ready.body": "It installs when you quit MOSS Code.",
};

/** The core's built-in tables, by language. */
export const CORE_STRINGS: Readonly<Record<string, Readonly<Record<string, LocaleValue>>>> = { en: CORE_STRINGS_EN };
