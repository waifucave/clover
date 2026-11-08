// `clover plugin validate` (spec §5.6): what a folder is and adds, without running anything, like
// `claude plugin validate`: its class, contributions, declared points, network hosts, helper permissions,
// capabilities, tool names, settings and children, every finding, and the OK's text. `--upgrade` rewrites files in an
// older format to the newest one (§5.1 "Formats").
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { describeOk, parseJsonc, upgradeDocument, validateTree, type ManifestReport } from "@waifucave/clover-plugin-sdk";
import type { ValidationIssue } from "@waifucave/clover-protocol";
import { folderLoaderReach, loaderOutsideIssues } from "./loader-config";
import { agentEnvLines } from "./folders";
import { TreeProblem, folderReader, folderTreeHash, treeEntries } from "./tree";

export interface PluginSummaryReport {
  id: string;
  class: ManifestReport["class"];
  contributions: ManifestReport["contributions"];
  declares: ManifestReport["declares"];
  networkHosts: string[];
  dynamicHosts: boolean;
  helperPermissions: string[];
  capabilities: string[];
  toolNames: string[];
  settings: string[];
  fetchesCode: string[];
  ok: boolean;
}

export interface FolderValidation {
  folder: string;
  /** No error anywhere in the tree (a child's too): the command's exit code. */
  ok: boolean;
  treeHash?: string;
  plugin?: PluginSummaryReport;
  children: (PluginSummaryReport & { folder: string })[];
  bareItem?: string;
  restylesCards: boolean;
  /** The OK's text, as the app's card shows it (in English). */
  okText: string[];
  issues: ValidationIssue[];
}

const summary = (r: ManifestReport, fallback: string): PluginSummaryReport => ({
  id: r.id ?? fallback, class: r.class, contributions: r.contributions, declares: r.declares, networkHosts: r.networkHosts,
  dynamicHosts: r.dynamicHosts, helperPermissions: r.helperPermissions, capabilities: r.capabilities, toolNames: r.toolNames,
  settings: r.settings, fetchesCode: r.fetchesCode, ok: r.ok,
});

export async function validatePluginFolder(folder: string, opts: { os?: "macos" | "windows" | "linux"; bundled?: boolean } = {}): Promise<FolderValidation> {
  const name = basename(folder);
  const issues: ValidationIssue[] = [];
  let hash: string | undefined;
  try {
    hash = await folderTreeHash(folder);
  } catch (e) {
    const message = e instanceof TreeProblem ? e.message : `the folder can't be read: ${(e as Error).message}`;
    issues.push({ severity: "error", refuses: "plugin", code: "tree_invalid", message, file: e instanceof TreeProblem ? e.path : "", path: "" });
  }
  const tree = await validateTree(folderReader(folder), { folderName: name, bundled: opts.bundled ?? false });
  issues.push(...tree.top.issues, ...tree.children.flatMap((c) => c.report.issues), ...tree.issues);
  // A loader config reaching outside the tree is an error here, whatever folder it is checked in (the controller's
  // ruling): a plugin built in a development folder, where the registry lets it pass, fails before it ships rather
  // than going invalid on someone else's computer. Only Clover's own trees (`bundled`) share the repository's config.
  if (opts.bundled !== true && hash !== undefined) issues.push(...loaderOutsideIssues(folderLoaderReach(folder, treeEntries(folder, { allowHardLinks: true }).map((e) => e.path))));
  const okText = tree.top.manifest ? [...describeOk(tree.top, { ...(opts.os ? { os: opts.os } : {}), source: "other", restylesCards: tree.restylesCards }), ...agentEnvLines(folder, tree)] : [];
  return {
    folder,
    ok: hash !== undefined && tree.ok && issues.every((i) => i.severity !== "error"),
    ...(hash ? { treeHash: hash } : {}),
    ...(tree.top.manifest ? { plugin: summary(tree.top, name) } : {}),
    children: tree.children.map((c) => ({ ...summary(c.report, `${name}/${c.folder}`), folder: c.folder, ok: c.ok })),
    ...(tree.bareItem ? { bareItem: tree.bareItem } : {}),
    restylesCards: tree.restylesCards,
    okText,
    issues,
  };
}

/** The folder's validation as the terminal prints it. */
export function renderValidation(v: FolderValidation): string {
  const lines: string[] = [];
  const list = (label: string, xs: readonly string[]) => lines.push(`  ${label}: ${xs.length > 0 ? xs.join(", ") : "none"}`);
  const plugin = (p: PluginSummaryReport, indent = "") => {
    lines.push(`${indent}${p.id} (${p.class})`);
    list(`${indent}contributes`, p.contributions.map((c) => `${c.point} (${c.entries})`));
    if (p.declares.length > 0) list(`${indent}declares`, p.declares.map((d) => `${d.name} (${d.shape}${d.spot ? ", a spot" : ""})`));
    list(`${indent}network hosts`, p.networkHosts.concat(p.dynamicHosts ? ["(more from its settings)"] : []));
    if (p.helperPermissions.length > 0) list(`${indent}helper permissions`, p.helperPermissions);
    list(`${indent}capabilities`, p.capabilities);
    if (p.toolNames.length > 0) list(`${indent}tools`, p.toolNames);
    if (p.settings.length > 0) list(`${indent}settings`, p.settings);
    if (p.fetchesCode.length > 0) list(`${indent}fetches code when it runs`, p.fetchesCode);
  };
  if (v.plugin) plugin(v.plugin);
  else lines.push(`${v.folder}: no plugin${v.bareItem ? ` (a ${v.bareItem.replace("-", " ")}, which Clover wraps)` : ""}`);
  if (v.treeHash) lines.push(`  tree hash: ${v.treeHash}`);
  for (const c of v.children) {
    lines.push(`  child ${c.folder}:${c.ok ? "" : " (invalid)"}`);
    plugin(c, "  ");
  }
  if (v.okText.length > 0) {
    lines.push("", "The OK will say:");
    for (const l of v.okText) lines.push(`  ${l}`);
  }
  const errors = v.issues.filter((i) => i.severity === "error");
  const warnings = v.issues.filter((i) => i.severity !== "error");
  if (v.issues.length > 0) lines.push("");
  for (const i of [...errors, ...warnings]) lines.push(`${i.severity}: ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message} [${i.code}]`);
  lines.push("", v.ok ? "valid" : `invalid: ${errors.length} error${errors.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export interface UpgradedFile {
  file: string;
  format: string;
  from?: number;
  to?: number;
  status: "upgraded" | "newer" | "unknown";
}

/** Rewrites each format file (a JSON file whose first key names its format) in an older version to the newest. A
 *  newer one is left and reported ("needs a newer Clover"). */
export function upgradePluginFolder(folder: string, opts: { write?: boolean } = {}): UpgradedFile[] {
  const out: UpgradedFile[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".git" || d.name === "node_modules") continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.isFile() && /\.jsonc?$/.test(d.name)) {
        const parsed = parseJsonc(readFileSync(abs, "utf8"));
        if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) continue;
        const r = upgradeDocument(parsed.value as Record<string, unknown>);
        if (!r || r.status === "current") continue;
        const file = relative(folder, abs).split(sep).join("/");
        if (r.status === "upgraded") {
          if (opts.write !== false) writeFileSync(abs, `${JSON.stringify(r.doc, null, 2)}\n`);
          out.push({ file, format: r.format, from: r.from, to: r.to, status: "upgraded" });
        } else out.push({ file, format: r.format, from: r.version, status: r.status });
      }
    }
  };
  walk(folder);
  return out;
}
