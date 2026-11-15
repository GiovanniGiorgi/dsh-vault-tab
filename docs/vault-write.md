# `vault-write` — changing the vault

**File:** `skills/vault-write.md` · **always registered** · **gate:** the per-session
**Vault Grant** (the tools), plus the user's confirmation for folders and deletions

## What it is for

Everything that alters the vault: a note saved, a MOC line added, a file renamed,
a folder deleted. It is the counterpart of `vault-read`, and the two overlap on
purpose — a good answer often ends by storing what was missing.

It fires whenever something in the vault should change, *even when the user does
not say "vault"*, because people say "note this" and mean their second brain.

## What it teaches, in the order it teaches it

1. **Rules before the first change** — read the root `POLICY.md`, then the target
   folder's `POLICY.md` if it has one. Section rules live in the section; the root
   file will not contain them.
2. **One link form** — `[[path/from/root]]`, no `.md`, no short names, no links to
   folders outside the vault.
3. **Creating** — search first (a duplicate note is the answer that gets worse with
   time), then `vault_note` for a note and `vault_write` for anything that is not a
   note.
4. **The warnings are the vault's budgets** — read them, finish them in the same change.
5. **Renaming and moving** — `vault_move` rewrites the links that pointed at the old
   path; do not hand-edit an index the tool owns.
6. **Deleting** — `vault_delete` checks who links the target; show the referrers.
7. **The Vault Grant** — what to do when writing is refused.

## The tools it covers

| tool | job | notes |
| --- | --- | --- |
| `vault_note` | a new note, indexed in one call | builds the `kebab-case` name from the title, fills the vault's `99-Templates/<type>.md` (falls back to the plugin's asset), requires a `summary`, appends one line to the **nearest** MOC |
| `vault_write` | a file as given | for indexes, policies, reference imports; `lint: 'off'` for bulk import |
| `vault_move` | rename/move + link upkeep | `links: 'auto' \| 'report' \| 'off'`, `dryRun` to see the plan |
| `vault_delete` | remove, behind a link check | `force` only after the user saw the referrers; folders need `confirm` |
| `vault_info` | state of things | root, write root, policy present, grant state |

## Budgets the tools check

Measured on a real 308-file vault before choosing hard versus soft — a refusal
that would fire on existing material is a bug, not a standard:

| rule | found in the real vault | behaviour |
| --- | --- | --- |
| `summary` ≤ 140 | 0 files | **refused** (`policy-violation`): past that the index stops being searchable |
| `summary` ≤ 100 target | 74 files | warning `summary-over-target` |
| one concept, ~80 lines | 23 files | warning `not-atomic` |
| no emoji in names/keys | 1 | warning `emoji-in-key` |
| every link resolves | 7 broken (6 inside reference, e.g. `[[nodiscard]]`) | warning `broken-link` — fenced code and inline code are skipped |
| every note in a MOC | 199/201 | warning `not-indexed`, plus `folder-needs-moc` when a section outgrew ~3 notes |

`90-Reference/` and `99-Templates/` are exempt from the note schema — they are not
notes — and so is any `POLICY.md`, including a section's.

## The Vault Grant, and the honest failure

Writing is a per-session decision taken in the composer, not by the model:

- **Full access** — allowed (the session could reach the folder anyway)
- **Read only** — refused, and the switch is not editable there
- **Workspace write** — only while the grant is on; off by default

A refusal carries a code (`grant-off`, `session-read-only`) and a hint addressed to
the user. The skill's instruction is to **report it and stop**, never to retry or
fall back to `bash`/`write`: a sandboxed shell cannot write there, and a workaround
would be the model granting itself. `/vault-write on|off|status` exists for the
human; the model does not call it.

Git stays out of it: work ends in the working tree, a commit happens only when the
user explicitly asks.

## Editing

The prose lives in `skills/vault-write.md`; the trigger text in `NOTE_SKILL_DESCRIPTION`
and `NOTE_SKILL_WHEN_TO_USE` in `index.js`. When a budget number changes, change it
in the code (`SUMMARY_TARGET`, `SUMMARY_MAX`, `NOTE_LINE_TARGET`) and in the vault's
`POLICY.md` — the policy is where the numbers belong, the code is where they bite.
