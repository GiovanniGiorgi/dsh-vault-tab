# Vault Tab

A [DSH](https://npmjs.com/package/@deepseek-ai/dsh) plugin that keeps a notes
folder — a second brain, an Obsidian vault, a documents tree — usable in every
session, regardless of the workspace that session happens to be in.

Three capabilities, one configured root, one bundle:

- **View** — a **Vault** tab in the right sidebar: a file tree of the folder, with
  previews through the built-in Document viewer.
- **Write** — the `vault_note`, `vault_write`, `vault_move`, `vault_delete` tools,
  gated per session by a **Vault Grant** and checked against the vault's own
  policy as they write.
- **Read** — the `vault_search` and `vault_read` tools: grep-first retrieval over
  file names and summaries, with region reads for deep dives. Reading is never
  gated.

## Features

- File tree in the right sidebar, ordered between Workspace files and Terminal
- Click a file to open it in DSH's native preview
- Configurable root with immediate effect; the setting lives in your DSH profile
- Optional separate **write root**: browse one folder, write into another
- Per-session **Vault Grant** in the composer: writing is a decision you make
  where you make the request, not one the model makes for itself
- Writes land through the plugin's Host code, so they work even in a session whose
  own `write`, `edit` and `bash` tools are confined to the session workspace
- Policy lint on every write: budgets, schema, naming, links, index coverage —
  reported as warnings, refused only where the vault would stop being searchable
- Retrieval by metadata (names + summaries), by folder inventory, and full-text
  with numbered lines; `90-Reference/` and `99-Templates/` stay out of search
- `vault-setup`, `vault-write` and `vault-read` skills teach the same conventions
  the tools enforce
- Single small bundle

## Requirements

- DSH with the Plugins panel in the web GUI
- A folder, readable by the user running DSH, to expose

## Installation

1. Place the plugin folder where it will stay: installation references it in
   place, so moving it later requires a reinstall.
2. In the Plugins panel, install the bundle from that folder.
3. The Vault tab appears in the right sidebar.

## First run

With no configuration, the root is `Vault` in the home directory of the user
running DSH. If that folder doesn't exist, the tab says so and shows the path
it looked for.

To expose a different folder: open **Plugins → Vault Tab**, set the
**Vault path** field to an absolute path (`~/` prefixes are accepted and
expand to the home of the user running DSH), and save. The change applies
immediately; press Reload in the tab to re-read the tree.

**Write root** is for the rare case where the tree you browse and the tree you
change are different folders; leave it empty to use the same root for both.

Saving writes a profile override; **Reset** removes it and restores the
default. The package itself contains no configuration.

## The Vault Grant

Reading the vault costs nothing and is never restricted. Writing is separate, and
the switch sits in the composer next to the permission mode, per session:

| Session mode | Vault writing |
| --- | --- |
| Full access | allowed — the session could already reach the folder by other means |
| Read only | refused — the grant is not editable there, and that is the point |
| Workspace write | only while the Vault Grant is on; off by default until you turn it on |

The choice lives in memory, keyed by session: a new session starts from the
plugin's default and forgets the previous ones. `vault_info` reports the current
state, and a refusal says so with the reason (`grant-off`, `session-read-only`)
instead of failing silently.

## Tools

| Tool | What it does |
| --- | --- |
| `vault_search` | retrieval: `{ keywords }` matches names and summaries; no keywords lists a folder (its index, its subfolders); `{ where: "fulltext" }` searches bodies and returns numbered lines. `scope`, `type`, `includeReference`, `limit` narrow it |
| `vault_read` | one file: `from`/`lines` for a region (default 120, max 400), `outline` for headings with their line numbers |
| `vault_note` | a new note from a template: fills the frontmatter, slugs the title, appends one line to the nearest MOC. `folder`, `title`, `type`, `summary`, `body`, `tags`, `name`, `moc` |
| `vault_write` | a file as you wrote it — for indexes, policies, reference imports. `lint: "off"` skips the checks |
| `vault_move` | rename or move, rewriting the `[[…]]` links that pointed at the old path |
| `vault_delete` | removes a file or folder; refuses when notes still link it, until you saw the referrers |
| `vault_info` | facts about the vault: root, write root, policy present, grant state |
| `vault_setup` | creates or adopts the folder this tab lists (see below) |

`/vault-write` in the composer starts the writing flow in one keystroke.

**Warnings are the vault's budgets.** A write returns the checks it failed
(`summary-over-target`, `not-atomic`, `not-indexed`, `broken-link`,
`link-not-canonical`, `path-not-kebab`, `folder-needs-moc`, `moc-has-prose`, …)
so the assistant can fix the note in the same turn. Two things are refused
outright: a summary over 140 characters — past that the index stops being
searchable — and a path outside the root.

## Skills

Each one is explained in [`docs/`](docs/README.md): what it is for, when it fires,
what it teaches, which tool contract and which refusal it drives.

- **`vault-setup`** — creates or adopts the folder. Once the vault exists it
  retires itself; the switch is **Plugins → Vault Tab → Vault setup skill**.
- **`vault-write`** — how to save into the vault: search before creating, prefer
  `vault_note`, honour the budgets, keep MOC lines short, never hand-edit a link
  an index already owns.
- **`vault-read`** — how to answer from the vault: the search loop, keyword
  discipline, inventory vs full-text, reading a region instead of a file, citing
  with the path you read.

## First-time vault

Ask the assistant to set up your vault and it will:

1. Inspect the configured path: missing, empty, or already holding notes.
2. **Missing** — ask where to create it (the question accepts a typed path),
   seed the structure, point the plugin there.
3. **Empty** — ask permission, then seed the structure.
4. **Populated** — judge the folder against the standard structure, with no
   adaptation. An exact match keeps its own `POLICY.md`; if the policy is
   missing, the assistant asks before managing the vault with the plugin's
   policy. Anything else is reported as non-conformant and left untouched.

Seeded structure: `00-Home.md` and `POLICY.md` at the root, `10-Projects/`,
`20-Areas/`, `30-Resources/`, `40-Archive/`, `90-Reference/00-Reference.md`, and
`99-Templates/` with `note.md`, `project.md`, `resource.md`, `log.md`, `moc.md`. There is
no `99-AI/`: the policy lives at the root, next to the home index.

`POLICY.md` carries the rules the notes depend on: frontmatter schema and its
budgets, naming and numeric prefixes, grep-first retrieval, MOC files as
links-only indexes without `source:`, citations restricted to internet links or
`90-Reference/`, the reference folder kept out of search and used for deepening,
templates, per-section policy, and git only on explicit request. Seeding never
overwrites a file that is already there. The tools check the same numbers, so the
policy stays the only place they are written down.

## Security

- The listing is served by a local route, restricted to same-site requests
- Setup writes go through `vault_setup` alone, and each one requires `confirm: true`
  after you agreed to that specific action; system folders and non-empty folders
  are refused outright, and an existing file is never replaced by seeding
- Every requested path is resolved and confined to the configured root;
  relative traversal and symlinks cannot escape it
- Writing needs the Vault Grant; deletion additionally needs your confirmation for
  folders, and refuses while other notes link the target
- Writes are atomic (temp file plus rename) and capped at 1 MiB; binaries are read
  as such, not dumped into context
- Previews follow the session's own file-read permissions
- No credentials, no telemetry

## Uninstall

Disable or remove the bundle in the Plugins panel. A path override you saved
stays in the profile patch; remove it there if you want a clean slate.

## License

See the source repository.
