# `vault-git` — committing the vault

**File:** `skills/vault-git.md` · **always registered** · **gate:** the Vault
Grant for `commit` (status and audit answer anywhere), plus a clean audit token
and `confirm: true`

## What it is for

The vault's `POLICY.md` (§10) says commits happen only on the user's explicit
request and history is never rewritten. A tool that shells out to `git` would
make both rules a matter of good behaviour; `vault_git` makes them structure:
its vocabulary is `status`, `audit`, `commit`, run as fixed argv — `push`,
`reset`, `amend` and `rebase` cannot be asked for at all.

## The flow it teaches

1. `status` — what is dirty, grouped by folder, with the recent messages so the
   plan reads like the vault's own history.
2. `audit` — the serious integrity check. Every changed note is linted against
   the policy and its links verified; any link left pointing at a deleted or
   renamed-away path is found in one pass over the tree. `blocking` refuses; a
   clean audit issues `auditToken`.
3. The plan — unrelated topics become separate commits, each with a brief
   indicative message in the language of the vault, agreed with the user first.
4. `commit` — four locks: the capability switch, `confirm: true`, a token that
   dies with the first edit after the audit, and a re-run of the blocking check
   the token cannot bypass.

## Why the token

An audit that checks one tree while a commit carries another is theatre. The
token hashes HEAD plus every dirty path's status and content bytes, so any edit
after the audit — yours, the user's, Obsidian's — turns the next commit into
`audit-stale` and sends the change back through the audit and, if the plan
changed, back through the user.

## What stays the user's

- Staged changes found in the index (`index-not-clean`): reported, never touched.
- A failed commit mid-plan: what landed **stands**; the tool never undoes.
- Identity, remotes, initialization: the tool never writes `.git/`
  configuration, never invents an author, and never leaves the repository whose
  top level is the vault root.
