// The command palette (spec §5.2 "Commands"): every installed plugin's command (`command.list`), found by its name or
// what it does, each with its shortcut; picking one runs `<namespace>.<name>` (`command.run`), first asking for its
// `args` through a form drawn from their JSON Schema when it takes any. Bots and their tabs are here too, so Search
// finds a conversation. A command's shortcut can be changed from its row: the next key pressed becomes the user's own
// binding, which wins over the plugin's default (or Remove for none).
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { plain } from "../runtime/views";
import { checkArgs, noArgs, runsBare, type ArgsIssue } from "./args";
import { chordOf, isModifierOnly, reserved, showChord, writeChord, type Platform } from "./shortcuts";
import { S } from "./strings";

export interface PaletteCommand {
  name: string;
  pluginId: string;
  description: string;
  args?: Record<string, unknown>;
}

export interface PaletteGo {
  id: string;
  title: string;
  detail?: string;
  go: () => void;
}

export interface PaletteProps {
  commands: readonly PaletteCommand[];
  /** Places to go: the bots, their agents. */
  places: readonly PaletteGo[];
  /** Each command's shortcut as it is bound now. */
  bound: ReadonlyMap<string, string>;
  platform: Platform;
  onRun: (name: string, args: Record<string, unknown> | undefined) => Promise<void>;
  onRebind?: (name: string, key: string | null) => void;
  onClose: () => void;
  /** Opened for one command (its shortcut asked for args). */
  start?: string;
}

interface Field {
  name: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum" | "json";
  options?: string[];
  /** The enum's own values, by the option's index (a number stays a number). */
  values?: unknown[];
  required: boolean;
  description?: string;
}

/** The fields a command's `args` schema asks for (an object's properties; anything else as JSON). */
export function fieldsOf(schema: Record<string, unknown> | undefined): Field[] {
  const props = schema && typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, Record<string, unknown>>) : {};
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]) : [];
  return Object.entries(props).map(([name, p]) => {
    const t = p.type;
    const type: Field["type"] = Array.isArray(p.enum) ? "enum" : t === "string" ? "string" : t === "number" || t === "integer" ? "number" : t === "boolean" ? "boolean" : "json";
    return {
      name,
      title: typeof p.title === "string" ? p.title : name,
      type,
      ...(Array.isArray(p.enum) ? { options: (p.enum as unknown[]).map((v) => (typeof v === "string" ? v : JSON.stringify(v))), values: p.enum as unknown[] } : {}),
      required: required.includes(name),
      ...(typeof p.description === "string" ? { description: p.description } : {}),
    };
  });
}

/** One issue with the args, in words, naming the field by its title. */
function issueText(issue: ArgsIssue, fields: readonly Field[]): string {
  const title = fields.find((f) => f.name === issue.field)?.title ?? issue.field;
  if (issue.kind === "missing") return S.paletteRequired(title);
  if (issue.kind === "too-small" && issue.limit !== undefined) return issue.of ? S.paletteTooFew(title, issue.limit, issue.of) : S.paletteTooSmall(title, issue.limit);
  if (issue.kind === "too-big" && issue.limit !== undefined) return issue.of ? S.paletteTooMany(title, issue.limit, issue.of) : S.paletteTooBig(title, issue.limit);
  if (issue.kind === "unknown-key") return S.paletteUnknownField(title);
  return title ? S.paletteInvalid(title) : S.paletteArgsInvalid;
}

function ArgsForm({ command, onRun, onBack }: { command: PaletteCommand; onRun: (args: Record<string, unknown>) => void; onBack: () => void }) {
  const fields = useMemo(() => fieldsOf(command.args), [command.args]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const args: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === undefined || v === "") {
        if (f.required && f.type !== "boolean") return setError(S.paletteRequired(f.title));
        if (f.type === "boolean" && v !== undefined) args[f.name] = false;
        continue;
      }
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) return setError(S.paletteNumber(f.title));
        args[f.name] = n;
      } else if (f.type === "json") {
        try {
          args[f.name] = JSON.parse(String(v));
        } catch {
          return setError(S.paletteJson(f.title));
        }
      } else if (f.type === "enum") args[f.name] = f.values![f.options!.indexOf(String(v))];
      else args[f.name] = v;
    }
    // Then the whole against the command's schema, as the core checks it (N4).
    const checked = checkArgs(command.args, args);
    if (!checked.ok) return setError(checked.unreadable ? S.paletteSchemaUnreadable : issueText(checked.issues[0]!, fields));
    onRun(args);
  };
  return (
    <form className="cl-palette__form" onSubmit={submit} noValidate aria-label={S.paletteArgsFor(command.name)}>
      <p className="cl-palette__form-title">{command.name}</p>
      {fields.map((f) => (
        <label key={f.name} className="cl-palette__field">
          <span className="cl-palette__field-name">
            {f.title}
            {f.required ? ` ${S.paletteRequiredMark}` : ""}
          </span>
          {f.type === "boolean" ? (
            <input type="checkbox" checked={values[f.name] === true} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))} />
          ) : f.type === "enum" ? (
            <select className="cl-palette__input" value={String(values[f.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
              <option value="">{S.paletteChoose}</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="cl-palette__input"
              type={f.type === "number" ? "number" : "text"}
              value={String(values[f.name] ?? "")}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              {...(f.description ? { "aria-description": f.description, placeholder: f.description } : {})}
            />
          )}
        </label>
      ))}
      {error && (
        <p className="cl-palette__error" role="alert">
          {error}
        </p>
      )}
      <div className="cl-palette__actions">
        <button type="button" className="cl-palette__button" onClick={onBack}>
          {S.paletteBack}
        </button>
        <button type="submit" className="cl-palette__button cl-palette__button--primary">
          {S.paletteRun}
        </button>
      </div>
    </form>
  );
}

export function Palette(props: PaletteProps) {
  const { commands, places, bound, platform } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [form, setForm] = useState<PaletteCommand | undefined>(() => commands.find((c) => c.name === props.start));
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" } | undefined>(undefined);
  const [rebinding, setRebinding] = useState<string | undefined>(undefined);
  /** The key just pressed was one no command takes: the row says so and waits for another. */
  const [refused, setRefused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [form]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const cmd = commands
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .map((c) => ({ kind: "command" as const, id: `c:${c.name}`, c }));
    const go = places.filter((p) => !q || p.title.toLowerCase().includes(q) || (p.detail ?? "").toLowerCase().includes(q)).map((p) => ({ kind: "go" as const, id: `g:${p.id}`, p }));
    return [...go, ...cmd];
  }, [commands, places, q]);

  const run = (c: PaletteCommand, given?: Record<string, unknown>) => {
    // A command that takes args asks for them; one whose schema takes none (or only optional ones it can do without)
    // runs as it is, with what its schema takes (`{}` for an object), checked first (N4).
    if (given === undefined && (fieldsOf(c.args).length > 0 || !runsBare(c.args))) return setForm(c);
    const args = given ?? noArgs(c.args);
    setStatus({ text: S.paletteRunning(c.name), tone: "info" });
    props.onRun(c.name, args).then(
      () => props.onClose(),
      (err: unknown) => {
        setForm(undefined);
        setStatus({ text: S.paletteFailed(c.name, err instanceof Error ? err.message : String(err)), tone: "error" });
      },
    );
  };
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "go") {
      r.p.go();
      props.onClose();
    } else run(r.c);
  };

  if (form) return <div className="cl-palette" role="dialog" aria-modal="true" aria-label={S.palette}><ArgsForm command={form} onRun={(a) => run(form, a)} onBack={() => setForm(undefined)} /></div>;

  return (
    <div
      className="cl-palette"
      role="dialog"
      aria-modal="true"
      aria-label={S.palette}
      onKeyDown={(e) => {
        if (rebinding) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            setRefused(false);
            return setRebinding(undefined);
          }
          if (isModifierOnly(e.nativeEvent)) return;
          const chord = chordOf(e.nativeEvent);
          if (reserved(chord, platform)) return setRefused(true);
          setRefused(false);
          props.onRebind?.(rebinding, writeChord(chord, platform));
          return setRebinding(undefined);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(rows.length - 1, a + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter" && e.target === input.current) {
          e.preventDefault();
          pick(active);
        } else if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <input
        ref={input}
        className="cl-palette__search"
        role="combobox"
        aria-expanded="true"
        aria-controls="cl-palette-list"
        aria-activedescendant={rows[active] ? `cl-palette-${rows[active]!.id}` : undefined}
        aria-label={S.paletteSearch}
        placeholder={S.paletteSearch}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
      />
      {status && (
        <p className="cl-palette__status" role={status.tone === "error" ? "alert" : "status"} data-tone={status.tone}>
          {status.text}
        </p>
      )}
      <ul className="cl-palette__list" id="cl-palette-list" role="listbox" aria-label={S.paletteResults}>
        {rows.length === 0 && <li className="cl-palette__empty">{S.paletteNone}</li>}
        {rows.map((r, i) => {
          const key = r.kind === "command" ? bound.get(r.c.name) : undefined;
          return (
            <li key={r.id} id={`cl-palette-${r.id}`} role="option" aria-selected={i === active} className="cl-palette__row" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
              <span className="cl-palette__text">
                <span className="cl-palette__name">{r.kind === "command" ? r.c.name : r.p.title}</span>
                <span className="cl-palette__detail">{r.kind === "command" ? r.c.description : (r.p.detail ?? S.paletteGo)}</span>
              </span>
              {r.kind === "command" && (
                <span className="cl-palette__keys">
                  {rebinding === r.c.name ? (
                    <span className="cl-palette__kbd" role="status">
                      {refused ? S.paletteKeyTaken : S.palettePressKeys}
                    </span>
                  ) : (
                    key && <kbd className="cl-palette__kbd">{showChord(key, platform)}</kbd>
                  )}
                  {props.onRebind && (
                    <button
                      type="button"
                      className="cl-palette__button"
                      aria-label={S.paletteRebind(r.c.name)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRebinding(r.c.name);
                      }}
                    >
                      {S.paletteChangeKey}
                    </button>
                  )}
                  {props.onRebind && key && (
                    <button
                      type="button"
                      className="cl-palette__button"
                      aria-label={S.paletteUnbind(r.c.name)}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onRebind?.(r.c.name, null);
                      }}
                    >
                      {S.paletteRemoveKey}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A command as the palette lists it, from the core's view. */
export const paletteCommand = (c: { name: string; pluginId: string; description: unknown; args?: Record<string, unknown> }): PaletteCommand => ({
  name: c.name,
  pluginId: c.pluginId,
  description: plain(c.description as Parameters<typeof plain>[0]),
  ...(c.args ? { args: c.args } : {}),
});
