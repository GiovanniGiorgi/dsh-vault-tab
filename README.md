# Vault Tab

A [DSH](https://npmjs.com/package/@deepseek-ai/dsh) plugin that adds a **Vault**
tab to the right sidebar: a read-only file tree of a folder of your choice,
with previews through the built-in Document viewer.

It keeps a notes folder — a second brain, an Obsidian vault, a documents tree —
available in every session, regardless of the workspace the session is using.

## Features

- File tree in the right sidebar, ordered between Workspace files and Terminal
- Click a file to open it in DSH's native preview
- Configurable root with immediate effect; the setting lives in your DSH profile
- Read-only browsing: the listing is confined to the configured root and never writes
- Optional **vault setup**: create or adopt the folder from a chat, then switch it off
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

Saving writes a profile override; **Reset** removes it and restores the
default. The package itself contains no configuration.

## Vault setup skill

The bundle also registers a `vault-setup` skill and a `vault_setup` tool, so an
assistant can prepare the folder this tab lists. It works in every permission
mode, Read Only included, because the plugin's Host code does the writing: the
session's own `write`, `edit` and `bash` tools stay confined to the session
workspace and are refused on vault paths outside Full access.

Ask the assistant to set up your vault and it will:

1. Inspect the configured path: missing, empty, or already holding notes.
2. **Missing** — ask where to create it (the question accepts a typed path),
   seed the structure, point the plugin there.
3. **Empty** — ask permission, then seed the structure.
4. **Populated** — judge the folder against the standard structure, with no
   adaptation. An exact match keeps its own `POLICY.md`; if the policy is
   missing, the assistant asks before managing the vault with the plugin's
   policy. Anything else is reported as non-conformant and left untouched: one
   alternative folder may be offered in chat, otherwise the path is set under
   **Plugins → Vault Tab**. If no usable folder comes out of it, the assistant
   stops and nothing is created.

Seeded structure: `00-Home.md` and `POLICY.md` at the root, `10-Projects/`,
`20-Areas/`, `30-Resources/`, `40-Archive/`, `90-Reference/00-Reference.md`, and
`99-Templates/` with `note.md`, `project.md`, `resource.md`, `log.md`, `moc.md`. There is
no `99-AI/`: the policy lives at the root, next to the home index.

`POLICY.md` carries the rules the notes depend on: frontmatter schema, naming and
numeric prefixes, grep-first retrieval, MOC files as links-only indexes without
`source:`, citations restricted to internet links or `90-Reference/`, the
reference folder kept out of search and used for deepening, templates, per-section
policy, and git only on explicit request. Seeding never overwrites a file that is
already there.

Once the vault is ready the skill offers to retire itself: it exists only for
setup and costs context in every session. The same switch is available any time
under **Plugins → Vault Tab → Vault setup skill**. The flag is live: toggling it
saves without restarting anything, and new sessions pick the state up
immediately. Turning it back on brings the setup flow up again for a later
re-check or to move the vault elsewhere.

## Security

- The listing is served by a local route, restricted to same-site requests
- Setup writes go through `vault_setup` alone, and each one requires `confirm: true`
  after you agreed to that specific action; system folders and non-empty folders
  are refused outright, and an existing file is never replaced by seeding
- Every requested path is resolved and confined to the configured root;
  relative traversal and symlinks cannot escape it
- Previews follow the session's own file-read permissions
- No credentials, no telemetry

## Uninstall

Disable or remove the bundle in the Plugins panel. A path override you saved
stays in the profile patch; remove it there if you want a clean slate.

## License

See the source repository.
