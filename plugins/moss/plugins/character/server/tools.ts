// The avatar plugin's own tools (its `figure` MCP server, served by its host half): any bot or session may call them,
// under the ordinary tool setting (on demand by default) and permission: a child of the bundled tree has no list that
// skips the card (registry/read-only-tools.ts `declaredTool`), so each call asks as any plugin tool does, unless the
// person's Tool permissions say otherwise. Each moves only the figure this plugin shows; `figure_status` only reads. The host half hands each call to
// the figures its components draw (`ui.send`, which says whose call it is) and gives back the first answer:
//   * a name the loaded model lacks is refused with some names it has ("the model has no expression X; it has: …");
//   * no figure takes the call (none is shown for that session, or a bot calls while the figure doesn't follow bots):
//     the caller is told so, plainly, and nothing moved.

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: false; openWorldHint: false };
}

const tool = (name: string, title: string, description: string, inputSchema: Record<string, unknown>, readOnly = false): ToolDef => ({
  name, title, description, inputSchema, annotations: { title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});
const str = (description: string, max = 64) => ({ type: "string", minLength: 1, maxLength: max, description });
const ONLY = "It only moves the avatar MOSS shows (beside this session in MOSS Code, or on the screen); nothing else is touched.";

export const FIGURE_TOOLS: readonly ToolDef[] = [
  tool("set_expression", "Change the avatar's expression", `Show an expression on the avatar, by the name its model gives it (figure_status lists them). Use it sparingly, when it fits what you're saying. ${ONLY}`,
    { type: "object", properties: { name: str("The expression's name.") }, required: ["name"], additionalProperties: false }),
  tool("play_motion", "Play an avatar motion", `Play one of the avatar model's motions (figure_status lists them): a wave hello, a nod. ${ONLY}`,
    { type: "object", properties: { name: str("The motion's name.") }, required: ["name"], additionalProperties: false }),
  tool("toggle_outfit", "Change the avatar's outfit", `Turn one of the avatar model's outfit parts on or off (figure_status lists them and which are on). ${ONLY}`,
    { type: "object", properties: { part: str("The part's name."), on: { type: "boolean" } }, required: ["part", "on"], additionalProperties: false }),
  tool("figure_status", "Check the avatar", "Read what the avatar shown for this session can do: the expressions, motions and outfit parts of its model. It only reads.",
    { type: "object", properties: {}, additionalProperties: false }, true),
];


/** What no figure taking the call means, said to the caller. */
export const NO_FIGURE = "Nothing moved: no avatar is shown for this session right now. MOSS shows it beside a coding session in MOSS Code, and on the screen when its On-the-screen setting is on; a bot's call reaches it only while its 'follow my bots too' setting is on.";

/** A figure's answer (`FigureCueResult`, or the status with the catalogue). */
type Answer = { ok: true; catalogue?: { renderer?: string; expressions?: string[]; motions?: string[]; outfits?: { name: string; on: boolean }[] } | null } | { ok: false; reason?: string; message?: string };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const field = (args: unknown, k: string): unknown => (args !== null && typeof args === "object" ? (args as Record<string, unknown>)[k] : undefined);
const list = (xs: readonly string[] | undefined) => (xs === undefined || xs.length === 0 ? "none" : xs.slice(0, 24).join(", ") + (xs.length > 24 ? ", …" : ""));

/** Runs one tool: `ask` hands the request to the figures and resolves with the first answer, or undefined if none took it. */
export async function runFigureTool(name: string, args: unknown, ask: (request: { cue?: unknown; status?: true }) => Promise<Answer | undefined>): Promise<ToolResult> {
  const s = (k: string) => (typeof field(args, k) === "string" ? (field(args, k) as string) : "");
  let request: { cue?: unknown; status?: true };
  switch (name) {
    case "set_expression": request = { cue: { type: "expression", name: s("name") } }; break;
    case "play_motion": request = { cue: { type: "motion", name: s("name") } }; break;
    case "toggle_outfit": request = { cue: { type: "outfit", part: s("part"), on: field(args, "on") === true } }; break;
    case "figure_status": request = { status: true }; break;
    default: return text(`unknown tool ${name.slice(0, 64)}`, true);
  }
  const answer = await ask(request);
  if (answer === undefined) return text(NO_FIGURE, true);
  if (!answer.ok) return text(answer.message ?? "the avatar couldn't do that", true);
  if (name === "figure_status") {
    const c = "catalogue" in answer ? answer.catalogue : undefined;
    if (c === undefined || c === null) return text("An avatar is shown, but its model hasn't said what it has yet.");
    return text(`The avatar (drawn by ${c.renderer ?? "its renderer"}) has expressions: ${list(c.expressions)}; motions: ${list(c.motions)}; outfit parts: ${c.outfits === undefined || c.outfits.length === 0 ? "none" : c.outfits.slice(0, 24).map((o) => `${o.name} (${o.on ? "on" : "off"})`).join(", ")}.`);
  }
  return text(name === "set_expression" ? `The avatar shows ${s("name")}.` : name === "play_motion" ? `The avatar plays ${s("name")}.` : `The avatar's ${s("part")} is ${field(args, "on") === true ? "on" : "off"}.`);
}
