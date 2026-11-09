// The bot editor: a page in the main area (`main` keyed `bot-editor`), one row per field of the bot's user layer.
// A text field saves when the user says so; a pick saves at once. A field the user set shows Reset, which clears it
// back to the bot's plugin. A change that waits on a card says so under its field. The LAN switch is the person's
// alone (§9.1, lane D's #263): off by default, and turning it off clears it.
import { useEffect, useId, useState, type ReactNode } from "react";
import { IconBack, IconCheck } from "./icons";
import { S } from "./strings";
import type { BotEditorProps, BotField } from "./types";

function Row({ label, detail, field, own, waiting, onReset, children, wide }: {
  label: string;
  detail?: string;
  field: BotField;
  own: boolean;
  waiting: boolean;
  onReset: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <section className="cl-bot-editor__row" data-wide={wide || undefined} aria-labelledby={id}>
      <div className="cl-bot-editor__text">
        <span className="cl-bot-editor__label" id={id}>
          {label}
        </span>
        {detail && <span className="cl-bot-editor__detail">{detail}</span>}
        {waiting && (
          <span className="cl-bot-editor__waiting" role="status">
            {S.waiting}
          </span>
        )}
      </div>
      <div className="cl-bot-editor__control">
        {children}
        {own && (
          <button type="button" className="cl-bot-editor__reset" aria-label={S.resetField(S.fields[field])} onClick={onReset}>
            {S.reset}
          </button>
        )}
      </div>
    </section>
  );
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

export function BotEditor(props: BotEditorProps) {
  const { bot, own, onChange } = props;
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState("");
  useEffect(() => setName(bot.name), [bot.name]);
  const is = (f: BotField) => own.includes(f);
  const reset = (f: BotField) => () => onChange({ [f]: null });
  const row = (f: BotField) => ({ field: f, own: is(f), waiting: props.waiting === f, onReset: reset(f) });
  const efforts = props.model.models.find((m) => m.id === props.model.value)?.efforts ?? [];
  const models = props.model.models.some((m) => m.id === props.model.value) ? props.model.models : [{ id: props.model.value, label: props.model.value }, ...props.model.models];

  return (
    <div className="cl-bot-editor">
      <header className="cl-bot-editor__head">
        <button type="button" className="cl-bot-editor__back" onClick={props.onBack}>
          <IconBack />
          {S.back}
        </button>
        <div className="cl-bot-editor__who">
          {bot.portraitUrl ? <img className="cl-bot-editor__portrait" src={bot.portraitUrl} alt="" /> : <span className="cl-bot-editor__portrait" aria-hidden="true">{initial(bot.name)}</span>}
          <h1 className="cl-bot-editor__title">{S.title(bot.name)}</h1>
        </div>
        <p className="cl-bot-editor__intro">{S.intro(bot.name)}</p>
      </header>

      <div className="cl-bot-editor__rows">
        <Row label={S.name} detail={S.nameDetail} {...row("name")}>
          <form
            className="cl-bot-editor__inline"
            onSubmit={(e) => {
              e.preventDefault();
              const next = name.trim();
              if (next && next !== bot.name) onChange({ name: next });
            }}
          >
            <input className="cl-bot-editor__input" aria-label={S.name} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="cl-bot-editor__button" disabled={name.trim() === "" || name.trim() === bot.name}>
              {S.save}
            </button>
          </form>
        </Row>

        <Row label={S.instructions} detail={S.instructionsDetail(bot.name)} wide {...row("instructions")}>
          <form
            className="cl-bot-editor__stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (instructions.trim()) onChange({ instructions });
            }}
          >
            <textarea
              className="cl-bot-editor__textarea"
              aria-label={S.instructions}
              value={instructions}
              rows={5}
              placeholder={is("instructions") ? S.instructionsSet : S.instructionsPlaceholder}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <button type="submit" className="cl-bot-editor__button" disabled={instructions.trim() === ""}>
              {S.save}
            </button>
          </form>
        </Row>

        <Row label={S.model} detail={S.modelDetail} {...row("model")}>
          <select className="cl-bot-editor__select" aria-label={S.model} value={props.model.value} onChange={(e) => onChange({ model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.detail ? `${m.label} · ${m.detail}` : m.label}
              </option>
            ))}
          </select>
          {efforts.length > 0 && (
            <select className="cl-bot-editor__select cl-bot-editor__select--small" aria-label={S.effort} value={props.model.effort ?? ""} onChange={(e) => onChange({ effort: e.target.value })}>
              {!props.model.effort && <option value="">{S.effort}</option>}
              {efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          )}
        </Row>

        <Row label={S.avatar} detail={S.avatarDetail} wide {...row("avatar")}>
          {props.avatars.length === 0 ? (
            <p className="cl-bot-editor__empty">{S.noAvatars}</p>
          ) : (
            <ul className="cl-bot-editor__avatars" role="radiogroup" aria-label={S.avatar}>
              {props.avatars.map((a) => {
                const on = props.avatar === a.file;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className="cl-bot-editor__avatar"
                      onClick={() => onChange({ avatar: { file: a.file, format: a.format, ...(a.portraitUrl ? { portrait: a.portraitUrl } : {}) } })}
                    >
                      {a.portraitUrl ? <img className="cl-bot-editor__avatar-face" src={a.portraitUrl} alt="" /> : <span className="cl-bot-editor__avatar-face" aria-hidden="true">{initial(a.name)}</span>}
                      <span className="cl-bot-editor__avatar-name">{a.name}</span>
                      <span className="cl-bot-editor__avatar-pack">{S.avatarFrom(a.pack)}</span>
                      {on && (
                        <span className="cl-bot-editor__avatar-check">
                          <IconCheck />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Row>

        <Row label={S.voice} detail={S.voiceDetail} {...row("voice")}>
          <span className="cl-bot-editor__value">{props.voice ? S.voiceOf(props.voice.provider, props.voice.voice) : S.noVoice}</span>
        </Row>

        <Row label={S.theme} detail={S.themeDetail} {...row("theme")}>
          <select
            className="cl-bot-editor__select"
            aria-label={S.theme}
            value={is("theme") ? (props.theme ?? "") : ""}
            onChange={(e) => onChange({ theme: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">{S.themeOwn}</option>
            {props.themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Row>

        <Row label={S.layout} detail={S.layoutDetail} {...row("layout")}>
          <span className="cl-bot-editor__value">{is("layout") ? S.layoutYours : S.layoutOwn}</span>
        </Row>

        {/* The switch is the whole field: off clears it, so it has no Reset of its own. */}
        <Row label={S.lan} detail={S.lanDetail(bot.name)} {...row("lan")} own={false}>
          <button type="button" role="switch" aria-checked={props.lan === true} aria-label={S.lan} className="cl-bot-editor__switch" onClick={() => onChange({ lan: props.lan === true ? null : true })}>
            <span className="cl-bot-editor__knob" />
          </button>
        </Row>
      </div>
    </div>
  );
}
