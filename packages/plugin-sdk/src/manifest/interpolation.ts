// Interpolation in a manifest (spec §5.9): in a stdio server's `command`, `args` and `env`, an http server's `url` and
// `headers`, and a hook's or agent backend's `command` and `args`, a value may hold `${plugin}` (the folder's path),
// `${data}` (its data folder, §5.4), `${setting:k}`, `${secret:k}`, which names only the plugin's own secrets, and
// `${secretFile:k}`, the path of a file holding that secret (mode 0600, readable only by that plugin's processes),
// for a server that reads its key from a file rather than its environment, which other processes of the user could
// read (the controller's ruling on #377). Secrets may appear only in `env` and `headers`; a secret's file only in a
// stdio server's `env` and `args`. A model's `endpoint.baseUrl` and a `network:` capability's host may
// name settings, never secrets (lane A's ask). Nothing else in a manifest is an expression.
import { KEY_RE } from "./fields";

export type InterpolationPart =
  | { kind: "text"; text: string }
  | { kind: "plugin" }
  | { kind: "data" }
  | { kind: "setting"; key: string }
  | { kind: "secret"; key: string }
  | { kind: "secretFile"; key: string };

export type InterpolationResult = { ok: true; parts: InterpolationPart[] } | { ok: false; error: string };

/** Where interpolation is allowed, and whether secrets may appear there. */
export const INTERPOLATED_FIELDS = [
  { where: "mcpServers.<name>.command (stdio)", secrets: false },
  { where: "mcpServers.<name>.args (stdio)", secrets: false, secretFiles: true },
  { where: "mcpServers.<name>.env (stdio)", secrets: true, secretFiles: true },
  { where: "mcpServers.<name>.url (http)", secrets: false },
  { where: "mcpServers.<name>.headers (http)", secrets: true },
  { where: "hooks[].command, hooks[].args", secrets: false },
  { where: "agentBackends[].command, agentBackends[].args", secrets: false },
  /** Settings only, never `${plugin}`, `${data}` or a secret: the host then comes from its settings (lane A's ask). */
  { where: "models[].endpoint.baseUrl (settings only)", secrets: false },
  /** Settings only, as whole labels of a name whose last two labels are fixed (`parseNetworkHost`). */
  { where: "capabilities[] network:<host> (settings only)", secrets: false },
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
    else if (body.startsWith("secretFile:") && KEY_RE.test(body.slice(11))) parts.push({ kind: "secretFile", key: body.slice(11) });
    else return { ok: false, error: `\${${body}} is not \${plugin}, \${data}, \${setting:<key>}, \${secret:<key>} or \${secretFile:<key>}` };
    i = end + 1;
  }
  return { ok: true, parts };
}

export function usesSecrets(parts: readonly InterpolationPart[]): boolean {
  return parts.some((p) => p.kind === "secret");
}

export function usesSecretFiles(parts: readonly InterpolationPart[]): boolean {
  return parts.some((p) => p.kind === "secretFile");
}

export function isInterpolated(value: string): boolean {
  return value.includes("${");
}

export interface InterpolationValues {
  plugin: string;
  data: string;
  setting(key: string): string | undefined;
  secret(key: string): string | undefined;
  /** The path of the file holding a secret (the core writes it, `${secretFile:k}`). */
  secretFile?(key: string): string | undefined;
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
      case "secretFile": {
        const v = values.secretFile?.(p.key);
        if (v === undefined) throw new Error(`secret ${p.key} is not set`);
        return v;
      }
    }
  }).join("");
}
