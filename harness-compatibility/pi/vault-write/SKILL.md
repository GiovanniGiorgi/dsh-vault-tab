---
name: vault-write
description: Create, edit, move and delete notes in a markdown vault (PARA + wiki links + MOC indexes) with the plain file tools — any editing style, but every change ends integrity-checked: no link resolving to nothing, no note unindexed, no dangling referrer after a move or delete. Use when asked to save, fix, reorganize or clean up vault content.
---

# Writing into the vault

You change the vault with the ordinary tools — `read`, `edit`, `write`,
`bash`. There is no gate and no permission to ask: how you write is free.
What is not negotiable is what must remain true when you are done:

- no link resolves to nothing
- every note is reachable from an index
- a moved or deleted path leaves no referrer behind
- material marked immutable stays untouched

The vault's own files carry the rules; this skill carries the flow. Never
restate the policy from memory, and never let the user be the one who
remembers it.

## 1. Locate the vault, then read the rules

Root resolution, first match wins: path named by the user → `$VAULT_ROOT` /
`$VAULT_PATH` → `.vault-root` file in the working directory or ancestors →
`~/.config/vault-skills/root` → ask (and offer to persist the answer there).

Then, **before the first change**, every time:

1. Read the root `POLICY.md`: naming, structure, frontmatter, budgets, link
   form, where notes go.
2. Read the **target folder's** `POLICY.md` when one sits there — inside that
   folder it overrides the root.
3. No `POLICY.md` anywhere? Tell the user the vault has no policy of its own;
   mirror the conventions of neighbouring notes and say which ones you are
   following. Do not invent structure.

## 2. Link form

Follow the policy's link form. When it is silent, use the one shape link
upkeep can follow: `[[path/from/the/vault/root]]` — no `.md`, no short names;
embeds repeat it with `!`. External links (`https://…`) are plain markdown
and nothing here rewrites them.

A link in another shape that you happen to find is an error to fix when you
are editing that line anyway — never a form to imitate in new writing.

## 3. Creating

**Search first** (the `vault-read` loop): a duplicate note is the one answer
that gets worse with time.

A note is not a bare file: it arrives with its two halves in the same change —

1. the file: from the vault's `99-Templates/<type>.md` when templates exist,
   complete frontmatter, `kebab-case` name derived from the title (accents
   folded; CJK keeps its characters), and a `summary:` that holds the words
   someone would search for — the retrieval key, not a tagline (default
   budget: target 100 chars, hard max 140; the policy's numbers win). Write
   the summary last, when the note is what it is.
2. the index line: one list item (link + short annotation) in the `00-*.md`
   MOC that owns the folder. A note no MOC links is a file, not knowledge.

Placement follows the policy; the usual shape: facts and decisions →
`10-Projects/`, durable knowledge → `30-Resources/`, long-lived
responsibilities → `20-Areas/`, dead material → `40-Archive/`.

One note = one concept (~80 lines). A note that outgrows itself is split and
linked, not extended; material that cannot be atomic is not a note — it goes
to `90-Reference/` and the distilled note cites it in `source:`.

## 4. The check closes every change

After **every** write, run the checker and finish the blocking issues in the
same change — they are the vault's budgets, not decoration:

```bash
# scripts/vault_check.py lives in this skill's own folder
python3 <skill-dir>/scripts/vault_check.py --root "$ROOT" \
  --changed <path/relative/to/root> [...]
```

It reports `broken-link` / `dangling-link` / `summary-over-max` as BLOCKING
(fix now) and `not-indexed`, `no-summary`, name hygiene as warnings (fix what
belongs to your change, report the rest). If the vault's policy sets different
budgets, pass `--max-summary` / `--summary-target` / `--skip`.

## 5. Renaming and moving

Upkeep is your job, and the order matters:

1. Note the old path. Before moving anything, list the referrers:
   `grep -rn '\[\[old/path' "$ROOT" --include='*.md'`
2. Move (`mv`) — a folder moves with everything under it; folders never
   merge onto existing folders.
3. Rewrite every `[[old/path]]` and `[[old/path/…]]` (and their `![[…]]`
   forms) in the files found at step 1, links inside moved files included —
   except code fences and immutable `90-Reference/` material.
4. Fix the MOC lines: the note must stay reachable at its new path.
5. Close with the checker, old path as removed, everything touched as changed:
   ```bash
   scripts/vault_check.py --root "$ROOT" --removed old/path --changed new/path referrer1 ...
   ```
   If a referrer sits where you may not edit (immutable material), stop,
   list it, ask the user — do not "fix" it silently and do not proceed as if
   it were clean.

Meaning matters where grep cannot see: a renamed project, a note whose body
states something false once it moves, a MOC annotation that no longer
describes its entries.

## 6. Deleting

No trash here: a delete is final, so the link check runs **before** it.

1. `grep -rn '\[\[path' "$ROOT" --include='*.md'` (plus the `.md` href form).
2. Nothing points at it → a single file may go (your own scratch and test
   notes); report what went.
3. Referrers exist → show them (`path:line`) and ask: remove those lines too,
   keep the note, or move it to `40-Archive/` — then finish the whole agreed
   set. Delete anyway only after the user chose to accept broken links.
4. Links *inside* a deleted path do not count — they go with it. What counts
   lives outside and would point at nothing.
5. A **folder**, or anything under `99-Templates/`, needs the user's explicit
   confirmation for that exact path: links point at the notes inside a folder,
   never at the folder, so a clean check says nothing about it.
6. The vault root itself never gets deleted.

## 7. `90-Reference/` is immutable

Import whole, cite from the distilled note's `source:` (a quoted wiki link:
`"[[90-Reference/<project>/<document>]]"`). No edits, no reformatting, no
link upkeep inside; imported relative links stay as imported. New material: a
per-project subfolder with its own `00-<project>.md` index, listed in
`90-Reference/00-Reference.md`.

## 8. Where this stops

Work ends in the working tree. Writing files is enough: no `git add`, no
`git commit` — "update the note" is not a commit request. Committing is
`vault-git`'s job and happens only on the user's explicit word.
