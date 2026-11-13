---
name: vault-write
description: Write into the vault with the vault tools: rules first (root POLICY.md, then the target folder’s POLICY.md); create, replace, rename/move with link upkeep, deletion behind a link check; the Vault Grant and what to do when writing is refused.
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

## 2. Creating and replacing

`vault_write { path, content, overwrite? }` — `path` relative to the vault root
(`30-Resources/citta/parigi.md`), `content` the **complete** file (UTF-8, ≤ 1 MiB).
Missing folders are created. To replace an existing file: `read` it first, then send
its whole new content with `overwrite: true`; without it the tool answers `exists`
and nothing is written.

Writing a note is usually two writes: the note itself and the index line the policy
requires (its MOC). Finish the job the policy started, same rules, same order.

## 3. Renaming and moving

`vault_move { from, to, overwrite? }` — both paths relative to the vault root; a
folder moves with everything under it. Folders never merge or replace (`target-is-directory`);
`overwrite: true` replaces an existing **file** at the target only.

Moves do **not** rewrite links, and vault links are written as paths from the root:
an un-updated reference silently points at nothing. So the move is a three-step job:

1. Before moving, grep the vault for what points at the old path — `[[<old path]]`,
   `[[<old path>|…]]` and the bare name, in `*.md` everywhere (reads cost nothing).
2. `vault_move`.
3. Update every referring note and MOC line with `vault_write` (read + `overwrite`),
   and the links **inside** the moved file when the policy writes them relative to
   its old position.

If some references sit where the policy forbids edits (e.g. immutable
`90-Reference/` material), stop before the move, list them, and ask the user how to
proceed. Report every file the move forced you to touch.

## 4. Deleting

`vault_delete { path, recursive?, confirm }` — no trash: the removal is immediate
and final. So links are checked **before** anything disappears, and a note that is
pointed at is never silently orphaned:

1. Grep the vault for links to the path (as in §3).
2. **Any hit → stop.** List the referrers and ask the user how to proceed — remove
   the lines too, clean and keep the note, or move it to `40-Archive/` instead —
   then finish the whole agreed set, referrers included.
3. No hits → ask the user to confirm this exact path (unless they already named it
   in the request) and pass `confirm: true`.
4. Folders need `recursive: true` and a double look: count the contents first
   (glob), check the policy allows deleting that subtree, and confirm with the user
   anyway. The vault root itself can never be deleted.

## 5. The Vault Grant

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
