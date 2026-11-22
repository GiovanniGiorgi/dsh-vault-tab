# Vault skills for pi

Harness-neutral versions of the vault workflow skills, for [pi](https://github.com/badlogic/pi)
or any Agent Skills harness. No custom tools, no permission layer: the vault
is edited with the plain file tools, and every change closes with an
integrity check instead of opening with a permission.

| Skill | Keeps | Drops |
| --- | --- | --- |
| `vault-read` | grep-first on names + `summary:`, minimal context, reference folders out of search | grant checks, tool-only access |
| `vault-write` | search-before-create, template + summary + MOC line in one change, link upkeep on moves, link check before deletes, reference immutability | any constraint on *how* you edit |
| `vault-git` | audit-before-commit, topic-split commits in the vault's language, commit only on the user's explicit word, never push or rewrite | the audit token — replaced by "re-audit if the tree moved" |

Integrity is enforced by `vault_check.py` (twin copies in `vault-write/` and
`vault-git/` — keep them in sync): `broken-link`, `dangling-link` and
`summary-over-max` are **BLOCKING**; indexing and naming issues are warnings.
The vault's own `POLICY.md` stays the authority — different budgets → pass
`--max-summary`, `--skip`, etc.

## Configuring the vault path

The skills never hardcode a path. Resolution order (first match wins):

1. a path the user names in the conversation
2. env: `VAULT_ROOT` or `VAULT_PATH`
3. a `.vault-root` file (one path per line, `~` allowed) in the working
   directory or any ancestor — good for per-project vaults
4. `~/.config/vault-skills/root` — good for one global vault:
   ```bash
   mkdir -p ~/.config/vault-skills && echo '~/Vaults/mio-vault' > ~/.config/vault-skills/root
   ```
5. otherwise the skills ask, and offer to persist the answer at step 4.

## Installing

```bash
# globally, for every session
cp -r vault-read vault-write vault-git ~/.pi/agent/skills/
# or per-project: copy them into <project>/.pi/skills/
# or point the harness settings at this folder instead of copying:
#   ~/.pi/settings.json → { "skills": ["<this-folder>"] }
```

## Checking by hand

```bash
python3 vault-write/scripts/vault_check.py --root ~/Vaults/mio-vault --all
```

`--all` link-checks the whole tree (pre-existing rot reports as warnings,
never blocking). `--changed` / `--removed` take paths relative to the vault
root and are what the write and git flows run after every change.
