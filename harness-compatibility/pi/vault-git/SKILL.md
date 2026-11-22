---
name: vault-git
description: Commit a markdown vault's git working tree — integrity audit first (no broken or dangling links, budgets respected), commits only on the user's explicit word, unrelated topics split into separate commits with brief indicative messages in the vault's own style, never a push or a history rewrite. Use when the user asks to commit, checkpoint or save the vault's history.
---

# Committing the vault

The vault's `POLICY.md` (its git section) decides: work ends in the working
tree, a commit happens **only when the user explicitly asks**, and nothing is
repaired by rewriting history. "Aggiorna la nota" is not a commit request,
and finishing a task is not one either.

Plain `git` via `bash` is the tool here — no wrapper, no permission layer.
The safety is not in the commands but in the order: **audit → propose →
commit**. And never reach for `push`, `reset --hard`, `amend` or `rebase` to
repair your own work: report and wait. If the user themself asks to push,
that is a separate explicit instruction, outside this skill.

## Locate the vault

Path named by the user → `$VAULT_ROOT` / `$VAULT_PATH` → `.vault-root` in the
working directory or ancestors → `~/.config/vault-skills/root` → ask (and
offer to persist it there). Read the vault's `POLICY.md` git section if it
exists; it overrides this skill.

## 1. The flow, every time

1. **Look.**
   ```bash
   git -C "$ROOT" status --porcelain=v1
   git -C "$ROOT" log --oneline -10
   ```
   The log shows the language and shape the vault's history uses. Read the
   status before planning: leftover files from someone else's work belong to
   the conversation, not silently to a commit. If the index already holds
   staged changes you did not stage, stop and show them (see §4).
2. **Audit** with the checker (it lives in this skill's `scripts/`):
   ```bash
   scripts/vault_check.py --root "$ROOT" \
     --changed <added+modified+new-paths...> --removed <deleted+old-rename-paths...>
   ```
   Derive the lists from `git status --porcelain` (a rename contributes its
   old path to `--removed` and its new path to `--changed`). Add `--all` to
   surface pre-existing rot — never blocking, older notes are not this
   change's fault, but worth reporting when the user asks how the vault is
   doing.
   - **BLOCKING must reach zero before anything else**: fix broken and
     dangling links, oversized summaries, forgotten referrers — in the vault
     — then audit again.
   - Warnings are the policy speaking: fix what belongs to this change,
     report the rest honestly.
3. **Propose the plan.** Group the dirty files by *topic*, not by folder: a
   new project note, a trip fix and a policy edit are three commits even when
   they share a folder. One brief indicative message per commit, in the
   language of the vault, reading like its history
   (`docs(android): …`, `fix(vault): …`). Show the user the split and the
   messages, and wait for the word.
4. **Commit** — only after the user agreed to *this* plan. Apply the groups
   in order, each staging exactly its paths:
   ```bash
   git -C "$ROOT" add -- <paths of group 1> && git -C "$ROOT" commit -m "<msg 1>"
   ```
   Anything the plan left out stays in the working tree: say so plainly
   (`left uncommitted: …`).

## 2. The tree must not move under you

The audit is a promise about exact bytes. Any edit after the audit voids it:
re-audit, and if the fix changed what the user approved (a file joined a
different group, a new file appeared), **re-propose** — never silently commit
a different tree than the one agreed. An edit made while you wait is the
vault disagreeing with your plan; that is information, not an obstacle.

Leave nothing half-committed: a note and its MOC line belong to one topic, so
they belong to one commit.

## 3. What splits a commit

One commit says one thing. The folders are a starting point, not the answer:
you know what the change *means*. Two unrelated edits in the same folder are
two commits; a note, its index line and the link it justifies in a neighbour
are one.

## 4. When to stop and ask

- **Pre-staged changes** (`git status` shows staged entries you did not put
  there): show what is staged (`git diff --cached --stat`) and what unstaging
  would discard. Unstaging is the user's command, never yours on your own
  authority.
- **Missing git identity** (commit fails with `user.email`/`user.name`): ask
  the user to set them; inventing an identity is not an option.
- **A commit in the series fails**: what was already made stands — never undo
  it. Report exactly where it stopped and wait.
- **The vault is not a git repo**: say so, ask whether to `git init`
  (and with what `.gitignore`); do not init silently.

## 5. Vault health, beyond the change

`scripts/vault_check.py --root "$ROOT" --all` link-checks the whole tree and
reports the pre-existing rot. Never blocking, always worth surfacing when the
user asks how the vault is doing, or before a long editing session starts
from a broken base.
