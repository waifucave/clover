// Interpolation in a manifest (spec §5.9): in a stdio server's `command`, `args` and `env`, an http server's `url` and
// `headers`, and a hook's or agent backend's `command` and `args`, a value may hold `${plugin}` (the folder's path),
// `${data}` (its data folder, §5.4), `${setting:k}` and `${secret:k}`, which names only the plugin's own secrets.
// Secrets may appear only in `env` and `headers`. Nothing else in a manifest is an expression.
import { KEY_RE } from "./fields";

export type InterpolationPart =
  | { kind: "text"; text: string }
  | { kind: "plugin" }
  | { kind: "data" }
  | { kind: "setting"; key: string }
  | { kind: "secret"; key: string };

export type InterpolationResult = { ok: true; parts: InterpolationPart[] } | { ok: false; error: string };

/** Where interpolation is allowed, and whether secrets may appear there. */
export const INTERPOLATED_FIELDS = [
  { where: "mcpServers.<name>.command (stdio)", secrets: false },
  { where: "mcpServers.<name>.args (stdio)", secrets: false },
  { where: "mcpServers.<name>.env (stdio)", secrets: true },
  { where: "mcpServers.<name>.url (http)", secrets: false },
  { where: "mcpServers.<name>.headers (http)", secrets: true },
  { where: "hooks[].command, hooks[].args", secrets: false },
  { where: "agentBackends[].command, agentBackends[].args", secrets: false },
] as const;

/** Splits a value into text and placeholders; an unknown `${…}` is an error. */
export function parseInterpolation(value: string): InterpolationResult {
  const parts: InterpolationPart[] = [];
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("${", i);
    if (start < 0) {
      parts.push({ kind: "text", text: value.slice(i) });
      break;
    }
    if (start > i) parts.push({ kind: "text", text: value.slice(i, start) });
    const end = value.indexOf("}", start + 2);
    if (end < 0) return { ok: false, error: `unclosed \${ at ${start}` };
    const body = value.slice(start + 2, end);
    if (body === "plugin") parts.push({ kind: "plugin" });
    else if (body === "data") parts.push({ kind: "data" });
    else if (body.startsWith("setting:") && KEY_RE.test(body.slice(8))) parts.push({ kind: "setting", key: body.slice(8) });
    else if (body.startsWith("secret:") && KEY_RE.test(body.slice(7))) parts.push({ kind: "secret", key: body.slice(7) });
    else return { ok: false, error: `\${${body}} is not \${plugin}, \${data}, \${setting:<key>} or \${secret:<key>}` };
    i = end + 1;
  }
  return { ok: true, parts };
}

export function usesSecrets(parts: readonly InterpolationPart[]): boolean {
  return parts.some((p) => p.kind === "secret");
}

export function isInterpolated(value: string): boolean {
  return value.includes("${");
}

export interface InterpolationValues {
  plugin: string;
  data: string;
  setting(key: string): string | undefined;
  secret(key: string): string | undefined;
}

/** Fills a value's placeholders. Throws on a missing setting or secret, so a server never starts half-configured. */
export function interpolate(value: string, values: InterpolationValues): string {
  const parsed = parseInterpolation(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.parts.map((p) => {
    switch (p.kind) {
      case "text": return p.text;
      case "plugin": return values.plugin;
      case "data": return values.data;
      case "setting": {
        const v = values.setting(p.key);
        if (v === undefined) throw new Error(`setting ${p.key} is not set`);
        return v;
      }
      case "secret": {
        const v = values.secret(p.key);
        if (v === undefined) throw new Error(`secret ${p.key} is not set`);
        return v;
      }
    }
  }).join("");
}
