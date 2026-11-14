# `vault-read` — finding things in the vault

**File:** `skills/vault-read.md` · **always registered** · **gate:** none — reading is
never a permission

## What it is for

Answering from the vault with the smallest context that decides the next step, and
storing what the vault did not have. The tools bind with the writing ones but
never consult the Grant: a session that cannot write still searches and reads.

It fires whenever something should be found or remembered, *even when the user does
not say "vault" or "search"*.

## The loop it teaches

1. `vault_search { keywords: [...] }` — every keyword must appear in the **file name
   or the `summary:`**; nothing else is read. The answer is rows of path + summary:
   the whole vault on one screen.
2. Read **only** the notes that answer, `vault_read` with `from`/`lines`. Notes are
   atomic on purpose, so the default window (120 lines) usually is the whole note.
3. Follow where the note points: `source:` for provenance, inline links for
   subjects, the MOC for neighbours.
4. Nothing found → the note does not exist. Say so, then store it.

## Keywords, not queries

- All keywords must be present; `tokyo ramen` as one string is the same AND as two.
- Accents and case are folded by the tool: `citta` finds `città`. Spelling is not —
  try the Italian and the English term.
- Before concluding a note is missing: one keyword at a time, the singular, a
  synonym, then `scope` narrowed to the folder that should hold it. The `hint` in an
  empty answer says the same.
- `type: 'moc'` finds indexes; `includeReference: true` opts the reference folder in.

## Two other shapes of the same tool

- **Inventory** — `vault_search { scope }` with no keyword: what a folder holds, its
  subfolders with note counts, and the `00-*.md` index that owns it. Navigation
  without reading folders.
- **Full text** — `where: 'fulltext'`: bodies are read and matching lines come back
  **numbered**, which is what makes a long document affordable — the next call is
  `vault_read { from }` around the hit. `outline: true` gives the headings first.

## `90-Reference/`: deepening, never searching

Reference is excluded from search by default (policy §7): you arrive from a note's
`source:`, from a link, or from `90-Reference/00-Reference`. Once inside, read in
pieces, never whole, and treat the files as read-only in spirit — a correction goes
into the distilled note, not into the source.

## Why a tool instead of the session's `grep`

| | session `grep`/`find` | `vault_search` |
| --- | --- | --- |
| reaches the vault | only inside the session workspace — outside it is refused outright | always, the root is the plugin's |
| knows the vault's rules | no: reference and templates show up, accents break | yes: exclusions, folding, index awareness |
| shape of the answer | raw text, unbounded | rows with a schema, capped (60 rows, 400-line reads) |
| cost on a real vault | full-text by default | metadata scan of 308 files in ~33 ms; 10 questions ≈ 12.7 kB against 1.33 MB of file bodies |

The caps live in `index.js` as `SEARCH_SCAN_CAP`, `SEARCH_ROW_CAP`,
`READ_DEFAULT_LINES`, `READ_MAX_LINES`, `SEARCH_FILE_BYTES`, `READ_TEXT_CAP`,
`SEARCH_EXCLUDE`. There is deliberately **no index on disk**: a scan of a few
hundred frontmatter heads is fast enough and can never be stale.

## Editing

Prose in `skills/vault-read.md`, trigger text in `READ_SKILL_DESCRIPTION` /
`READ_SKILL_WHEN_TO_USE`. If retrieval behaviour changes, the skill and the tool
descriptions (`SEARCH_TOOL_DESCRIPTION`, `READ_TOOL_DESCRIPTION`) are edited in the
same change — a model reads all three to decide what to call.
