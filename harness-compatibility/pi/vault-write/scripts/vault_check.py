#!/usr/bin/env python3
"""vault_check.py — mechanical integrity check for a markdown wiki-link vault.

Mirrors what the dsh-vault-tab plugin enforced inside its vault_* tools:
broken links, links left dangling by a move/delete, summary budgets, notes
missing from every MOC, filename hygiene. It checks; it never writes.

The vault's own POLICY.md remains the authority. When its numbers differ from
the defaults below, pass the flags (--max-summary, --summary-target, --skip).

Usage:
  vault_check.py [--root PATH]
                 [--changed p ...] [--removed p ...] [--all]
                 [--skip DIR ...] [--max-summary N] [--summary-target N]

  --changed  paths (relative to the vault root, .md optional) that were
             created or edited in this change
  --removed  paths that this change deleted or renamed away; every link still
             pointing at them is BLOCKING
  --all      link-check the whole vault; pre-existing rot reports as
             `warning vault-rot`, never blocking

Root resolution (first wins): --root, $VAULT_ROOT, $VAULT_PATH,
.vault-root files from cwd upward, ~/.config/vault-skills/root.

Exit codes: 0 = clean (warnings allowed), 1 = blocking issues, 2 = bad root.

Twin copy lives in vault-git/scripts/ — keep the two in sync.
"""

import argparse
import os
import re
import sys
import unicodedata
from pathlib import Path

DEFAULT_SKIP = ["90-Reference", "99-Templates"]
WIKILINK_RE = re.compile(r"(!?)\[\[([^\]\[]+?)\]\]")
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\uFE0F]"
)


def norm(s: str) -> str:
    """NFC, casefold, strip accents — like the plugin's matcher."""
    s = unicodedata.normalize("NFC", s).casefold()
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return s


def resolve_root(cli_root):
    cands = []
    if cli_root:
        cands.append(cli_root)
    for var in ("VAULT_ROOT", "VAULT_PATH"):
        if os.environ.get(var):
            cands.append(os.environ[var])
    d = Path.cwd()
    for parent in [d, *d.parents]:
        f = parent / ".vault-root"
        if f.is_file():
            lines = [l.strip() for l in
                     f.read_text(encoding="utf-8").splitlines() if l.strip()]
            cands.append(lines[0] if lines else "")
            break
    home_cfg = Path.home() / ".config" / "vault-skills" / "root"
    if home_cfg.is_file():
        cands.append(home_cfg.read_text(encoding="utf-8").strip())
    for c in cands:
        if not c:
            continue
        p = Path(c).expanduser().resolve()
        if p.is_dir():
            return p
        print(f"BLOCKING bad-root {c}: not a directory", file=sys.stderr)
    print("no usable vault root: pass --root, set VAULT_ROOT, "
          "or point .vault-root / ~/.config/vault-skills/root at a folder",
          file=sys.stderr)
    return None


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def strip_code(text: str) -> str:
    out, fence = [], None
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        out.append(line)
    return "\n".join(out)


def walk_md(root: Path, skip):
    """All .md files under root, honoring skips and dot-dirs."""
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        rel = "" if rel == "." else rel.replace(os.sep, "/")
        if any(rel == s or rel.startswith(s + "/") for s in skip):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.endswith(".md"):
                yield Path(dirpath) / fn


def rel_key(root: Path, path: Path) -> str:
    r = path.relative_to(root).as_posix()
    return r[:-3] if r.endswith(".md") else r


def norm_path(p: str) -> str:
    return "/".join(seg for seg in p.replace("\\", "/").split("/")
                    if seg not in ("", "."))


class Vault:
    def __init__(self, root: Path, skip):
        self.root = root
        self.skip = skip
        self.all_files = []          # every file under root (link targets)
        self.md_sources = []         # md files where links are checked
        for dirpath, dirnames, filenames in os.walk(root):
            rel = os.path.relpath(dirpath, root)
            rel = "" if rel == "." else rel.replace(os.sep, "/")
            if rel.startswith(".git"):
                dirnames[:] = []
                continue
            in_skip = any(rel == s or rel.startswith(s + "/") for s in skip)
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in filenames:
                f = Path(dirpath) / fn
                self.all_files.append(f)
                if (fn.endswith(".md") and not in_skip
                        and fn != "POLICY.md"):  # policy is machinery: never linted
                    self.md_sources.append(f)
        # resolution tables: normalized key -> exists
        self.keys = set()
        for f in self.all_files:
            r = f.relative_to(root).as_posix()
            self.keys.add(norm(r))
            if r.endswith(".md"):
                self.keys.add(norm(r[:-3]))
                stem = Path(r).stem
                if stem == "index":  # folder note: [[dir]] resolves to dir/index.md
                    self.keys.add(norm(str(Path(r).parent)))
        self.dirs = {norm(f.parent.relative_to(root).as_posix())
                     for f in self.all_files if f.parent != root}
        self.link_index = {}         # norm target -> [(rel source, line)]
        for src in self.md_sources:
            for lineno, line in enumerate(strip_code(read(src)).splitlines(), 1):
                for _bang, target in WIKILINK_RE.findall(line):
                    t = norm_path(target.split("|")[0].split("#")[0].strip())
                    if not t or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", t):
                        continue
                    self.link_index.setdefault(norm(t), []).append(
                        (rel_key(root, src), lineno))

    def resolves(self, target: str) -> bool:
        t = norm_path(target)
        return norm(t) in self.keys or norm(t) in self.dirs

    def referrers(self, path_key: str):
        return self.link_index.get(norm(norm_path(path_key)), [])


def frontmatter(text: str):
    if not text.startswith("---"):
        return None
    lines = text.splitlines()
    for i, line in enumerate(lines[1:], 1):
        if line.strip() in ("---", "..."):
            return "\n".join(lines[1:i])
    return None


def is_machinery(rel: str) -> bool:
    name = Path(rel).name
    return name == "POLICY" or name.startswith("00-")


def check(root: Path, changed, removed, full, skip,
          max_summary, summary_target):
    v = Vault(root, skip)
    blocking, warnings = [], []
    changed = [norm_path(c)[:-3] if norm_path(c).endswith(".md")
               else norm_path(c) for c in changed]
    removed = [norm_path(c)[:-3] if norm_path(c).endswith(".md")
               else norm_path(c) for c in removed]

    # 1. links dangling after deletes/renames — blocking
    for gone in removed:
        for src, line in v.referrers(gone):
            blocking.append(
                f"BLOCKING dangling-link {src}:{line}: "
                f"[[{gone}]] points at a removed path")

    # 2. broken links inside changed files — blocking; elsewhere on --all — report
    changed_set = set(norm(c) for c in changed)
    for src in v.md_sources:
        key = rel_key(root, src)
        text = strip_code(read(src))
        for lineno, line in enumerate(text.splitlines(), 1):
            for bang, target in WIKILINK_RE.findall(line):
                t = norm_path(target.split("|")[0].split("#")[0].strip())
                if not t or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", t):
                    continue
                if v.resolves(t):
                    continue
                msg = f"{key}:{lineno}: [[{t}]] resolves to nothing"
                if norm(key) in changed_set:
                    blocking.append(f"BLOCKING broken-link {msg}")
                elif full:
                    warnings.append(f"warning vault-rot {msg}")

    # 3. per-file hygiene on changed notes
    moc_targets = set()
    for src in v.md_sources:
        if Path(src).name.startswith("00-"):
            for _b, target in WIKILINK_RE.findall(strip_code(read(src))):
                moc_targets.add(norm(norm_path(
                    target.split("|")[0].split("#")[0].strip())))
    for c in changed:
        f = root / (c + ".md")
        if not f.is_file():
            f = root / c
            if not f.is_file():
                warnings.append(f"warning missing {c}: listed as changed, "
                                f"not on disk")
                continue
            key = c  # non-md file (asset): only link checks apply to it
            continue
        key = rel_key(root, f)
        if any(key == s or key.startswith(s + "/") for s in skip):
            continue
        if is_machinery(key):
            continue
        text = read(f)
        fm = frontmatter(text)
        if fm is None:
            warnings.append(f"warning no-frontmatter {key}: note without "
                            f"frontmatter")
        else:
            m = re.search(r"^summary:\s*(.*)$", fm, re.M)
            if not m or not m.group(1).strip().strip("\"'"):
                warnings.append(f"warning no-summary {key}: summary is the "
                                f"retrieval key")
            else:
                s = m.group(1).strip().strip("\"'")
                if len(s) > max_summary:
                    blocking.append(
                        f"BLOCKING summary-over-max {key}: {len(s)} > "
                        f"{max_summary}")
                elif len(s) > summary_target:
                    warnings.append(f"warning summary-over-target {key}: "
                                    f"{len(s)} > {summary_target}")
        # indexing: reachable from some 00-*.md?
        if norm(key) not in moc_targets:
            warnings.append(f"warning not-indexed {key}: no 00-*.md links "
                            f"to it")
        # filename hygiene
        name = Path(key).name
        if re.search(r"[A-Z]", name) and name != "00-Home":
            warnings.append(f"warning name-not-kebab {key}: uppercase")
        if " " in name:
            warnings.append(f"warning name-not-kebab {key}: spaces")
        if EMOJI_RE.search(name):
            warnings.append(f"warning emoji-in-name {key}")

    for w in warnings:
        print(w)
    for b in blocking:
        print(b)
    print(f"-- {len(blocking)} blocking, {len(warnings)} warnings -- "
          + ("PASS" if not blocking else "FAIL"))
    return 1 if blocking else 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--root")
    ap.add_argument("--changed", nargs="*", default=[])
    ap.add_argument("--removed", nargs="*", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--skip", nargs="*", default=DEFAULT_SKIP)
    ap.add_argument("--max-summary", type=int, default=140)
    ap.add_argument("--summary-target", type=int, default=100)
    a = ap.parse_args()
    root = resolve_root(a.root)
    if root is None:
        return 2
    if not (a.changed or a.removed or a.all):
        ap.print_usage(sys.stderr)
        print("nothing to do: pass --changed/--removed/--all", file=sys.stderr)
        return 2
    return check(root, a.changed, a.removed, a.all,
                 [s.strip("/") for s in a.skip],
                 a.max_summary, a.summary_target)


if __name__ == "__main__":
    sys.exit(main())
