# `vault-setup` — preparing the folder

**File:** `skills/vault-setup.md` · **one-shot** · **gate:** the
**Vault setup skill** switch under Plugins → Vault Tab (`skillSetup`)

## What it is for

It makes the folder this plugin lists into a vault: a missing path becomes a real
folder with the standard structure, an existing folder is judged against that
standard and adopted or left alone. Nothing else in the plugin creates
directories, writes `POLICY.md`, or moves the configured root.

It fires when the vault path is missing, empty or not yet trusted, and when the
user asks to set up, initialise, adopt, move or re-check a folder.

## What it teaches

1. **Look first.** `vault_setup { action: 'inspect' }` before proposing anything:
   missing, empty, or holding notes — and whether the shape already matches.
2. **Missing** → ask *where* (the question takes a typed path), seed there, point
   the plugin at it. Never invent a location.
3. **Empty** → ask permission, then seed.
4. **Populated** → judge, do not adapt. An exact match keeps its own `POLICY.md`;
   a folder without a policy gets a *question* before the plugin's policy manages
   it; anything non-conformant is reported and left untouched, with at most one
   alternative folder offered in chat.
5. **Close out** → offer to retire the skill. It exists only for setup, and it
   costs context in every session until it is switched off.

Two rules hold the whole flow honest: **one attempt per run** — if an answer does
not produce a usable folder, say so and stop, leaving the tab reporting "folder
not found" rather than half-building something — and **seeding never overwrites**
a file that is already there.

## The contract it drives

`vault_setup` takes `action` + `path` + `confirm`:

| action | what it does | needs |
| --- | --- | --- |
| `inspect` | read-only facts about a root (an optional path judges a candidate without moving the plugin root) | nothing |
| `create` | seed the PARA structure at the path (also moves the plugin root there) | `confirm: true` |
| `set-root` | point the plugin at an existing absolute path | `confirm: true` |
| `write-policy` | write `POLICY.md` at the root; an existing one is never replaced | `confirm: true` |
| `hide-skill` | retire this skill (`skillSetup: false`) | — |

`confirm` is not a formality: it means the user agreed to *that* path and *that*
action. System folders and non-empty folders are refused outright.

Seeded structure: `00-Home.md` and `POLICY.md` at the root, `10-Projects/`,
`20-Areas/`, `30-Resources/`, `40-Archive/`, `90-Reference/00-Reference.md`,
`99-Templates/` with `note`, `project`, `resource`, `log`, `moc`. There is no
`99-AI/`: the policy is a note at the root, next to the home index, so it reads
like the rest of the vault and travels with it.

## Why it works in every permission mode

The writing is done by the plugin's Host code, not by the session: the session's
own `write`, `edit` and `bash` stay confined to the session workspace and are
refused on vault paths outside Full access. That is the same mechanism that lets a
Read-only session read the vault through `vault_read` — the tools are the plugin's,
the sandbox is the session's.

## Switching it off, and back on

`skillSetup` is a volatile field, so the toggle is live: saving it never restarts
the row, and the registration follows the switch. If a future loader ever dropped
that live event, the flag would still apply at the next activation, and the
`hide-skill` action works regardless — the skill can always retire itself.
Turning it back on brings the flow up again for a later re-check or to move the
vault elsewhere.
