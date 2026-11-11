// The Plugins page's Add tab: a plugin from a folder (main's own picker: the page holds a one-use token and the
// folder's name, never its path), from npm, a pasted MCP server config or address, or an index (the Find tab). Every
// install lands waiting for the plugin's OK, a sealed card the core raises; the page says so. A zip isn't opened here:
// the page says to unzip it first and choose the folder.
import { useState } from "react";
import { S } from "./strings";
import type { AddProps, AddSource, PickKind } from "./types";

const PICKS: { kind: PickKind; file: boolean }[] = [
  { kind: "folder", file: false },
  { kind: "claude-plugin", file: false },
  { kind: "skill-folder", file: false },
  { kind: "agent-file", file: true },
];

export function Add(props: AddProps) {
  const [pickKind, setPickKind] = useState<PickKind>("folder");
  const [npm, setNpm] = useState("");
  const [npmVersion, setNpmVersion] = useState("");
  const [config, setConfig] = useState("");
  const [url, setUrl] = useState("");
  const picked = props.picked;
  const busy = props.busy === true;
  const install = (s: AddSource) => props.onInstall(s);
  return (
    <div className="cl-plugin-index__add">
      {props.status && (
        <p className="cl-plugin-index__status" data-tone={props.status.tone} role="status">
          {props.status.text}
        </p>
      )}

      <section className="cl-plugin-index__section" aria-label={S.addFolder}>
        <h2 className="cl-plugin-index__subhead">{S.addFolder}</h2>
        <p className="cl-plugin-index__note">{S.addFolderDetail}</p>
        <div className="cl-plugin-index__row" role="radiogroup" aria-label={S.addWhat}>
          {PICKS.map((p) => (
            <label key={p.kind} className="cl-plugin-index__choice">
              <input type="radio" name="cl-plugin-index-pick" checked={pickKind === p.kind} onChange={() => setPickKind(p.kind)} />
              {S.pickKinds[p.kind]}
            </label>
          ))}
        </div>
        <div className="cl-plugin-index__row">
          <button type="button" className="cl-plugin-index__button" disabled={busy} onClick={() => props.onPick(pickKind, PICKS.find((p) => p.kind === pickKind)!.file ? "file" : "folder")}>
            {PICKS.find((p) => p.kind === pickKind)!.file ? S.chooseFile : S.chooseFolder}
          </button>
          {picked && (
            <>
              <span className="cl-plugin-index__meta" data-picked={picked.name}>{S.picked(picked.name)}</span>
              <button type="button" className="cl-plugin-index__install" disabled={busy} onClick={() => install({ from: "picked", kind: picked.kind, token: picked.token })}>
                {S.installName(picked.name)}
              </button>
            </>
          )}
        </div>
        <p className="cl-plugin-index__note">{S.zip}</p>
      </section>

      <section className="cl-plugin-index__section" aria-label={S.addNpm}>
        <h2 className="cl-plugin-index__subhead">{S.addNpm}</h2>
        <form
          className="cl-plugin-index__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (npm.trim() !== "") install({ from: "npm", name: npm.trim(), ...(npmVersion.trim() ? { version: npmVersion.trim() } : {}) });
          }}
        >
          <input className="cl-plugin-index__field" aria-label={S.npmName} placeholder={S.npmName} value={npm} onChange={(e) => setNpm(e.target.value)} />
          <input className="cl-plugin-index__field cl-plugin-index__field--short" aria-label={S.npmVersion} placeholder={S.npmVersion} value={npmVersion} onChange={(e) => setNpmVersion(e.target.value)} />
          <button type="submit" className="cl-plugin-index__install" disabled={busy || npm.trim() === ""}>
            {S.install}
          </button>
        </form>
        <p className="cl-plugin-index__note">{S.npmDetail}</p>
      </section>

      <section className="cl-plugin-index__section" aria-label={S.addMcp}>
        <h2 className="cl-plugin-index__subhead">{S.addMcp}</h2>
        <p className="cl-plugin-index__note">{S.addMcpDetail}</p>
        <textarea className="cl-plugin-index__paste" aria-label={S.mcpConfig} placeholder={S.mcpConfigPlaceholder} value={config} spellCheck={false} onChange={(e) => setConfig(e.target.value)} />
        <div className="cl-plugin-index__row">
          <button type="button" className="cl-plugin-index__install" disabled={busy || config.trim() === ""} onClick={() => install({ from: "wrap", kind: "mcp-config", value: config })}>
            {S.addConfig}
          </button>
        </div>
        <form
          className="cl-plugin-index__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() !== "") install({ from: "wrap", kind: "mcp-url", value: url.trim() });
          }}
        >
          <input className="cl-plugin-index__field" type="url" aria-label={S.mcpUrl} placeholder={S.mcpUrlPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="cl-plugin-index__install" disabled={busy || url.trim() === ""}>
            {S.addUrl}
          </button>
        </form>
      </section>

      <section className="cl-plugin-index__section" aria-label={S.addIndex}>
        <h2 className="cl-plugin-index__subhead">{S.addIndex}</h2>
        <p className="cl-plugin-index__note">{S.addIndexDetail}</p>
        <button type="button" className="cl-plugin-index__button" onClick={props.onFind}>
          {S.tabs.find}
        </button>
      </section>
    </div>
  );
}
