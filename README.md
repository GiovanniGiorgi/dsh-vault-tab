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
- Read-only: listing is confined to the configured root, nothing is written
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

## Security

- The listing is served by a local route, restricted to same-site requests
- Every requested path is resolved and confined to the configured root;
  relative traversal and symlinks cannot escape it
- Previews follow the session's own file-read permissions
- No credentials, no telemetry

## Uninstall

Disable or remove the bundle in the Plugins panel. A path override you saved
stays in the profile patch; remove it there if you want a clean slate.

## License

See the source repository.
