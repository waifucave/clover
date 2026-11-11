---
name: tidy-up
description: Tidy the user's notes: merge duplicates, group them by topic, and suggest which to delete.
---

# Tidy up the notes

1. Read every note with `list_notes`.
2. Find the duplicates and near-duplicates. Say which you'd merge, in one line each.
3. Group the rest by topic, a few words per group.
4. Suggest which notes look done or stale, and ask before deleting any: `delete_note` asks the user too.
5. Add a merged note with `add_note` only after the user agrees.
