---
name: vault-git
description: Commit the vault git working tree with the vault_git tool: an integrity audit first (valid links, policy budgets), commits only on the user’s explicit word, unrelated topics split into separate commits with brief indicative messages, never a push or a rewrite.
---

# Committing the vault

The vault's `POLICY.md` (§10) decides: work ends in the working tree, a commit
happens **only when the user explicitly asks**, and nothing is repaired by
rewriting history. "Aggiorna la nota" is not a commit request, and finishing a
task is not one either. When the user does ask, `vault_git` is the only door:
its vocabulary is `status`, `audit`, `commit` — `push`, `reset`, `amend` and
`rebase` do not exist here, so never reach for `bash` to add them.

## 1. The flow, every time

1. **`vault_git { action: 'status' }`** — no Grant needed: what is dirty, in
   which folders, and the recent messages, which show the language and shape
   the vault's history uses. Read the list before planning: leftover files from
   someone else's work belong to the conversation, not silently to a commit.
2. **`vault_git { action: 'audit' }`** — the serious check: every changed note
   is linted against the policy and its links verified, and any link left
   pointing at a path the change deleted or renamed away is found. A link that
   still resolves does not count: when `X.md` dies and the folder `X/` rises in
   its place, `[[X/figlio]]` is a note that exists and `[[X]]` a folder — the
   audit blocks the split left half-done, never the one that finished.
   - `blocking` must reach zero before anything else: fix the broken links, the
     oversized summaries, the forgotten referrers — in the vault, with the
     `vault_*` tools — and audit again. A token is issued only by a passing tree.
   - `warnings` do not block, but they are the policy speaking: fix what belongs
     to this change and report the rest to the user honestly.
3. **Propose the plan** — group the dirty files by *topic*, not just by folder:
   two unrelated changes are two commits, each with a brief indicative message
   in the language of the vault, following the style of `recentCommits`. Show
   the user the split and the messages.
4. **`vault_git { action: 'commit', commits: [...], auditToken, confirm: true }`**
   — only after the user agreed to *this* plan. Commits apply in order, each
   staging exactly its paths; anything the plan left out is reported as
   `leftUncommitted` and stays in the working tree. Say so plainly.

## 2. The token is the deal

`auditToken` proves the audit saw the exact bytes about to be committed. The
first edit after an audit kills it (`audit-stale`): audit again — and when the
fix changed what the user approved, re-propose, do not silently commit a
different tree. An edit made while you wait is the tree disagreeing with your
plan; that is information, not an obstacle.

Commit re-runs the blocking check itself: a token is never a way to push a
broken link into history.

## 3. What splits a commit

One commit says one thing. A new project note, a trip fix and a policy edit are
three topics even when they share a folder. The `groups` in `status` are a
starting point, not the answer: you know what the change *means*, and the
message should read like the history — `docs(android): ...`, `fix(vault): ...`.

Leave nothing half-committed: if a MOC line and its note belong to one topic,
they belong to one commit.

## 4. When it is refused

- `grant-off` / `session-read-only` — commit is a mutation: same Vault Grant as
  writing, same handling as the `vault-write` skill teaches. `status` and
  `audit` still answer everywhere.
- `index-not-clean` — someone already staged things, and the refusal carries
  the evidence to explain it: `stagedPaths` (what unstaging would release) and
  `stagedDifferFromWorktree` (the staged snapshots that differ from the files:
  what unstaging would **discard** — usually an intermediate version the disk
  has already superseded, sometimes content that lives only in the index).
  Show both lists and let the user decide. Unstaging — `git restore --staged .`
  or a mixed `git reset` without arguments: files and history untouched either
  way — is the user's command, never yours and never the tool's.
- `git-identity-missing` — ask the user to set `user.name` / `user.email`;
  inventing an identity is not an option.
- `commit-failed` — what was already made **stands**: never undo it, report
  exactly where it stopped and wait.
- `git-disabled` — the capability is off in Plugins → Vault Tab; tell the user,
  do not work around it.

## 5. The vault health, beyond the change

`audit { scope: 'vault' }` link-checks the whole tree and reports the
pre-existing rot — never blocking, because older notes are not this change's
fault, but worth surfacing when the user asks how the vault is doing, or before
a long editing session starts from a broken base.
