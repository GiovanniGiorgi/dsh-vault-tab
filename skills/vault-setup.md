# Vault setup

Set up (or adopt) the folder that the Vault Tab plugin exposes. Do this once per
vault, then leave this skill out of the way. One attempt per run: when an answer
does not produce a usable folder, say so and stop — nothing is written and the
Vault tab keeps reporting "folder not found".

## Ground rules

- Every filesystem operation goes through the `vault_setup` tool. The plugin's
  Host code writes the vault folder; the session's own `write`, `edit` and `bash`
  are confined to the session workspace and **will be denied** on vault paths
  unless the session runs with Full access. Do not try them to "check".
- Never create, rename or delete anything outside the folder the tool reports as
  `root`.
- Never run `git add`/`git commit` as part of setup.
- Ask the user before anything is written. Reading is free; writing needs a yes.
- Ask conversationally: pose the question in your reply, end the turn, and read
  the answer from the next chat message. No question UI, no popups, no guessing
  an answer that has not arrived.
- Never invent a path. Use the `root` a tool result reported or a path the user
  gave. An answer is usable only when it holds an absolute path (`~` allowed);
  a missing or empty answer is a refusal, not a default.

## Standard structure

There is no adaptation: a folder either matches this or it is not a vault home.

- six top-level folders: `10-Projects`, `20-Areas`, `30-Resources`,
  `40-Archive`, `90-Reference`, `99-Templates`
- a `00-Home.md` index at the root, with `POLICY.md` next to it
- no other top-level folders

`inspect` reports this verdict as `exact`; trust it over impressions.

## Tool contract

`vault_setup { action, path?, confirm? }`

| action | returns | notes |
| --- | --- | --- |
| `inspect` | `root`, `state`, `dirs`, `files`, `hasHome`, `hasPolicy`, `sections`, `otherDirs`, `markdownNotes`, `exact`, `notes[]` | reads only, safe to repeat; an optional `path` judges a candidate folder without touching the plugin's root |
| `create` | `root`, `createdDirs[]`, `createdFiles[]`, `skipped[]`, `completed`, `rootChanged`, `rootPersisted` | needs `confirm: true`; optional `path` also moves the plugin root there; on a folder that already has a home index or a policy it only adds what is missing (`completed: true`) |
| `set-root` | `root`, `changed`, `persisted` | needs `confirm: true`; absolute path |
| `write-policy` | `path`, `written`, `existed` | needs `confirm: true`; an existing `POLICY.md` is never replaced (`policy-exists`) |
| `hide-skill` | `hidden`, `persisted` | retires this skill; see step 5 |

A failed call returns `{ error: '<code>' }`. Relay the code, do not retry with a
different path.

## Flow

### 1. Look first

Call `vault_setup { action: 'inspect' }` before saying anything about the vault.
Branch on `state`:

- `missing` → step 2
- `empty` → step 3
- `populated` → step 4

### 2. No folder yet

Tell the user the configured path does not exist, then **ask in your reply where
to create it**. Name the inspected `root` as the default choice and say any
absolute path works (`~` allowed). If no usable absolute path comes back, stop:
say nothing was created, that the Vault tab will show "folder not found", and
that a folder can be chosen later in **Plugins → Vault Tab** and setup run
again. With a usable path: `vault_setup { action: 'create', path: '<chosen>',
confirm: true }` — the folder the user named is the consent to create it. Report
`createdDirs`, `createdFiles` and whether the root was persisted
(`rootPersisted: false` means the path is live now but not saved in the profile —
say so). Step 5.

### 3. Folder exists, empty

State the path and that it is empty, ask permission to populate it, then
`vault_setup { action: 'create', confirm: true }`. Existing files are never
overwritten: they come back in `skipped[]`, and a re-run only adds what a
previous attempt left missing. A `folder-not-empty` answer means the folder
gained content meanwhile — treat it as step 4. Declining ends the setup with
nothing written.

### 4. Folder exists with content

Branch on `exact` and `hasPolicy` from the inspect result. A folder that is not
exact is left untouched, whatever the reason.

**`exact: true`, `hasPolicy: true`** — say you found an already populated vault
and that its own `POLICY.md` is kept. Nothing is written. Step 5.

**`exact: true`, `hasPolicy: false`** — say you found an already populated vault
and ask: manage it with the plugin's policy? Yes → `vault_setup { action:
'write-policy', confirm: true }`, report, step 5. No or unclear → nothing is
written; say it is better to point the plugin at a new vault folder, name
**Plugins → Vault Tab** as where to do it, and stop.

**`exact: false`** — say plainly that the folder is not a conformant vault,
naming the evidence in `notes` (missing standard folders, extra top-level
folders, no index). Do not create files and do not proceed "with adaptations".
Then ask exactly once, in chat, for another folder. No usable answer → stop,
pointing to **Plugins → Vault Tab**.
With an answer, judge it once — `vault_setup { action: 'inspect', path:
'<chosen>' }` — and apply this step's branches to that verdict, where:

- `missing` / `empty` → `vault_setup { action: 'create', path: '<chosen>',
  confirm: true }` (the question was the consent; the plugin root moves with
  the create)
- `exact: true` → the two policy branches above; when the folder is adopted,
  finish with `vault_setup { action: 'set-root', path: '<chosen>',
  confirm: true }` so the plugin points at it
- `exact: false` again → stop with nothing written. No second offer, no loops.

### 5. Close out

Report the root, what was created or kept, and that the Vault tab shows the tree
now (Reload in the tab if it was open). Only after something was created or
adopted, offer to retire this skill: it exists only for setup, and keeping it
loaded costs context in every future session. Ask first. On yes,
`vault_setup { action: 'hide-skill' }` and report `persisted` (`false` means it
is gone from this process but the toggle in **Plugins → Vault Tab** still shows
it as enabled — tell the user to switch it off there to make it permanent).
Declining is fine: the same toggle can be used any time later, and re-enabling
it brings this flow back for a later re-check or to move the vault elsewhere.
