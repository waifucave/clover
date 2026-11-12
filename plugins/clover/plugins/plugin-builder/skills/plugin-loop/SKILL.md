---
name: plugin-loop
description: The loop for building a Clover plugin step by step - scaffold it in your scratch folder, check it, install it for the user's OK, then edit it in place where it is installed, let it reload, read its state and errors, and fix. Read it before the first step of building or changing a plugin.
---

# The loop: scaffold, check, install, edit, reload

building-plugins names the four tools this loop uses: the scaffold tool, the check tool, the install tool and the
status tool.

## 1. Agree what it is

Tell the user in a sentence or two what you'll build and what it will need from them: any capability on the OK card,
any website it reaches, any sign-in or key. Choose the least that works (plugin-cards). Pick an id: lowercase letters,
digits and single hyphens, starting with a letter; it can't be changed later without a new plugin.

## 2. Scaffold in your scratch folder

Call the scaffold tool with the closest template (`tool`, `ui`, `theme`, `bot`, `model`, `trigger`, `point`) and write
each file it returns into `<your scratch folder>/<id>/`. For an app, a status entry or a spot of your own, start
from `ui` and copy the matching example in plugin-examples. The folder's name must be the id.

## 3. Write it, then check it

Write the manifest (plugin-manifest) and the code (plugin-ui, plugin-host). Then call the check tool on the folder.
It runs Clover's own validator: each finding names the file, the place (a JSON pointer such as
`/contributes/ui/0/spot`) and what is wrong. Fix every error; read every warning. Check again until it's clean.
Checking runs nothing, so it is cheap: check after every few edits.

## 4. Install: the user's OK

Call the install tool on the folder. The plugin lands *found* and the user gets the sealed OK card, which names you
as its builder and lists what it may do. Nothing in it runs until the user says yes. Tell the user the card is
waiting and what it will say; don't press them. If they say no, ask what to change.

After the OK, call the status tool: running is good; "Waiting for: …" means it waits for something (a required
setting, a part of the app that isn't shown yet: a Settings section waits until Settings opens, which is normal);
invalid, stopped or refused come with the reason: the findings, a client build's error text, or the log's last lines.

## 5. Edit it in place, and let it reload

After the OK, the plugin lives at `plugins/<id>` under Clover's home, and that is where you edit it from then on:
your conversation and side threads may write inside a plugin you built (never the folder itself, never a `.git` in
it, never another plugin), with your file tools or in your shell. Clover reloads it about two seconds after your last
write, code included: the host half is replaced, the client is rebuilt, and the app's layers reload the components.
Call the status tool after each round of edits and read what it says before the next one. Your scratch copy is not
the plugin any more; work in the installed one. (Installing your scratch folder again with the same id also updates
it, under the same rule below.)

### What asks the user again

An edit applies at once while it asks for nothing the card the user OK'd didn't list. These stop at a new card
instead: a new capability, a new network host, a new program (a `stdio` server's or a hook's command, or a point's
code field), a new tool that skips the card (`readOnly`, `contained`), a setting's default it runs with, a window skin,
or anything else the card lists (its name, its author, add-ons, hook events, adult content). Each applied edit becomes
the new ceiling, so a grant you dropped and add back asks again. A change to how it styles approval cards waits for
its own OK, and a plugin holding `approvals` (it places approval cards) holds every code change for the user's OK.
Before such an edit, tell the user what you are adding and why; after it, the plugin waits for their answer and keeps
running as it was. The check tool's last line says, for a folder, whether installing it would apply at once or ask.

## 6. Finding what's wrong

- **Check findings**: fix exactly what each says; the place is a JSON pointer into the manifest or a file path.
- **A client build failure**: the status tool gives the bundler's error with file and line; most often an import
  that isn't the UI SDK or React (plugin-ui), or a typo.
- **The host half failed**: the status tool's log lines hold the thrown error; a handler named in the manifest must
  be an export of `host.entry` with that exact name.
- **Nothing shows**: the spot's part isn't on screen yet (open it), `when` doesn't match, a bot's plugin drew outside
  its tab, or the entry's `component` isn't exported.
- **A tool isn't there**: on-demand tools are loaded with `Glossary`; the session sees `mcp__<server>__<tool>`.
- Never guess at a fix twice: read the status again.

## 7. Done

Tell the user what the plugin does, where to find it (a sidebar button, a Settings section, a tool you can now use),
and what it can't do yet. Ask them to try it, and offer the next change.
