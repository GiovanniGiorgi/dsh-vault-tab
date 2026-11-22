---
name: vault-read
description: Retrieve from a markdown vault (PARA + wiki links + MOC indexes) with the plain tools — file names and summary: lines first, bodies only for picked notes, reference folders never searched — and report what the vault does not hold. Use when asked to find, recall, or survey notes in a vault.
---

# Reading the vault

Retrieval here is a discipline, not a habit: metadata before content, the
smallest context that decides the next step, the reference archive out of the
search. This skill needs no special tools — `find`, `grep` and `read` do it
all — and no permissions.

## Locate the vault

Resolve the vault root, first match wins:

1. a path the user names in this conversation
2. `$VAULT_ROOT` or `$VAULT_PATH`
3. a `.vault-root` file (one path per line, `~` allowed) in the working
   directory or its ancestors
4. `~/.config/vault-skills/root`
5. ask the user; on an answer offer to remember it with
   `mkdir -p ~/.config/vault-skills && echo '<path>' > ~/.config/vault-skills/root`

Never invent a path. Then read the root `POLICY.md` if present — it decides
folder names, retrieval scope and what `90-Reference/`-like folders mean here.
Where the policy and this skill disagree, the policy wins; say so once. With
no policy, follow the vault's own conventions (folder names, existing
frontmatter) and do not lecture.

## The loop

1. **Search names:**
   ```bash
   find "$ROOT" -name .git -prune -o \
     \( -path '*/90-Reference/*' -o -path '*/99-Templates/*' \) -prune -o \
     -iname '*keyword*' -name '*.md' -print
   ```
2. **Search summaries** — the retrieval key, the only body line worth
   grepping. All keywords must appear on the same `summary:` line (AND, one
   concept per keyword — `tokyo` AND `ramen` is narrower than either):
   ```bash
   grep -ri --include='*.md' --exclude-dir=.git \
     --exclude-dir=90-Reference --exclude-dir=99-Templates \
     '^summary:' "$ROOT" | grep -i tokyo | grep -i ramen
   ```
   The answer is rows of `path` + `summary`: the whole vault, one screen.
3. **Pick, then read.** Only the notes that answer the question, with `read`
   — a region at a time for long files (`offset`/`limit`). These notes are
   atomic by design (~80 lines), so the default window is usually the whole
   note.
4. **Follow where the note points:** `source:` for provenance, `[[links]]`
   for what it talks about, the folder's `00-*.md` MOC for its neighbours.
5. **Nothing found → the note does not exist.** Say so plainly; do not fill
   the gap from memory. Storing the answer is `vault-write`'s job.

## Search hygiene

- Accents and case are NOT folded by grep the way the old plugin folded them:
  try `citta` and `città`, `Citta` too. Spelling is never folded — try both
  the Italian and the English term.
- Before concluding a note is missing: one keyword at a time, the singular, a
  synonym, then narrowed to the folder that should hold it.
- **Inventory without reading:** `ls` the folder and `read` its `00-<section>.md`
  index — the MOC is the table of contents, not a note to skim through.
- **Full text** (`grep -rn` over bodies) only when the note probably exists
  but its summary does not say so. It is the *only* way into
  `90-Reference/`-style archives, and only deliberately, with a known term.

## Reference archives (`90-Reference/`)

Integral sources: papers, manuals, exports, logs. Exempt from the note schema
and **excluded from search**. You arrive there from a note's `source:`, a
link, or the archive's own index (`90-Reference/00-Reference.md`) — never by
grepping. Once inside: read the shape first (headings), then the region you
need; never `cat` a whole document. The files are read-only in spirit: a
correction goes into the distilled note that cites them, not into the source.

## Answering

Cite what you read as vault-relative paths (`30-Resources/citta/giappone/nagano.md`)
so the user can open them. Say when the vault does not know something instead
of inventing. A broken link or a schema oddity met on the way is something to
**report** — fixing it is `vault-write`'s job, with the user's agreement.
