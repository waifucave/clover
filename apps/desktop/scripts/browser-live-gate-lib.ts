// The browser's live-gate checklist (plan §10 items 2, 3, 4, 5 and 8, for the browser), as data, and the pure parts of
// the script that walks the owner through it (`browser-live-gate.ts`): which steps this machine takes, the refusal to
// run anywhere but at a person's own terminal, and the JSON the answers are recorded in. The same list is written out
// for reading in `docs/live-gates/browser.md`; a test keeps the two in step.

export type Os = "darwin" | "win32" | "linux";
export type Answer = "pass" | "fail" | "skip";

/** What the script measures by itself for a step, from the fixture site and the app (the owner still answers). */
export type AutoCheck =
  | "no-reload"
  | "ime-composition"
  | "scroll-and-pinch"
  | "refresh-rate"
  | "scale"
  | "reader-host"
  | "proxy-load";

export interface Step {
  id: string;
  /** The checklist's section, in the order they run. */
  section: "macos" | "windows" | "linux-wayland" | "companion" | "proxy" | "server";
  /** Where it runs; the companion, proxy and server sections run on any OS. */
  os: Os[];
  title: string;
  /** What the owner does, one line each. */
  do: string[];
  /** What a pass looks like. */
  expect: string;
  auto?: AutoCheck;
}

const ANY: Os[] = ["darwin", "win32", "linux"];

export const SECTIONS: Record<Step["section"], string> = {
  macos: "macOS",
  windows: "Windows 11",
  "linux-wayland": "GNOME and KDE on Wayland",
  companion: "The phone or web companion",
  proxy: "A corporate-style proxy and PAC",
  server: "A server or cloud computer",
};

export const STEPS: Step[] = [
  {
    id: "mac-viewport-roundtrip",
    section: "macos",
    os: ["darwin"],
    title: "A bot's tab shown through the viewport and back, with no reload",
    do: [
      "The bot's tab is open offscreen with a counter that has been running. Press Enter in the terminal to show it in the window.",
      "Watch the counter and the field's text; press Enter again to send it back; again to show it.",
    ],
    expect: "The page's token is the same all three times and its timer never restarted (the script checks it); no window of the app's but the one you are looking at appears or flashes.",
    auto: "no-reload",
  },
  {
    id: "mac-ime",
    section: "macos",
    os: ["darwin"],
    title: "IME composition (Japanese and Chinese)",
    do: [
      "With the tab shown, click the large text box on the page.",
      "Switch to a Japanese input source and type 'nihongo', choose a candidate with Space, press Return.",
      "Switch to a Chinese (Pinyin) source and type 'zhongwen', choose a candidate.",
    ],
    expect: "The candidate window sits at the caret, the underlined text shows while composing, and the committed text lands in the box. The script saw compositionstart, update and end for each.",
    auto: "ime-composition",
  },
  {
    id: "mac-trackpad",
    section: "macos",
    os: ["darwin"],
    title: "Trackpad scrolling and pinch",
    do: ["Two-finger scroll the tall page up and down with momentum.", "Pinch to zoom in and out on the page."],
    expect: "Scrolling is smooth with momentum and stops at the ends; a pinch zooms the page's content (the script saw wheel events with the pinch flag).",
    auto: "scroll-and-pinch",
  },
  {
    id: "mac-display",
    section: "macos",
    os: ["darwin"],
    title: "Retina and 120 Hz",
    do: ["On a Retina display, and on a 120 Hz one if you have it, read the sharpness of the shown tab's small text.", "Leave the page's animation running for ten seconds."],
    expect: "The text is as sharp as Safari's, and the page's measured frame rate is the display's (60 or 120; the script reports it).",
    auto: "refresh-rate",
  },
  {
    id: "mac-voiceover",
    section: "macos",
    os: ["darwin"],
    title: "VoiceOver on: new tabs go to the screen-reader host, which can be taken over",
    do: [
      "Turn VoiceOver on (Cmd+F5). Press Enter in the terminal to open a new tab for the bot.",
      "Move VoiceOver to the page in the app's window after showing it, and read the heading and the button.",
      "Turn VoiceOver off.",
    ],
    expect: "The new tab is a real view in the hidden host (the script reports it), it reads in VoiceOver once shown, and no window of the host was ever visible or took focus.",
    auto: "reader-host",
  },
  {
    id: "mac-select-copy",
    section: "macos",
    os: ["darwin"],
    title: "Selecting and copying, the right-click menu, the file chooser, a same-site popup while watched",
    do: [
      "Drag-select the sentence and press Cmd+C; paste it into the text box.",
      "Right-click the sentence and choose Copy.",
      "Click 'Choose file' and pick any file.",
      "Click 'Open same-site window' while you are watching.",
    ],
    expect: "Each works as in a normal browser; the popup opens as a real window while you watch.",
  },
  {
    id: "win-scale",
    section: "windows",
    os: ["win32"],
    title: "150 % and 200 % scaling",
    do: [
      "Set Display scaling to 150 %, sign out and in, run this script and show the tab. Note the result.",
      "Do the same at 200 %. Answer once for each, in the note.",
    ],
    expect: "The shown tab fills its frame, text is crisp, a click lands where the pointer is, and the script's reported scale is the setting's.",
    auto: "scale",
  },
  {
    id: "win-ime",
    section: "windows",
    os: ["win32"],
    title: "IME composition",
    do: ["Click the large text box with the shown tab.", "Type with the Microsoft Japanese IME, then Pinyin, committing a candidate each time."],
    expect: "The candidate window sits at the caret and the committed text lands in the box.",
    auto: "ime-composition",
  },
  {
    id: "win-reader",
    section: "windows",
    os: ["win32"],
    title: "Narrator or NVDA: new tabs go to the screen-reader host, which can be taken over",
    do: ["Start Narrator (Win+Ctrl+Enter) or NVDA. Press Enter in the terminal to open a new tab for the bot.", "Show it and read the heading and the button."],
    expect: "The new tab is a real view in the hidden host (the script reports it), it reads once shown, and the host never appeared in the taskbar, Alt-Tab or on screen.",
    auto: "reader-host",
  },
  {
    id: "wl-no-window",
    section: "linux-wayland",
    os: ["linux"],
    title: "No window of the app's while bots work",
    do: [
      "Log in to a GNOME or KDE Wayland session (answer once per desktop, in the note). Run this script; the bot's tab starts offscreen.",
      "Open the overview or window list while the bot's tab runs a page with an animation.",
    ],
    expect: "Only the one window you are looking at is listed; nothing of the app's flashes in the list, the dock or the overview.",
  },
  {
    id: "wl-host-pixel",
    section: "linux-wayland",
    os: ["linux"],
    title: "The screen-reader host's one pixel",
    do: [
      "Turn the screen reader on (Orca: Super+Alt+S). Press Enter in the terminal to open a new tab for the bot.",
      "Look for a dot or a row for the host in the window list, and click where it sits if you find it.",
    ],
    expect: "The host is not in the list, or if it is, a click at its pixel goes to the window below. If either fails, note it: the fallback is `--ozone-platform=x11` for the host (XWayland).",
    auto: "reader-host",
  },
  {
    id: "wl-orca",
    section: "linux-wayland",
    os: ["linux"],
    title: "Orca reads the shown tab",
    do: ["With Orca on and the new tab shown, read the heading and the button."],
    expect: "Orca reads them.",
  },
  {
    id: "comp-stream",
    section: "companion",
    os: ANY,
    title: "The phone or web companion decodes the streamed view (with lane I): hardware H.264 on a real Mac",
    do: [
      "On a real Mac, start the stream of the bot's tab to the phone or the web companion (Chrome, Firefox, Safari in turn).",
      "Watch the animated page on the companion for a minute; throttle the phone's connection once.",
    ],
    expect: "The picture follows the page within about a second, the codec is H.264 from the hardware encoder on the Mac (the app's stream log says), and it recovers after the throttling without freezing for long.",
  },
  {
    id: "proxy-explicit",
    section: "proxy",
    os: ANY,
    title: "An explicit corporate-style proxy",
    do: ["Enter the proxy's address when asked (http://, https:// or socks5://), and a public https URL to load through it."],
    expect: "The page loads, the proxy's own log shows the request for the address (not the name), and a page on your LAN is not sent to the proxy.",
    auto: "proxy-load",
  },
  {
    id: "proxy-pac",
    section: "proxy",
    os: ANY,
    title: "The system's PAC",
    do: ["Set the OS's automatic proxy configuration to your company's PAC file, then choose 'system' when asked, and load a public https URL."],
    expect: "The page loads by the route the PAC names, and nothing looked up wpad or fetched a dictionary.",
    auto: "proxy-load",
  },
  {
    id: "server-install",
    section: "server",
    os: ["linux"],
    title: "A server or cloud computer: the headless shell installs from the pin and a bot works",
    do: [
      "On a headless server or a cloud computer made for this, run the core with the browser on and have a bot open a page and take a screenshot.",
      "Look at <home>/browser/ afterwards.",
    ],
    expect: "The pinned build downloaded and verified once, the bot's page loaded, the screenshot is 1280x800, and <home>/browser/ holds only the install, the profiles and a run folder that empties when the browser exits.",
  },
];

/** The steps this machine takes (all of them with `all`, or one section). */
export function stepsFor(platform: string, opts: { all?: boolean; section?: Step["section"] } = {}): Step[] {
  return STEPS.filter((s) => (opts.all === true || s.os.includes(platform as Os)) && (opts.section === undefined || s.section === opts.section));
}

/** Why the script won't run here, or undefined. It opens windows on a person's screen and asks them questions: it is
 *  for the owner at their own terminal, never an agent, CI or a pipe. */
export function refusal(env: Record<string, string | undefined>, isTty: boolean): string | undefined {
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return "this is the owner's live gate; it opens windows and is never run in CI";
  if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined || env.CLOVER_AGENT !== undefined) return "this is the owner's live gate; an agent never runs it";
  if (!isTty) return "this asks you questions and needs a terminal";
  return undefined;
}

export interface Recorded {
  id: string;
  section: Step["section"];
  title: string;
  answer: Answer;
  note?: string;
  /** What the script measured for the step. */
  auto?: unknown;
  at: string;
}

export interface Run {
  startedAt: string;
  platform: string;
  arch: string;
  electron?: string;
  host?: string;
  steps: Recorded[];
}

export function newRun(info: { platform: string; arch: string; electron?: string; host?: string }, now = new Date()): Run {
  return { startedAt: now.toISOString(), platform: info.platform, arch: info.arch, ...(info.electron !== undefined ? { electron: info.electron } : {}), ...(info.host !== undefined ? { host: info.host } : {}), steps: [] };
}

/** Records an answer, replacing an earlier one for the same step. */
export function record(run: Run, step: Step, answer: Answer, extra: { note?: string; auto?: unknown } = {}, now = new Date()): Run {
  const entry: Recorded = {
    id: step.id, section: step.section, title: step.title, answer,
    ...(extra.note !== undefined && extra.note !== "" ? { note: extra.note } : {}),
    ...(extra.auto !== undefined ? { auto: extra.auto } : {}),
    at: now.toISOString(),
  };
  return { ...run, steps: [...run.steps.filter((s) => s.id !== step.id), entry] };
}

export function parseAnswer(text: string): Answer | undefined {
  const t = text.trim().toLowerCase();
  if (t === "p" || t === "pass" || t === "y" || t === "yes") return "pass";
  if (t === "f" || t === "fail" || t === "n" || t === "no") return "fail";
  if (t === "s" || t === "skip" || t === "") return "skip";
  return undefined;
}

/** The summary the script ends with. */
export function summarize(run: Run): { pass: number; fail: number; skip: number } {
  const n = { pass: 0, fail: 0, skip: 0 };
  for (const s of run.steps) n[s.answer]++;
  return n;
}

/** `docs/live-gates/browser.md`, written from the list (a test keeps the file equal to this). */
export function renderChecklist(): string {
  const out: string[] = [
    "# The browser's live gate",
    "",
    "Generated from `apps/desktop/scripts/browser-live-gate-lib.ts`; edit the list there and run `bun run apps/desktop/scripts/browser-live-gate.ts --write-doc`, or a test fails. This is the browser's part of plan §10 (items 2, 3, 4, 5 and 8). **The owner runs it, never an agent:** it opens a real window.",
    "",
    "## How to run it",
    "",
    "On each machine in turn (a Mac, a Windows 11 PC, a GNOME and a KDE Wayland session, a server):",
    "",
    "```sh",
    "cd apps/desktop",
    "bun install                      # from the repo root, once",
    "bun run scripts/browser-live-gate.ts [--section <name>] [--out <folder>] [--all]",
    "```",
    "",
    "It builds a small app that shows one window, serves a fixture page on loopback, and walks you through the steps for that OS. For some steps it measures by itself (the page's token across show and hide, composition events, wheel and pinch events, the frame rate, the display's scale, whether a new tab went to the screen-reader host) and then asks you. Answer `p` (pass), `f` (fail) or `s` (skip), and add a note. Your answers go to `browser-live-gate.json` in the run folder (printed when it starts; `--out` chooses it). Nothing else is written: no Clover home, no Keychain, no account.",
    "",
    "It refuses to run in CI, under an agent, or without a terminal.",
    "",
    "On Wayland, to try the XWayland fallback for the screen-reader host if a step fails: `--electron-arg --ozone-platform=x11`, and say so in the note.",
    "",
    "Parts that need more than this machine and the script: the **phone or web companion** step needs lane I's companion on a phone or in a browser, the **proxy** steps need your real proxy and PAC, and the **server** step is done on the server by hand (the script lists it with `--all`).",
  ];
  let section = "";
  for (const s of STEPS) {
    if (s.section !== section) {
      section = s.section;
      out.push("", `## ${SECTIONS[s.section]}`);
    }
    out.push("", `### ${s.title}`, "", `\`${s.id}\`, on ${s.os.length === 3 ? "any OS" : s.os.map((o) => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[o]).join(", ")}${s.auto !== undefined ? `; the script measures \`${s.auto}\`` : ""}.`, "");
    for (const d of s.do) out.push(`1. ${d}`);
    out.push("", `**Pass:** ${s.expect}`);
  }
  out.push("");
  return out.join("\n");
}
