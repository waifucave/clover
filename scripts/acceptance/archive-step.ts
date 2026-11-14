// The archive of the previous app's sessions (checklist 4.14; spec §14.1): a code session the previous app left in this
// home (written into the home's session store before the daemon starts, as that app kept it) is listed on the Archive
// page by its title, opens read-only, and its transcript shows what was said, the user's message and the reply.
import { SessionStore } from "../../packages/core/src/sessions/store";
import { clickTree, escape, fail, SIDEBAR_ITEMS, treeDocs, until, type ExampleCtx } from "./example-steps";

export const ARCHIVE_STEP = "the archive: a code session the previous app left in the home is listed on the Archive page by its title, opens read-only, and its transcript shows the user's message and the reply";

export const ARCHIVE_TITLE = "Acceptance old session";
const SAID = "ACCEPTANCE-ARCHIVE: how do I list the files?";
const REPLY = "ACCEPTANCE-ARCHIVE-REPLY: run ls in the folder.";

/** The previous app's session, written into the home's store before any daemon opens it. Its id. */
export function seedArchive(home: string): string {
  const store = new SessionStore(home);
  try {
    const id = store.createSession("global", { mode: "code" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: SAID, clientName: "previous-app" } as never);
    store.append(id, { type: "assistant_message", sessionId: id, threadId: "main", text: REPLY } as never);
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: ARCHIVE_TITLE } as never);
    return id;
  } finally {
    store.close();
  }
}

export async function archiveStep(ctx: ExampleCtx): Promise<string> {
  const { cdp, rpc } = ctx;
  const listed = await rpc.request<{ sessions: { id: string; title?: string; mode: string }[] }>("archive.list", {});
  const mine = listed.sessions.find((s) => s.title === ARCHIVE_TITLE);
  if (mine === undefined) fail(`archive.list doesn't list the old session (${listed.sessions.map((s) => s.title ?? s.id).join(", ") || "none"})`);
  // From the window's own sidebar, as the user reaches it on any tab (Alpha's too: the stock sidebar is beside every tab), out of any dialog first.
  await escape(cdp);
  for (const d of await treeDocs(cdp)) await cdp.evaluate(d.session, "document.querySelector('.cl-settings__close')?.click()").catch(() => undefined);
  await clickTree(cdp, "the sidebar's Archive row", SIDEBAR_ITEMS, "Archive");
  await clickTree(cdp, `the old session in the Archive list (${ARCHIVE_TITLE})`, "button.cl-archive__session", ARCHIVE_TITLE, 30_000);
  const text = await until("its transcript in the reader", 30_000, async () => {
    let all = "";
    for (const d of await treeDocs(cdp)) all += `\n${String(await cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => ""))}`;
    return all.includes(SAID) && all.includes(REPLY) && all.includes("Read only. Start something new with a bot.") ? all : undefined;
  }, async () => {
    // What the reader shows, in whichever document holds it.
    let all = "";
    for (const d of await treeDocs(cdp)) {
      const r = String(await cdp.evaluate(d.session, "(() => { const r = document.querySelector('.cl-archive__reader'); return r ? r.innerText.slice(0, 600) : ''; })()").catch(() => ""));
      if (r !== "") all += ` | ${d.url}: ${r}`;
    }
    const hist = await rpc.request<{ events: { type: string }[] }>("archive.history", { id: mine!.id }).then((h) => h.events.map((e) => e.type).join(","), (e: unknown) => `archive.history refused: ${String(e).slice(0, 200)}`);
    let html = "";
    for (const d of await treeDocs(cdp)) {
      const t = String(await cdp.evaluate(d.session, "(() => { const r = document.querySelector('.cl-archive__transcript'); return r ? r.innerHTML.slice(0, 500) : ''; })()").catch(() => ""));
      if (t !== "") html += ` transcript html: ${t}`;
    }
    return `${(all.slice(0, 1000) || "no .cl-archive__reader in any document")}; its history: ${hist};${html}`;
  });
  void text;
  return `archive.list lists "${ARCHIVE_TITLE}" (${mine!.mode}); the Archive page opened it, its transcript shows the user's message and the reply`;
}
