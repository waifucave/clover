// The manifest's field types (spec §5.9), shared by the manifest's schema and the catalogs. Each carries a JSON Schema
// `format` where §5.4 gives one meaning: `path` (a file in the plugin, handed over as an asset URL), `url` (its host
// is a network host), `handler` (an export of `host.entry`), `component` (an export of `client.entry`), `program` (a
// program to run) or `code` (a folder of code).
import { z } from "zod";
import { Text as ProtocolText } from "@waifucave/clover-protocol";

export const POINT_FORMATS = ["path", "url", "handler", "component", "program", "code"] as const;
export type PointFormat = (typeof POINT_FORMATS)[number];

/** User-facing text: a string, or translations with English required (§5.9 `Text`). */
export const Text = ProtocolText;

/** A path relative to the plugin folder, with `/`; it must resolve inside the folder (no symlinks out, §5.9). The
 *  lexical rules are checked here; the real path is checked where the folder is read (`validateTree`). */
export const Path = z.string().min(1).max(1024).meta({ format: "path", description: "A path relative to the plugin folder, with `/`; it must resolve inside it." });

/** A path that may hold glob characters (`skills`, §5.9). */
export const PathGlob = z.string().min(1).max(1024).meta({ format: "path", description: "A path or glob relative to the plugin folder." });

/** A JavaScript export name: of `host.entry` for a handler, of `client.entry` for a component. */
const EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The exports a host module keeps for the host itself (`start`, `stop`, `mcp`), never a handler (the core's
 *  `RESERVED_EXPORTS`). */
export const RESERVED_HANDLER_NAMES: readonly string[] = ["start", "stop", "mcp"];
export const HandlerName = z.string().min(1).max(128).regex(EXPORT_RE).refine((n) => !RESERVED_HANDLER_NAMES.includes(n), {
  message: "`start`, `stop` and `mcp` are the host's own exports, not handlers",
}).meta({
  format: "handler",
  description: "An export of `host.entry`: a function, or for a service (a `webhook.ingress` entry, a notifier) an object of functions, whose caller names the one it calls.",
});
export const ComponentName = z.string().min(1).max(128).regex(EXPORT_RE).meta({ format: "component", description: "An export of `client.entry`." });

/** A program to run: a command name or a path, which may use interpolation (`${plugin}`, §5.9). */
export const Program = z.string().min(1).max(4096).meta({ format: "program", description: "A program to run." });

/** An absolute http(s) URL; its host counts as one of the plugin's network hosts (§5.3). May use interpolation where
 *  §5.9 allows it (an `http` server's `url`). */
export const Url = z.string().min(1).max(4096).regex(/^https?:\/\/\S+$/).meta({ format: "url", description: "An http or https URL." });
/** A link the app shows and opens in the user's browser (`homepage`, `author.url`): not a network host, so it carries
 *  JSON Schema's own `uri` format, not §5.4's `url`. */
export const LinkUrl = z.string().min(1).max(4096).regex(/^https?:\/\/\S+$/).meta({ format: "uri", description: "A link opened in the user's browser; not one of the plugin's network hosts." });

/** An entry id: a model provider, a voice, an agent backend, a trigger type, a computer provider, a theme, a hook, a
 *  `ui` entry (§5.1 "Entry ids"). Lowercase letters, digits, `.`, `_` and `-`. */
export const ENTRY_ID_RE = /^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/;
export const EntryId = z.string().min(1).max(128).regex(ENTRY_ID_RE);

/** An extension point's name: lowercase segments joined by dots (`island.tab`, `luna.cards`). A UI spot inside the
 *  shell can be a single segment (`composer`); a point filled with a top-level `contributes` key always has a dot. */
export const POINT_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
export const DOTTED_POINT_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const PointName = z.string().min(1).max(128).regex(POINT_NAME_RE);

/** A setting's or a secret's key, as `${setting:k}` and `${secret:k}` name it. */
export const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const SettingKey = z.string().min(1).max(64).regex(KEY_RE);
/** A secret's name. `waifucave` is reserved, in any case: as a keyed fetch's `auth`, it names this computer's
 *  waifucave account token (`WAIFUCAVE_AUTH` in the plugin API). */
export const SecretName = z.string().min(1).max(64).regex(KEY_RE).regex(/^(?!waifucave$)/i, { message: "\"waifucave\" is reserved" });

/** A language tag (BCP 47, simplified): `en`, `pt-BR`, `zh-Hant`. */
export const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const LangTag = z.string().min(2).max(35).regex(LANG_RE);

/** A JSON Schema 2020-12 object; its formats are §5.4's. */
export const JsonSchema = z.record(z.string(), z.unknown()).meta({ description: "A JSON Schema (2020-12)." });

/** A tool name as a manifest writes it (§6.7): letters, digits, `_`, `-` and `.`, never `__`. `*` sets the default. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A namespace (§5.9): lowercase letters, digits and single hyphens, a letter or digit at each end, at most 40. */
export const NAMESPACE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A command's name within its namespace (`<namespace>.<name>`, §5.4). */
export const COMMAND_NAME_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

/** A default shortcut: modifiers, then one key (`mod+shift+k`); the user can rebind it (§5.4). */
export const KEY_CHORD_RE = /^((mod|ctrl|alt|shift|meta)\+)*([a-z0-9]|f([1-9]|1[0-2])|enter|escape|space|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[`=[\];',./-])$/;
