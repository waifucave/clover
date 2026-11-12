// The avatar's section of a bot's editor: the `bot.editor.section` entry this part fills. It lists the avatars the installed
// packs offer (`avatar.packs`), takes the user's own model from a file or folder main's picker names (a token, never a
// path) through `bot.importAvatar`, and keeps the model's own credit note. What an import takes comes from the renderers'
// `avatar.formats`; with none installed and on the section says so and offers neither packs nor an import. The user layer
// is written through the core's door for this part (`bot.setUserLayer`, only `avatar` and `avatarCredit`).
import { useEffect, useId, useState } from "react";
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import type { AvatarPackEntry, BotRef, BotView, EntryProps, PointEntry } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { useCore, usePluginApi } from "./sdk";
import { S } from "./strings";

/** What the section reads of an `avatar.formats` entry (a renderer's declaration of the format it draws). */
interface AvatarFormatView {
  format: string;
  name: string | { en: string; [lang: string]: string };
  entry: { extensions: string[] };
  files: { kinds: { ext: string[] }[]; maxFiles?: number };
  import?: { accepts: ("folder" | "zip" | "file")[] };
}

interface Choice { id: string; name: string; pack: string; file: string; format: string; portraitUrl?: string }

/** One format's ways in, as the core's import takes them: an entry file in a folder or zip, or one picked file. */
function takesOf(f: AvatarFormatView): string {
  const accepts = f.import?.accepts ?? ["folder", "zip", "file"];
  const entries = f.entry.extensions.filter((e) => e !== ".zip");
  const held = accepts.some((a) => a !== "file") ? entries : [];
  const files = accepts.includes("file") ? [...new Set([...entries, ...(f.files.maxFiles === 1 ? f.files.kinds.flatMap((k) => k.ext) : [])])] : [];
  return S.avatarTakes(plain(f.name), held, files);
}

const shown = (text: string, max: number): string => displayText(text, max) ?? "";
const reasonOf = (err: unknown): string => shown(err instanceof Error ? err.message : String(err), 300);
const sizeOf = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

/** The credit or terms note of the user's own avatar, as text: shown, and the user's to change or clear. */
function CreditNote({ credit, onCredit }: { credit: string; onCredit: (text: string) => void }) {
  const [text, setText] = useState(credit);
  const id = useId();
  useEffect(() => setText(credit), [credit]);
  return (
    <form className="cl-avatar-section__credit" onSubmit={(e) => { e.preventDefault(); onCredit(text.trim()); }}>
      <label className="cl-avatar-section__detail" htmlFor={id}>{S.credit}</label>
      <textarea id={id} className="cl-avatar-section__textarea" aria-label={S.creditEdit} value={text} rows={2} maxLength={300} onChange={(e) => setText(e.target.value)} />
      <div className="cl-avatar-section__inline">
        <button type="submit" className="cl-avatar-section__button" disabled={text.trim() === credit}>{S.creditSave}</button>
        <button type="button" className="cl-avatar-section__reset" disabled={credit === "" && text === ""} onClick={() => onCredit("")}>{S.creditClear}</button>
      </div>
    </form>
  );
}

export function AvatarSection({ props }: EntryProps<{ bot: BotRef }>) {
  const api = usePluginApi();
  const core = useCore();
  const labelId = useId();
  const id = props.bot.id;
  const [bot, setBot] = useState<BotView | undefined>(undefined);
  const [packs, setPacks] = useState<Choice[]>([]);
  const [formats, setFormats] = useState<AvatarFormatView[] | undefined>(undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [pick, setPick] = useState<{ token: string; name: string } | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "ok" | "danger"; text: string } | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    let live = true;
    api.bots?.get(id).then((b) => live && setBot(b), () => undefined);
    const stop = api.bots?.watch((b) => { if (b.id === id) { setBot(b); setWaiting(false); } });
    return () => { live = false; stop?.(); };
  }, [api, id]);

  useEffect(() => {
    let live = true;
    const toChoices = (entries: PointEntry<AvatarPackEntry>[], names: Record<string, string>): Choice[] =>
      entries.map((e) => ({
        id: `${e.pluginId}#${e.entryId}`,
        name: e.value.name ?? e.entryId,
        pack: names[e.pluginId] ?? e.pluginId,
        file: e.value.file,
        format: e.value.format,
        ...(e.value.portrait ? { portraitUrl: e.value.portrait } : {}),
      }));
    void Promise.all([api.points.entries<AvatarPackEntry>("avatar.packs").catch(() => []), core?.call("plugin.list", {}).catch(() => undefined)]).then(([entries, list]) => {
      if (!live) return;
      const names = Object.fromEntries((list?.plugins ?? []).map((p) => [p.id, plain(p.name)]));
      setPacks(toChoices(entries, names));
    });
    const stopPacks = api.points.watch<AvatarPackEntry>("avatar.packs", (entries) => setPacks(toChoices(entries, {})));
    // The formats the installed renderers declare: what an import of the user's own model takes, and their names.
    void api.points.entries<AvatarFormatView>("avatar.formats").catch(() => []).then((entries) => live && setFormats(entries.map((e) => e.value)));
    const stopFormats = api.points.watch<AvatarFormatView>("avatar.formats", (entries) => setFormats(entries.map((e) => e.value)));
    return () => { live = false; stopPacks(); stopFormats(); };
  }, [api, core]);

  if (formats === undefined || bot === undefined) return null;
  const own = bot.userLayer.includes("avatar");
  const label = <span className="cl-avatar-section__label" id={labelId}>{S.avatar}</span>;

  // Nothing installed draws any format: no pack to choose, no import that takes nothing.
  if (formats.length === 0) {
    return (
      <section className="cl-avatar-section" data-empty="renderer" aria-labelledby={labelId}>
        <div className="cl-avatar-section__text">{label}<p className="cl-avatar-section__detail">{S.noRenderer}</p></div>
      </section>
    );
  }

  const write = (patch: Record<string, unknown>) => {
    void core?.call("bot.setUserLayer", { id, patch }).then((r) => { if (!r.applied) setWaiting(true); }, () => undefined);
  };

  const pickFile = (kind: "file" | "folder") => {
    if (!core) return;
    setStatus(undefined);
    core.call("ui.pick", { kind, use: "bot.importAvatar" }).then(
      (r) => {
        if ("cancelled" in r) { setPick(undefined); setStatus({ tone: "info", text: S.pickCancelled }); } else setPick({ token: r.token, name: shown(r.name, 80) });
      },
      (err: unknown) => setStatus({ tone: "danger", text: S.failed(reasonOf(err)) }),
    );
  };

  const importIt = () => {
    if (!core || !pick) return;
    setImporting(true);
    setStatus(undefined);
    core.call("bot.importAvatar", { id, path: pick.token }).then(
      (r) => {
        setPick(undefined);
        setImporting(false);
        const named = formats.find((f) => f.format === r.format)?.name;
        setStatus({ tone: "ok", text: S.imported(r.name ?? (named === undefined ? r.format : plain(named)), r.files, sizeOf(r.bytes)) });
      },
      (err: unknown) => {
        // The token is spent whether or not the import went: pick again.
        setPick(undefined);
        setImporting(false);
        setStatus({ tone: "danger", text: S.failed(reasonOf(err)) });
      },
    );
  };

  const credit = own ? bot.avatar?.credit : undefined;
  return (
    <section className="cl-avatar-section" aria-labelledby={labelId}>
      <div className="cl-avatar-section__text">
        {label}
        <span className="cl-avatar-section__detail">{S.avatarDetail}</span>
        {waiting && <span className="cl-avatar-section__waiting" role="status">{S.waiting}</span>}
      </div>
      <div className="cl-avatar-section__control">
        {packs.length === 0 ? (
          <p className="cl-avatar-section__empty">{S.noAvatars}</p>
        ) : (
          <ul className="cl-avatar-section__avatars" role="radiogroup" aria-label={S.avatar}>
            {packs.map((a) => {
              const on = own && chosen === a.file;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="cl-avatar-section__avatar"
                    onClick={() => { setChosen(a.file); write({ avatar: { file: a.file, format: a.format, ...(a.portraitUrl ? { portrait: a.portraitUrl } : {}) } }); }}
                  >
                    {a.portraitUrl ? <img className="cl-avatar-section__face" src={a.portraitUrl} alt="" /> : <span className="cl-avatar-section__face" aria-hidden="true">{initial(a.name)}</span>}
                    <span className="cl-avatar-section__avatar-name">{a.name}</span>
                    <span className="cl-avatar-section__avatar-pack">{S.avatarFrom(a.pack)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="cl-avatar-section__import">
          <p className="cl-avatar-section__detail">{S.avatarOwnDetail(formats.map(takesOf))}</p>
          <div className="cl-avatar-section__inline">
            <button type="button" className="cl-avatar-section__button" disabled={importing} onClick={() => pickFile("file")}>{S.chooseAvatar}</button>
            <button type="button" className="cl-avatar-section__reset" disabled={importing} onClick={() => pickFile("folder")}>{S.chooseFolder}</button>
          </div>
          {pick && (
            <div className="cl-avatar-section__inline">
              <span className="cl-avatar-section__value">{S.chosen(pick.name)}</span>
              <button type="button" className="cl-avatar-section__button" disabled={importing} onClick={importIt}>{importing ? S.importing : S.importAvatar}</button>
              {own && bot.avatar?.src.startsWith("/_a/") && <span className="cl-avatar-section__detail">{S.replaces}</span>}
            </div>
          )}
          {(credit !== undefined || status?.tone === "ok") && <CreditNote credit={credit ?? ""} onCredit={(text) => write({ avatarCredit: text === "" ? null : text })} />}
          {status && <p className="cl-avatar-section__status" data-tone={status.tone} role="status">{status.text}</p>}
        </div>
        {own && <button type="button" className="cl-avatar-section__reset" aria-label={S.resetAvatar} onClick={() => { setChosen(undefined); write({ avatar: null }); }}>{S.reset}</button>}
      </div>
    </section>
  );
}
