// The acceptance-points-page fixture's host half: its point's entry handler (`greet`, which its page calls through
// `points.call`), its `report` command (which its page runs through `commands.run`, and the run reads), and the `ui`
// table its page hands its answers to (`host.call("pageReport")`). No network, no other process.

/** What its page handed over, area by area. */
let page: Record<string, unknown> | undefined;

export async function greet(args: { who?: string }): Promise<string> {
  return `hello ${String(args?.who ?? "nobody")} from the page's own point`;
}

export async function report(): Promise<{ page?: Record<string, unknown> }> {
  return page !== undefined ? { page } : {};
}

/** What its components may call (`host.call`). */
export const ui = {
  pageReport: async (args: Record<string, unknown>) => {
    page = args;
    return "kept";
  },
};
