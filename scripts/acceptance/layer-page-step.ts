// The acceptance-points row's page half: what a plugin's page (fixtures/acceptance-points-page/client/index.tsx, its
// sidebar app button's component, mounted in a frame of its own layer) got back from the plugin API through the SDK's
// own `usePluginApi`, one member of each area a component reaches since components got the whole catalog, handed to its
// host half and read back with its `report` command. Each answer is checked here.

/** What the page hands over, area by area (a string starting "refused:" where a call was refused). */
export type PageReport = Record<string, unknown>;

export interface PageExpect {
  /** What the run's loopback site answers at `/page`. */
  siteBody: string;
}

/** What came back wrong, and the areas that answered right. */
export function checkPageReport(page: PageReport, expect: PageExpect): { wrong: string[]; said: string[] } {
  const wrong: string[] = [];
  const said: string[] = [];
  const check = (area: string, ok: boolean, what: unknown) => {
    if (ok) said.push(area);
    else wrong.push(`${area}: ${JSON.stringify(what)?.slice(0, 240) ?? String(what)}`);
  };
  const files = page.files as { heard?: unknown; bytes?: unknown; text?: unknown; listed?: unknown; globbed?: unknown; grepped?: unknown } | string | undefined;
  check("files (watch, write, readBytes, readText, list, move, glob, grep, remove)", typeof files === "object" && files !== null && files.heard === true && files.bytes === "ACCEPTANCE-PAGE-FILE" && files.text === "ACCEPTANCE-PAGE-FILE" && files.listed === true && files.globbed === true && files.grepped === true, files);
  check("memory.list", page.memory === "a list", page.memory);
  check("routines.list", page.routines === "a list", page.routines);
  check("usage.summary", page.usage === "a list", page.usage);
  check("logs.read", page.logs === "a list", page.logs);
  // Muted by the run: the core's notify service judged it (the capability and the gate passed), and nothing showed.
  check("notify.send (muted)", typeof page.notify === "string" && page.notify.startsWith("refused:") && page.notify.includes("muted"), page.notify);
  check("conversation.note", page.note === "noted", page.note);
  check("commands.run", page.command === "its report", page.command);
  check("commands.list", page.commandsList === "its own listed", page.commandsList);
  // Its own key, read from its own locale file (the `locales` point), its placeholder filled; with no table the key reads as itself.
  check("t (its own locale)", page.t === "Hello page, from the page's own locale", page.t);
  check("points.call", page.point === "hello page from the page's own point", page.point);
  const fetched = page.fetch as { status?: unknown; body?: unknown } | string | undefined;
  check("net.fetch", typeof fetched === "object" && fetched !== null && fetched.status === 200 && fetched.body === expect.siteBody, fetched);
  return { wrong, said };
}
