# Tests

`npm test` runs the three suites below. Nothing here needs a network, a DSH host,
or a vault: each suite builds its own fixture and throws it away.

| suite | checks | what it covers |
| --- | --- | --- |
| `vault-tools.test.mjs` | 56 | the eight tools, driven as a session drives them: registration, `vault_search` (metadata / inventory / full text), `vault_read`, `vault_note`, `vault_write` and its lint, `vault_delete`, the Vault Grant in all three modes, and every output validated against the schema the tool declares |
| `link-engine.test.mjs` | 14 | the link scan/rewrite engine behind `vault_move` and `vault_delete`: folder prefixes, referrers inside frontmatter, embeds, external referrers reported separately |
| `link-canonical.test.mjs` | 13 | the canonical link form only: root-relative, no alias, case-sensitive — and everything that must never be touched (fenced examples, relative links, URLs, case variants) |

## How they get at the real code

No logic is copied into these files, so a change in `index.js` cannot pass by
testing a stale duplicate of itself:

- **`vault-tools.test.mjs`** imports `index.js` and calls `apply()` with a fake
  `ctx`, capturing what the plugin registers (`tools.register`, `skills.register`,
  `commands.register`) and stubbing `sandboxPolicy.resolve()` to the mode under
  test. The tool objects it gets back are the ones the real session would call, so
  the grant gate, the output schemas and the `render` functions are all in scope.
- **The two link suites** slice the engine out of `index.js` between its doc
  comments and evaluate it with the dependencies injected. If a marker moves, the
  suite fails loudly (`marker not found`) rather than testing nothing.

Every answer from a tool is checked against its declared output schema with a
validator for the subset the core enforces: one `type` per node, `required`,
`additionalProperties: false`, no `undefined`, no `null`, no `NaN` anywhere in the
value. That is what keeps the contract honest when a field is added.

## Environment

| variable | effect |
| --- | --- |
| `VAULT_FIXTURE` | where to build the fixture (default: the system temp dir) |
| `REAL_VAULT` | an existing vault to *read only*: adds one timing check against real material (~300 notes: metadata scan ~30 ms, full text ~50 ms). Skipped when unset |

The fixtures are regenerated from scratch on every run, so a failed run can be
re-run without cleaning anything. The plugin's own `assets/` seed them: the same
files a real `vault_setup` would write.

## What is deliberately not here

The tools that work on *this machine's* data live outside the repo
(`.scratch/vaultread/`): `adapt.mjs` ports a slice of a real vault into the new
structure, `rebuild.mjs` rebuilds a vault through the real tools, `validate.mjs`
runs the lint over hundreds of files and measures retrieval, `e2e.mjs` does one
whole find → read → create → delete round trip. They read someone's actual notes,
so they belong next to those notes, not in a bundle.
