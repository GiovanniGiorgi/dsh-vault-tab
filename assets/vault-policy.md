---
type: policy
status: active
tags: [policy]
created: {{DATE}}
summary: "AI rules: frontmatter schema, naming, grep-first retrieval, MOC links-only, citations, reference, templates, git"
---

# Vault policy (AI)

Rules for any AI working in this vault. The vault is a folder of small Markdown
notes organised with PARA. Read this file before creating or editing a note.
Section-specific rules live in the section, not here (see §9).

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

`summary` is the retrieval key: it must contain the words someone would search
for. Target **100** characters; **max 140** only for dense notes (reference,
hardening, audit, porting). Descriptive richness belongs in the MOC annotations,
not in the summary.

## 2. Naming

Logic: numeric prefixes order folders by reading frequency, `00-` keeps indexes
first.

- Content folders: `kebab-case`, like files (`trips`, `cities`, `ai-implementation`); the numbered roots (`20-Areas/` etc.) stay unchanged
- Numeric prefixes: **10** projects, **20** areas, **30** resources, **40** archive, **90** reference, **99** templates
- Files: `kebab-case.md`, no accents (`second-brain-para.md`)
- MOC indexes: `00-<section>.md` inside the folder they index
- Dated notes: `YYYY-MM-DD-topic.md`
- One note = one concept, ~50 lines maximum. When it grows, split and link.

## 3. Retrieval (grep-first, minimal context)

1. **Never read the whole vault** or whole folders.
2. Grep metadata first, **excluding `90-Reference/`** (see §7):
   - file names: `find . -type f -name '*.md' -not -path './90-Reference/*' | grep -i keyword`
   - summaries: `grep -ri '^summary:' --include='*.md' . --exclude-dir=90-Reference | grep -i keyword`
   - search without accents ("citta" finds "città"): strip accents from the keyword
3. Read **only** the files you selected, and only when the answer needs them.
4. No match after retrying synonyms, singulars, one keyword at a time → the note
   does not exist: create it from a template in `99-Templates/`, then link it.
5. Update `status` and `summary` after every substantial change.

## 4. Saving

- Facts and decisions → `10-Projects/`, or a dated log note in the owning area
- Durable knowledge → `30-Resources/`
- Long-lived responsibilities and collections → `20-Areas/`
- Dead material → `40-Archive/`, keeping its internal structure
- Every new note gets: complete frontmatter + one backlink in a MOC

## 5. MOC files: links only

A MOC (`00-Home.md` and every `00-<section>.md`) is an **index, not a note**.

- Content is only list items: a wiki link plus a short one-line annotation. No
  prose, no sections of argument, no images, no code.
- A MOC carries **no `source:`** field: it is not derived from anything, it points.
  The one exception is a source that covers the **whole folder** the MOC indexes
  (its reference corpus, or the document the section was built from): that
  `source:` belongs to the MOC instead of to the individual notes.
- Home links only section MOCs (at most one level at a time), never the single
  notes of a section. A section with more than ~3 notes gets its own
  `00-<section>.md`; the Home entry points at that MOC.
- Adding a note means adding one line to the owning MOC. Deleting or renaming a
  note means fixing that line.

## 6. Where a link goes

Two different jobs, two different places.

**`source:` in the frontmatter — where the note comes from.** One value or a
list, when several documents feed one note. Allowed values:

1. an **internet URL** of the document the note was distilled from:
   `https://source.android.com/docs/core/graphics/hwc`
2. a **vault link to a `90-Reference/` document**, quoted:
   `"[[90-Reference/<project>/<document>]]"`
3. a short **free-text origin** when no document exists:
   `"Discussione di revisione specifiche (2026-11)"`

Quote wiki links and never write a bare path in `source:`: Obsidian follows
`[[…]]` and renders `90-Reference/foo.md` as inert text.

**Inline in the prose — what a sentence points at.** A labelled Markdown link,
kept short, next to the entity it documents: `📍[mappa](https://www.google.com/maps/place/…)`,
`[docs](https://…)`, `[repo](https://…)`. Vault notes reached from the text use
`[[path|alias]]` with the path from the vault root.

Never a path to a folder outside the vault — anything worth citing is copied into
`90-Reference/` or linked by URL — and no link that resolves to nothing: create
the target in the same change, or drop the link.

## 7. `90-Reference/`: integral sources, out of search

`90-Reference/` holds **non-atomic** resources: papers, specifications, logs,
manuals, exported documents — the material notes are distilled from.

- Exempt from the note schema (§1) and from atomicity: one file may be long.
- **Excluded from grep-first retrieval** (§3): searching the vault skips this
  folder. Reference answers come from the atomic notes.
- Use it for **deepening**, after a note or a MOC points there: from the note's
  `source:`, from the section index `[[90-Reference/00-Reference]]`, or from a
  link inside the note.
- Read it in pieces, never whole: `grep -n` for the term, then read the region
  around the hit.
- Treat the files as immutable: do not edit or reformat them; corrections go into
  the distilled note. An imported document stays as it was imported, including its
  own relative `[label](file.md)` links — Obsidian resolves those, and rewriting
  them would corrupt the source. New material goes in a per-project subfolder
  (`90-Reference/<project>/`) with its own `00-<project>.md` index, listed in
  `90-Reference/00-Reference.md`.

## 8. `99-Templates/`

Templates keep their own format, with placeholders like `{{date:YYYY-MM-DD}}` and
`{{title}}`, and are exempt from the note schema. They are the starting point for
new files: `note.md`, `project.md`, `resource.md`, `log.md`, `moc.md`. When you create a file
from one, replace the placeholders with today's date and the note's title, and
write `summary` last. Do not write new notes freehand and do not turn a template
into a note.

## 9. Section policy

Rules specific to one section (structure, naming, note shape) live in a
`POLICY.md` **inside that section's folder**, not in this file. Before working in
a section, read its `POLICY.md` if one exists. The general policy never lists
single-section rules: it would go stale and load irrelevant context.

## 10. Git: commit only on explicit request

- Work normally ends in the working tree: writing the files is enough, no `git add` / `git commit`.
- Commit **only if the user explicitly asks** in the request. A request to change something does not imply a commit.
- Never `push`, `reset`, `amend` or `rebase` to repair your own work: report it and wait.
