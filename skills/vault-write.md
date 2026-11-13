---
name: vault-write
description: Write into the vault with the vault_write tool: rules first (root POLICY.md, then the target folder’s POLICY.md), paths, the Vault Grant, and what to do when writing is refused.
---

# Writing into the vault

One door writes: `vault_write`. The vault's own `POLICY.md` files decide where a note
goes and how it looks — read them **first**, every time. The skill carries the flow;
the vault carries the rules: never restate them from memory, and never let the user
be the one who remembers the policy.

## 1. Rules before the first write

1. `vault_info` — read-only, costs nothing: absolute roots, `hasPolicy`,
   `policyPath`, and this session's `grant` state.
2. Read the root `POLICY.md` (`read` on `policyPath`): naming, structure,
   frontmatter, templates, note placement, MOC upkeep all live there.
3. Read the **target folder's** `POLICY.md` too, when one sits there (check with
   `glob` or `read`). It overrides the root rules inside that folder; root rules
   apply everywhere else.
4. No `POLICY.md` at the root? `vault_info { include: 'default-policy' }` and treat
   that text as binding for this write; tell the user the vault has no policy of its
   own and that **vault-setup** can persist the default at the root.

Writing a note is usually two writes: the note itself and the index line the policy
requires (its MOC). Finish the job the policy started, same rules, same order.

## 2. The write

`vault_write { path, content, overwrite? }` — `path` relative to the vault root
(`30-Resources/citta/parigi.md`), `content` the **complete** file (UTF-8, ≤ 1 MiB).
Missing folders are created. To replace an existing file: `read` it first, then send
its whole new content with `overwrite: true`; without it the tool answers `exists`
and nothing is written.

Renaming, moving, deleting: no vault tool does that — say so plainly and leave it to
the user in Obsidian. Do not improvise with `bash`.

## 3. The Vault Grant

Reading needs nothing, in any permission mode. Writing needs the user's **Vault**
control, in the composer beside the permission selector: Read Only never writes;
Workspace Write writes only while the control is on; Full access is always on and
the control is locked. The chip shows the true state, and `vault_info`'s `grant`
field mirrors it — trust them over guessing.

When `vault_write` answers `grant-off` or `session-read-only`:

1. Do not retry, and never fall back to `bash`, `write` or `edit` on vault paths —
   they are denied on purpose.
2. Say what is blocked and where to open it: the **Vault** control (Read Only first
   needs the permission raised to Workspace Write).
3. Offer to keep the text in your reply, so nothing is lost while you wait.

Never ask for, or act as if you had, a permission the control does not show.
