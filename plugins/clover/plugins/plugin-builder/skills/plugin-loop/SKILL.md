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

## 5. Change it, and let it reload

Until Clover can let you edit an installed plugin in place, change it in your scratch folder and install it again
(the install tool, same id): that updates your plugin at once when the change adds nothing to its card, and asks the
user again otherwise. The check tool's last line tells you which, before you install.

### Editing in place (NOT IN THIS BUILD YET)

<!-- pending: lane A's fence exception for a bot's own plugin folder (lane/a-workshop-fence), merging with lane B's workshop tools; a test fails once the core's install text says "edit it in place" and the fence context has the workshop exception, and this section still says "NOT IN THIS BUILD YET" -->

Once it is there, the install tool's text says so, and after the OK the plugin lives at `plugins/<id>` under Clover's
home: that is where you edit it from then on (a plugin you built is the one place in Clover's home you may write).
An edit there reloads at once, code included: the host half is replaced, the client is rebuilt, and the app's layers
reload the components. Call the status tool after each edit and read what it says before the next one.

### What asks the user again

Whichever way you change it, a change that asks for more than the card the user OK'd stops at a new card instead of
applying: a new capability, a new network host, a new program (a `stdio` server's or a hook's command), a new tool
that skips the card (`readOnly`, `contained`), a setting's default it runs with, a window skin, or anything else the
card lists. A grant you dropped and add back asks again too. A change to how it styles approval cards waits for its
own OK, and in a plugin holding `approvals` every code change waits. Before such a change, tell the user what you are
adding and why; after it, the plugin waits for their answer and keeps running as it was.

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
