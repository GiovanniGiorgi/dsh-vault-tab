---
name: vault-note
description: Save a note into the vault folder with the vault_write tool of the Vault Tab plugin, under the Vault Grant the user decides in the composer.
whenToUse: Use when the user asks to save, jot down or file something in the vault, outside the current workspace.
---

# Saving into the vault

The vault is a folder of the user's own, configured in **Plugins → Vault Tab**. It is
usually **not** the session workspace, so the native `write`, `edit` and `bash` tools
cannot touch it under Workspace Write.

## What to use

- **Reading** needs nothing: `read`, `grep` and `glob` see the vault in every permission
  mode. Read before you rewrite.
- **Writing** has exactly one door: `vault_write(path, content)`, with `path` relative to
  the vault root. Overwriting an existing file also needs `overwrite: true`, and only
  after you have read the file and can send its complete new content.

## The Vault Grant

Whether `vault_write` accepts anything is the user's decision, taken on the **Vault**
control in the composer, beside the permission selector:

- **Read Only** → nothing is written anywhere, vault included.
- **Workspace Write** → the vault is writable only while the user holds the control on.
- **Full access** → the vault is already writable; the control shows on and is locked.

So when `vault_write` answers `grant-off` or `session-read-only`:

1. **Do not retry**, and do not try `bash`, `write` or `edit` on that path — they are
   denied on purpose and repeating them only wastes the turn.
2. Tell the user what is blocked and where to open it: the **Vault** control next to the
   permission selector (and Read Only needs the permission raised to Workspace Write
   first).
3. Offer to keep the text in your reply, so nothing is lost while you wait.

Never ask for, or act as if you had, a permission the control does not show.
