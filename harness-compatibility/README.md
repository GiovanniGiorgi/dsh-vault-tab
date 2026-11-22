# harness-compatibility

Translations of this plugin's workflow for **other agent harnesses**.

The plugin's own skills (`skills/`) are written for DeepSeek's harness: they
drive the `vault_*` tools and lean on the Vault Grant. The workflow they
enforce — retrieval discipline, integrity-checked writing, audited commits —
is not harness-specific, though. Each subfolder here carries the same effect
for a different harness, with plain file tools and **no permission layer**:
the safety moves from "gates on how you write" to "checks on what remains
true".

## Conventions for a translation

- One subfolder per harness (`pi/`, `claude-code/`, `codex/`, …), following
  the [Agent Skills](https://agentskills.io) layout: a directory per skill
  with a `SKILL.md`, helper scripts under `scripts/`.
- Skills must be **self-contained and ready to use**: no provenance headers,
  no references back to this repository. A folder copied into a harness's
  skills directory must work on its own.
- Never hardcode a vault path or a harness-only tool. The vault root resolves
  from user → environment → config file → asking; the vault's own
  `POLICY.md` stays the authority for budgets and conventions — the skills
  carry the flow and expose flags when numbers differ.
- Integrity lives in a checker script, not in trust: broken links, dangling
  referrers and budget violations are BLOCKING; indexing and naming are
  warnings. If the harness cannot share a script between two skills (each
  skill installs alone), ship a twin copy and mark it *keep in sync*.
- A translation that drifts from the plugin's semantics is a bug on both
  sides: when `skills/*.md` or the lint budgets change, review these folders
  in the same pass.

| Folder | Harness | Skills |
| --- | --- | --- |
| `pi/` | [pi](https://github.com/badlogic/pi) (any Agent Skills harness) | `vault-read`, `vault-write`, `vault-git` |
