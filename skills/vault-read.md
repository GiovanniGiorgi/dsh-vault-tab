---
name: vault-read
description: Retrieve from the vault with the read tools — grep-first over file names and summaries, minimal context, 90-Reference only for deepening — and store what the vault does not have as one atomic, indexed note.
---

# Reading the vault

Reading is never a permission: `vault_search` and `vault_read` answer in every
session mode, need no Vault Grant, and take paths **relative to the vault root**.
They exist because retrieval here is a discipline set by the vault's `POLICY.md`
(§3), not a habit: metadata before content, the smallest context that decides the
next step, `90-Reference/` out of the search. Use them instead of `grep`, `find`
or `glob` on vault paths, even when those would work.

## 1. The loop

1. `vault_search { keywords: [...] }` — every keyword must appear in the **file
   name or the `summary:`**, and nothing else is read. The answer is rows of
   `path` + `summary`: the whole vault, one screen.
2. Pick. Read **only** the notes that answer the question: `vault_read`, a region
   at a time (`from`, `lines`). They are atomic on purpose, a handful of lines
   each, so the default window is usually the whole note. The session's own `read`
   may be refused on vault paths outside Full access; `vault_read` never is.
3. Follow where the note points: `source:` for where it came from, the inline
   links for what it talks about, the MOC for its neighbours.
4. Nothing found → the note does not exist. Say so, then store it (§4).

## 2. Keywords, not queries

- One concept per keyword; all of them must be present. `tokyo` + `ramen` is
  narrower than either alone, and `tokyo ramen` as one string does the same AND.
- Accents and case are folded away: `citta` finds `città`, `Vinili` finds `vinili`.
  Spelling is not folded — try both the Italian and the English term.
- Before concluding a note is missing: one keyword at a time, the singular, a
  synonym, then `scope` narrowed to the folder that should hold it. The `hint` in
  an empty answer says the same.
- `type: 'moc'` finds indexes, `type: 'resource'` the durable knowledge.

## 3. Two other shapes of the same tool

- **Inventory** — `vault_search { scope: '30-Resources/citta/giappone' }` with no
  keyword: what the folder holds, its subfolders with their note counts, and the
  `00-*.md` index that owns it. Navigation without reading folders.
- **Full text** — `where: 'fulltext'` reads bodies and returns the matching lines
  with their numbers. Use it when the note probably exists but its summary does
  not say so, or to enter `90-Reference/` deliberately.

## 4. Storing what the vault did not have

Search first — a duplicate note is the one answer that gets worse with time. Then:

- **`vault_note`** is the normal door: it builds the `kebab-case` name from the
  title, fills the vault's own `99-Templates/<type>.md`, requires the `summary`
  (the retrieval key — target 100 characters, refused above 140) and appends the
  one line in the MOC that makes the note reachable.
- **`vault_write`** writes what a note is not: an integral document in
  `90-Reference/`, an index, an imported file. Both answer with **policy warnings**
  (`not-atomic`, `broken-link`, `summary-over-target`, `not-indexed` …): they are
  the vault's budgets, and the same change should finish them.
- One note = one concept, ~50 lines. A note that grows is split and linked, not
  extended. Material that cannot be atomic is not a note: it goes to
  `90-Reference/`, and the distilled note cites it in `source:`.
- Where it goes (§4 of the policy): facts and decisions → `10-Projects/`, durable
  knowledge → `30-Resources/`, long-lived responsibilities → `20-Areas/`, dead
  material → `40-Archive/`.

## 5. `90-Reference/`: deepening, never searching

The folder holds integral sources, exempt from the note schema and **excluded from
search** (§7). You arrive there from a note (`source:`, a link) or from
`90-Reference/00-Reference`, not by grepping. Once inside:

- `vault_read { path, outline: true }` for the shape, then `from`/`lines` for the
  region — never the whole document, and never `cat`.
- `vault_search { where: 'fulltext', includeReference: true }` (or a `scope` inside
  the folder) when the term is known but its location is not.
- Files there are read-only in spirit (§7): a correction goes into the distilled
  note, not into the source.

## 6. Answering

Cite what you read as vault paths (`30-Resources/citta/giappone/nagano`) so the
user can open them, say when the vault does not know something instead of filling
the gap from memory, and treat a lint warning or a broken link you met on the way
as something to report — fixing it is the `vault-write` skill's job, with the
user's agreement.
