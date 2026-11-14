---
name: vault-write
description: Write into the vault with the vault tools: rules first (root POLICY.md, then the target folder’s POLICY.md); one link form; create, replace, rename/move with automatic link upkeep, deletion behind a link check; the Vault Grant and what to do when writing is refused.
---

# Writing into the vault

One door changes the vault — the `vault_*` tools. The vault's own `POLICY.md` files
decide where a note goes and how it looks — read them **first**, every time. The
skill carries the flow; the vault carries the rules: never restate them from
memory, and never let the user be the one who remembers the policy.

## 1. Rules before the first change

1. `vault_info` — read-only, costs nothing: absolute roots, `hasPolicy`,
   `policyPath`, and this session's `grant` state.
2. Read the root `POLICY.md` (`read` on `policyPath`): naming, structure,
   frontmatter, templates, note placement, MOC upkeep all live there.
3. Read the **target folder's** `POLICY.md` too, when one sits there (check with
   `glob` or `read`). It overrides the root rules inside that folder; root rules
   apply everywhere else.
4. No `POLICY.md` at the root? `vault_info { include: 'default-policy' }` and treat
   that text as binding for this change; tell the user the vault has no policy of
   its own and that **vault-setup** can persist the default at the root.

## 2. The link form: one shape, always

Internal links are `[[path/from/the/vault/root]]` and nothing else: from the root,
**no** `.md`, **no** `|alias`, **no** `#anchor`, **no** short names, **no**
`[text](relative.md)`. Embeds use the same path with `!`:
`![[30-Resources/img/mappa.png]]`. This is the one form the tools keep correct when
notes move or die; anything else silently rots.

- Every link you write: absolute wiki, no exceptions. A link in another shape you
  happen to find in a note is an **error to fix**, not a form to imitate: fix it
  when you are editing that line anyway, and never add new ones.
- Links that leave the vault — `https://…`, `mailto:` — are not
  vault links: nobody rewrites them, leave them exactly as they are.

## 3. Creating and replacing

`vault_write { path, content, overwrite? }` — `path` relative to the vault root
(`30-Resources/citta/parigi.md`), `content` the **complete** file (UTF-8, ≤ 1 MiB).
Missing folders are created. To replace an existing file: `read` it first, then send
its whole new content with `overwrite: true`; without it the tool answers `exists`
and nothing is written.

Writing a note is usually two writes: the note itself and the index line the policy
requires (its MOC). Finish the job the policy started, same rules, same order.

## 4. Renaming and moving

`vault_move { from, to, overwrite?, links?, dryRun? }` — both paths relative to the
vault root; a folder moves with everything under it. Folders never merge or replace
(`target-is-directory`); `overwrite: true` replaces an existing **file** only.

Link upkeep is the tool's job, not yours: by default (`links: 'auto'`) every
`[[old]]` and `[[old/…]]` in the vault becomes the new path — code fences and
immutable `90-Reference/` material excluded — and the answer lists the notes it
changed and how many links each held. `dryRun: true` shows that plan without
touching the vault and needs no grant; `links: 'report'` moves without rewriting
and lists what still points at the old path; `links: 'off'` does neither. Your
part is deciding when to stop, not how to search:

- `untouchable` — links inside material the policy forbids editing. The tool will
  not fix them and they stay broken: stop, list them, ask the user.
- `failed` — the move is already done and these notes kept stale links: finish what
  can be fixed and say plainly what is still broken.
- The meaning: a renamed project, a MOC line that must be added where the old one
  was dropped, a note whose body says something false once it moves.

## 5. Deleting

`vault_delete { path, recursive?, confirm?, force? }` — no trash: the removal is
immediate and final. The link check runs **inside** the tool, before anything goes:

- Nothing points at the path → a **file** is deleted at once. That is the debris
  case, your own scratch and test notes; report what went.
- `linked` → the answer lists the referrers as `path:line`. Show them and ask how
  to proceed — remove those lines too, keep the note, or move it to `40-Archive/` —
  then finish the whole agreed set. `force: true` only after the user chose to
  accept the broken links.
- Links written inside the deleted path do not count: they go with it. What counts
  is what lives **outside** and would point at nothing.
- A **folder**, or anything under `99-Templates/`, always needs `confirm: true` the
  user gave for that exact path: links point at the notes *inside* a folder, never
  at the folder, so a clean check says nothing about it. A folder also needs
  `recursive: true`, and the answer reports how many entries went with it.
- The vault root itself can never be deleted.

## 6. The Vault Grant

Changing the vault needs the user's **Vault** control, in the composer beside the
permission selector: Read Only never writes; Workspace Write writes only while the
control is on; Full access is always on and the control is locked. The chip shows
the true state, and `vault_info`'s `grant` field mirrors it — trust them over
guessing.

When a vault tool answers `grant-off` or `session-read-only`:

1. Do not retry, and never fall back to `bash`, `write` or `edit` on vault paths —
   they are denied on purpose.
2. Say what is blocked and where to open it: the **Vault** control (Read Only first
   needs the permission raised to Workspace Write).
3. Offer to keep the text in your reply, so nothing is lost while you wait.

Never ask for, or act as if you had, a permission the control does not show.
