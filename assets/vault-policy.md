---
type: policy
status: active
tags: [policy]
created: {{DATE}}
summary: "This vault's rules: PARA structure, schema budgets, naming, MOC links-only, source citations, reference, templates, section policies, git"
---

# Vault policy

The rules of **this** vault: structure, schema, budgets, conventions. The
`vault_*` tools enforce what can be enforced (a crossed rule comes back as a
warning or a refusal); the skills `vault-read`, `vault-write` and `vault-setup`
teach how to work with them. The numbers below are the single place they are
written: change one without changing the tools and the vault splits in two.

Structure: six numbered folders (`10-Projects`, `20-Areas`, `30-Resources`,
`40-Archive`, `90-Reference`, `99-Templates`), the `00-Home.md` index and this
file at the root. Folder-specific rules live inside the folder (§9), never here.

## 1. Frontmatter schema (required on every note)

```yaml
---
type: note | project | area | resource | log | moc | template
status: active | done | archived
tags: []
created: YYYY-MM-DD
updated: YYYY-MM-DD # add only after a substantial change
summary: "one line: target <=100 chars, max 140 for dense notes"
source: # optional provenance: URL(s), a [[90-Reference/…]] link, or a short free-text origin (§6)
---
```

`summary` is the retrieval key — `vault_search` reads it and nothing of the
body: it must hold the words someone would search for. Target **100**
characters, **140** for dense notes only; past it a write is refused, past 100
it comes back as a warning. Richness belongs in the MOC annotation (§5). After
a substantial change update `status` and `summary`: a stale key hides the note.

## 2. Naming

Numeric prefixes order folders by reading frequency; `00-` keeps indexes first.

- Content folders: `kebab-case`, like files, CJK letters welcome
  (`trips`, `ai-implementation`); the numbered roots keep their names
- Files: the name follows the title — Latin folds to `kebab-case.md`
  (`Second Brain PARA` → `second-brain-para.md`), kanji and kana keep their own
  characters; `00-Home.md` is the one canonical name with a capital
- MOC indexes: `00-<section>.md` inside the folder they index
- Dated notes: `YYYY-MM-DD-topic.md`
- No emoji in names, keys or summaries: retrieval is textual
- One note = one concept, **~80 lines**: past that, split and link — material
  that cannot be atomic is not a note and goes to `90-Reference/` (§7)

## 3. Retrieval (grep-first, minimal context)

What a search of this vault may look at:

- **File names and the `summary:` frontmatter only**; bodies are read after a
  note is picked, a region at a time. Accents and case are folded (`citta`
  finds `città`), spelling is not
- Markdown notes only, **excluding `90-Reference/` (§7) and `99-Templates/` (§8)**
- No match after synonyms, singulars, one keyword at a time → the note does not
  exist: say so, then store what answers (§4)

## 4. Saving

- Facts and decisions → `10-Projects/`, or a dated log note in the owning area
- Durable knowledge → `30-Resources/`
- Long-lived responsibilities and collections → `20-Areas/`
- Dead material → `40-Archive/`, keeping its internal structure
- Every new note: complete frontmatter (§1) + **one line in the MOC that owns
  the folder** (§5) — `vault_note` writes both

## 5. MOC files: links only

A MOC (`00-Home.md`, every `00-<section>.md`) is an index, not a note.

- List items only: a wiki link plus a short annotation. No prose, no images, no code
- **No `source:`** — the one exception is a source covering the whole folder
  the MOC indexes (its reference corpus)
- Home links section MOCs only, never single notes; a section past **~3 notes**
  gets its own `00-<section>.md` and the Home entry points at that
- Every note is reachable from an index: add the line when a note arrives, fix
  it when one moves or dies. A note no MOC links is a file, not knowledge

## 6. Links and source

**One internal link form:** `[[path/from/the/vault/root]]` — no `.md`, no anchor, no short name; embeds repeat it with `!`. It is the shape the
tools keep correct across moves. Links leaving the vault (`https://…`) are
plain Markdown: nothing rewrites them. No link may resolve to nothing — create
the target in the same change, or drop it.

**`source:` — where the note comes from.** One value or a list; allowed:

1. the **internet URL** of the document it was distilled from
2. a **quoted** link to a `90-Reference/` document:
   `"[[90-Reference/<project>/<document>]]"`
3. a short **free-text origin** when no document exists

Quote wiki links, never bare paths: Obsidian renders an unquoted
`90-Reference/foo.md` in `source:` as inert text. External material mentioned
inline keeps a short labelled Markdown link next to the entity (`[docs](https://…)`).

## 7. `90-Reference/`: integral sources, out of search

Papers, specifications, logs, manuals, exported documents: the material notes
are distilled from.

- Exempt from the schema (§1) and from atomicity: a file may be long
- Out of search (§3): reached only by **deepening** — a note's `source:`, the
  index `[[90-Reference/00-Reference]]`, a link — and read in pieces, never whole
- **Immutable**: no edits, no reformatting, no link upkeep inside; corrections
  go into the distilled note. An imported document keeps its own relative links
  as imported
- New material: a per-project subfolder with its own `00-<project>.md` index,
  listed in `90-Reference/00-Reference.md`

## 8. `99-Templates/`

The types (§1) are the templates: `99-Templates/<type>.md` — `note`, `project`,
`resource`, `log`, `moc` (`area` reuses `note.md`). Placeholders
(`{{date:YYYY-MM-DD}}`, `{{title}}`) keep the Obsidian syntax; templates are
exempt from the schema and out of search (§3). A new file starts from its
template — `vault_note` fills it — and `summary` is written last, when the note
is what it is.

## 9. Section policy

Rules specific to one folder — its structure, its naming, the shape of its
notes — live in a `POLICY.md` **inside that folder** and govern its whole
subtree: inside the folder they override this file, which applies everywhere
else. A `POLICY.md` is vault machinery, not a note: exempt from the schema (§1),
never linted, never rewritten as a link.

## 10. Git: commit only on explicit request

- Work ends in the working tree: writing the files is enough, no `git add` / `git commit`
- Commit **only if the user explicitly asks**; a request to change something does not imply a commit
- Never `push`, `reset`, `amend` or `rebase` to repair your own work: report it and wait
