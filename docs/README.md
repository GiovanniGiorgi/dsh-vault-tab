# The skills of Vault Tab

Four skills ship with the plugin. They are the part that teaching can do: the
tools guarantee *shapes and permissions*, the skills teach *behaviour* — what to
do before writing, what to read first, when to stop and ask.

| skill | direction | file | registered |
| --- | --- | --- | --- |
| `vault-setup` | prepare the folder | `skills/vault-setup.md` | only while **Vault setup skill** is on (Plugins → Vault Tab) |
| `vault-write` | change the vault | `skills/vault-write.md` | always |
| `vault-read` | find things in it | `skills/vault-read.md` | always |
| `vault-git` | commit what was agreed | `skills/vault-git.md` | always |

## Why four, and why this cut

Reading and writing the vault are different jobs with different risks, so they get
different teaching and different gates:

- **`vault-read`** covers a session that is allowed nothing but to look. Its two
  tools bind with the writing ones — the tool slot the agents actually inherit
  lives in that scope — yet they never consult the Grant: `vault_read` answers in
  Read only as well. The skills themselves live in the plain
  `skills` scope and are always registered.
- **`vault-write`** covers mutations, and starts from the one thing the tools
  cannot decide: whether the *user* has opened the Vault Grant for this session.
- **`vault-git`** covers history, which the vault's policy (§10) treats as the
  user's: it teaches the audit → plan → agree → commit order, and the tool makes
  the rest structural — `push`, `reset`, `amend` and `rebase` are not reachable.
- **`vault-setup`** is one-shot by nature. It exists until the vault exists, then
  it costs context in every session for a job already done — so it retires
  itself, and the switch stays available to bring it back.

## The triangle: skill, tool, policy

Nothing here duplicates anything else:

- **the skill** — how an assistant behaves: search before creating, one concept per
  note, the smallest read that answers, when to ask the user.
- **the tool** — the contract and the gate: path confined to the root, the Vault
  Grant, output schemas the core validates, a refusal with a code and a `hint`.
- **`POLICY.md` in the vault** — the rules of *this* vault: schema, naming,
  budgets, what the reference folder is for. It is data inside the vault, seeded
  from `assets/vault-policy.md`, so a vault carries its own conventions and can
  change them without touching code.

Where they overlap, they overlap on purpose: the budgets in §1 of the policy are
the numbers `vault_note` and `vault_write` check, and the skill explains what to do
with the warning. The policy is the single place the numbers are written down.

## How a skill gets registered

`skills/*.md` is read at activation by `registerTextSkill`: BOM and frontmatter are
stripped, the body becomes `content`, and the definition is registered with
`source: 'runtime'` and `provider: '@local/dsh-vault-tab'`. `name`, `description`
and `whenToUse` come from the code, next to each other, so the trigger text is
visible where the skill is wired.

`whenToUse` is what a model reads to decide whether to load the skill — it is the
part worth editing when a skill fires too late or too often. Both always-on skills
end with the same clause for that reason: *even when the user does not say
"vault"*, because a person asking "what do I know about Tokyo" means their second
brain without naming it.

An unreadable skill file does not take the plugin down: it is skipped with a
warning in the log.

## Task → skill → tools

| the user says | skill | tools |
| --- | --- | --- |
| "set up my vault here" / the path is empty | `vault-setup` | `vault_setup` (`inspect`, `create`, `set-root`, `write-policy`, `hide-skill`) |
| "note this", "save it", "rename that", "delete it" | `vault-write` | `vault_note`, `vault_write`, `vault_move`, `vault_delete`, `vault_info` |
| "what do I have about X", "find the note on Y" | `vault-read` | `vault_search`, `vault_read` |
| "commit the vault", "save these changes to git" | `vault-git` | `vault_git` (`status`, `audit`, `commit`) |
| "search it and write down what's missing" | `vault-read`, then `vault-write` | both sets |

## Editing one

1. Edit the Markdown in `skills/`. The prose is the behaviour: write it as
   instructions to the assistant, not as documentation about the plugin.
2. If the change moves *when* the skill applies, edit the matching
   `*_WHEN_TO_USE` / `*_DESCRIPTION` in `index.js`.
3. Run `npm test` in the plugin folder — 111 checks cover the tools the skills
   describe, including the wording of the refusals they tell the model to expect.
4. Reload the plugin row (or restart DSH): skills are read at activation.
5. Keep the skill files symmetrical: ground rules first, then the flow, then the
   contract of the tools they use, then what they refuse. These `docs/` pages
   explain the reasoning; the skill files stay the instructions a model runs.
