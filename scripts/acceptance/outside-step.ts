// P5 on the app (the owner, 2026-11-15: "Yes, named on the card"), a clause of the manifest-fields row: a folder plugin
// that names one harmless program of the run's own making (a shell script that prints the file it is given) and one
// folder of the run's own making, both in the run's user home, gets its OK card naming each with its warning; OK'd, its
// host half runs the program outside the plugin sandbox (it prints a file of the user's home the sandbox refuses the
// plugin itself) and reads the named folder. A plugin that names neither, the same host code, is refused both: the
// program by the core's words ("isn't a program … names outside its sandbox"), the folder by the sandbox. Kept apart from
// run.ts (which starts a run when loaded) so the verdict is unit-tested.
//
// The reviewer's read 44: the named plugin's host MCP server lists `OutsideStatus` read-only, and because the plugin
// runs a program outside its sandbox, its OK card says the tool still asks and a bot's call to it at the default level
// raises a tool card (a tool is the plugin's own code, which could run that program with what the bot hands it).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUTSIDE_IDS = { named: "acc-outside", plain: "acc-inside" } as const;
/** What the private file and the named folder's note hold. */
export const OUTSIDE_PRIVATE = "ACCEPTANCE-OUTSIDE-PRIVATE";
export const OUTSIDE_NOTE = "ACCEPTANCE-OUTSIDE-NOTE";
export const OUTSIDE_FOLDER = "~/acc-outside-folder";
/** The named plugin's tool its manifest lists read-only, which still asks. */
export const OUTSIDE_TOOL = "OutsideStatus";
/** The line its OK card carries for that server instead of "runs without asking". */
export const OUTSIDE_TOOLS_LINE = "Its server outside says one tool needs no asking, but this plugin runs programs of yours outside its sandbox, so it still asks before running.";

/** The host half both plugins have: `probe` runs the program on the private file, reads the named folder's note and
 *  reads the private file itself, and says what each gave. */
const HOST = [
  "// The acceptance run's P5 fixture (written by the run).",
  "import { readFileSync } from \"node:fs\";",
  "let api;",
  "export async function start(a) { api = a; }",
  "export async function stop() {}",
  "const tryRead = (p) => { try { return `read:${readFileSync(p, \"utf8\").trim()}`; } catch (e) { return `refused:${String((e && e.code) || e)}`; } };",
  "export async function probe(args) {",
  "  let ran;",
  "  try { const r = await api.outside.run(args.program, [args.private]); ran = `ran:${r.code}:${r.stdout.trim()}`; } catch (e) { ran = `refused:${String((e && e.message) || e).slice(0, 200)}`; }",
  "  return { ran, folder: tryRead(args.note), direct: tryRead(args.private) };",
  "}",
  // Its host MCP server: `OutsideStatus`, which its manifest lists read-only, answers a pong.
  "export const mcp = { outside: async (transport) => {",
  "  const reply = (id, body) => void transport.send({ jsonrpc: \"2.0\", id, ...body }).catch(() => {});",
  "  transport.onmessage = (m) => {",
  "    if (m.id === undefined) return;",
  "    const p = m.params ?? {};",
  "    if (m.method === \"initialize\") reply(m.id, { result: { protocolVersion: typeof p.protocolVersion === \"string\" ? p.protocolVersion : \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"acc-outside\", version: \"1\" } } });",
  "    else if (m.method === \"ping\") reply(m.id, { result: {} });",
  `    else if (m.method === "tools/list") reply(m.id, { result: { tools: [{ name: "${OUTSIDE_TOOL}", description: "The acceptance run's ${OUTSIDE_TOOL}.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });`,
  `    else if (m.method === "tools/call" && p.name === "${OUTSIDE_TOOL}") reply(m.id, { result: { content: [{ type: "text", text: "${OUTSIDE_TOOL}-pong" }] } });`,
  "    else reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });",
  "  };",
  "  await transport.start();",
  "} };",
  "",
].join("\n");

export interface OutsideFixture { named: string; plain: string; program: string; privateFile: string; noteFile: string }

/** The two plugins, the program and the user's two files; `src` is where the plugins' folders go, `bin` the program's. */
export function writeOutside(src: string, bin: string, userHome: string): OutsideFixture {
  mkdirSync(bin, { recursive: true });
  const program = join(bin, "acc-outside-cat");
  writeFileSync(program, "#!/bin/sh\nexec /bin/cat \"$1\"\n");
  chmodSync(program, 0o755);
  mkdirSync(userHome, { recursive: true });
  const privateFile = join(userHome, "acc-outside-private.txt");
  writeFileSync(privateFile, `${OUTSIDE_PRIVATE}\n`);
  const folder = join(userHome, OUTSIDE_FOLDER.slice(2));
  mkdirSync(folder, { recursive: true });
  const noteFile = join(folder, "note.txt");
  writeFileSync(noteFile, `${OUTSIDE_NOTE}\n`);
  const plugin = (id: string, outside: Record<string, unknown> | undefined) => {
    const dir = join(src, id);
    mkdirSync(join(dir, "host"), { recursive: true });
    writeFileSync(join(dir, "moss.json"), `${JSON.stringify({
      manifest: 1, id, name: id === OUTSIDE_IDS.named ? "Outside reader" : "Inside only", version: "1.0.0", engines: { moss: "^1.0.0" },
      host: { entry: "host/index.js", runtime: "bun", process: "own", ...(outside === undefined ? {} : { outside }) },
      contributes: {
        commands: [{ name: "probe", description: "Runs the program, reads the folder, says what each gave", handler: "probe", args: { type: "object", properties: { program: { type: "string", maxLength: 1024 }, private: { type: "string", maxLength: 1024 }, note: { type: "string", maxLength: 1024 } }, additionalProperties: false } }],
        ...(id === OUTSIDE_IDS.named ? { mcpServers: { outside: { type: "host", tools: { [OUTSIDE_TOOL]: "preload" }, readOnly: [OUTSIDE_TOOL] } } } : {}),
      },
    }, null, 2)}\n`);
    writeFileSync(join(dir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(join(dir, "host", "index.js"), HOST);
    return dir;
  };
  return { named: plugin(OUTSIDE_IDS.named, { programs: [program], read: [OUTSIDE_FOLDER] }), plain: plugin(OUTSIDE_IDS.plain, undefined), program, privateFile, noteFile };
}

export interface ProbeAnswer { ran?: string; folder?: string; direct?: string }

/** What is wrong with the clause's answers; empty when the named plugin's card named both, its program ran outside the
 *  sandbox and its folder was read (the private file refused to it directly), and the plain plugin was refused both. */
export function outsideWrong(o: { card: string; plainCard: string; program: string; named: ProbeAnswer; plain: ProbeAnswer; tool?: { cards: string[]; answered: boolean } }): string[] {
  const wrong: string[] = [];
  if (!o.card.includes(`It runs this program of yours outside MOSS's sandbox, with whatever arguments it chooses and your own access (your sign-ins, your Keychain, your files and your network): ${o.program}.`)) wrong.push("its OK card doesn't name its program with the warning");
  if (!o.card.includes(OUTSIDE_TOOLS_LINE) || o.card.includes(`without asking: ${OUTSIDE_TOOL}`)) wrong.push(`its OK card doesn't say its read-only ${OUTSIDE_TOOL} still asks`);
  if (o.tool !== undefined) {
    if (!o.tool.cards.some((c) => c.startsWith("a tool card"))) wrong.push(`the bot's call to ${OUTSIDE_TOOL} raised no tool card at the default level (${o.tool.cards.join(", ") || "no card"})`);
    if (!o.tool.answered) wrong.push(`${OUTSIDE_TOOL} didn't answer once its card was approved`);
  }
  if (!o.card.includes(`It reads this folder of yours outside its sandbox: ${OUTSIDE_FOLDER}.`)) wrong.push("its OK card doesn't name its folder with the warning");
  if (o.plainCard.includes("outside")) wrong.push("the plain plugin's OK card names something outside its sandbox");
  if (o.named.ran !== `ran:0:${OUTSIDE_PRIVATE}`) wrong.push(`its named program didn't run outside the sandbox (${o.named.ran ?? "no answer"})`);
  if (o.named.folder !== `read:${OUTSIDE_NOTE}`) wrong.push(`its named folder wasn't read (${o.named.folder ?? "no answer"})`);
  if (!(o.named.direct ?? "").startsWith("refused:")) wrong.push(`the private file wasn't refused to its own process (${o.named.direct ?? "no answer"}): the sandbox isn't on`);
  if (!(o.plain.ran ?? "").includes("isn't a program") || !(o.plain.ran ?? "").includes("outside its sandbox")) wrong.push(`the plain plugin's run wasn't refused by the core's words (${o.plain.ran ?? "no answer"})`);
  if (!(o.plain.folder ?? "").startsWith("refused:")) wrong.push(`the plain plugin read the folder it doesn't name (${o.plain.folder ?? "no answer"})`);
  return wrong;
}
