// Host half of @local/dsh-vault-tab.
//
// Four capabilities live here, and they are deliberately not equally gated:
//
// 1. The Vault tab listing: one exact JSON route listing one level of the
//    configured root. An unset root falls back to `<home>/Vault`, so a fresh
//    install works out of the box; a missing root folder is reported as
//    `{ root, missing: true }` and the Client shows where to reconfigure. Any
//    requested path is resolved and must stay under the root. File previews do
//    not go through this route: the Client opens the built-in Document viewer,
//    whose reads follow the Session's own file-read authority.
//
// 2. Vault write: `vault_write`, `vault_note`, `vault_move`, `vault_delete`,
//    `vault_setup`, plus the `vault-setup` and `vault-write` skills. Plugin Host
//    code runs in the Host process, outside both enforcement points the sandbox
//    has (the `ctx.fs` policy fence and the confined `ctx.shell` runners), so
//    this is the only path that can change a vault folder while the Session is
//    `read-only` or `workspace-write`. The tools are therefore the single place
//    where the vault boundary is decided — the user's Vault Grant, the
//    confirmations, and the policy budgets of the notes themselves (a summary
//    too long to stay a retrieval key, a note that stopped being atomic); the
//    skills only explain the order of operations, and the user is asked before
//    anything is written or removed.
//
// 3. Vault read: `vault_search` and `vault_read`, with the `vault-read` skill.
//    Reading is not a permission: the two tools share the binding scope of the
//    writing ones — that is where the tool slot the agents inherit lives — but
//    they never consult the Grant. They exist because the retrieval the
//    vault policy describes is a discipline a raw `grep` does not enforce: grep
//    the metadata (names and `summary:`) before the content, return the smallest
//    answer that decides the next step, keep `90-Reference/` out of the search
//    and enter long documents in regions.
//
// 4. Vault git: `vault_git`, with the `vault-git` skill. The vault's policy (§10)
//    commits only on an explicit request and repairs nothing by rewriting
//    history, so the tool offers one fixed vocabulary — status, audit, commit —
//    run through argv: push/reset/amend/rebase are not reachable at all. Commit
//    adds its own locks on top of the Grant: a clean integrity audit whose token
//    dies with the next edit, and the user's agreement carried as `confirm: true`.
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

// The tab needs only the web server. The setup capability asks for `tools` and
// `skills` through a runtime inject below, so a profile without either still
// gets its Vault tab instead of a row stuck in pending.
export const inject = ['webServer'];

/** Patch row id whose config this plugin edits in the profile. */
const ROW_ID = 'vault-tab';

/** Directory of this module, to read the shipped `assets/` and `skills/`. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Entries reported per level before the list is cut, mirroring the workspace file cap. */
const MAX_ENTRIES = 1000;

/**
 * Roots created by `create`: the four PARA folders, then `90-Reference` and
 * `99-Templates`. A `99-AI` folder is deliberately not part of the structure —
 * the policy lives at the vault root, next to the home index.
 */
const SECTIONS = ['10-Projects', '20-Areas', '30-Resources', '40-Archive', '90-Reference', '99-Templates'];

/** Files seeded with the roots, each from the asset that supplies its text. */
const SEEDS = [
	{ rel: '00-Home.md', asset: 'vault-home.md' },
	{ rel: 'POLICY.md', asset: 'vault-policy.md' },
	{ rel: '90-Reference/00-Reference.md', asset: 'vault-reference-index.md' },
	{ rel: '99-Templates/note.md', asset: 'vault-template-note.md' },
	{ rel: '99-Templates/project.md', asset: 'vault-template-project.md' },
	{ rel: '99-Templates/resource.md', asset: 'vault-template-resource.md' },
	{ rel: '99-Templates/log.md', asset: 'vault-template-log.md' },
	{ rel: '99-Templates/moc.md', asset: 'vault-template-moc.md' },
];

/** Existing folders never acceptable as a vault root, whatever they contain. */
const NEVER_ROOTS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/opt', '/proc', '/root', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var']);

/**
 * The row's config. `root` is editable from the plugin's card in the Plugins
 * panel (configForms writes it into the profile patch; the field is volatile,
 * so the next listing already uses the new value). Empty means the default
 * `<home>/Vault`; `~` in a configured path expands to the home directory.
 *
 * `skillSetup` is volatile too, and not by accident: the settings service
 * serves and mutates ONLY volatile fields (`volatileForm` in dsh-settings), so
 * an ordinary field would be invisible to the card and its writes refused.
 * Volatile commits do not restart the row; the loader updates the reference in
 * place and emits `loader/volatile-update` on the fiber's ctx, and the skill
 * registration follows that event live (see `syncSkill`).
 */
export const Config = z.object({
	root: z
		.string()
		.default('')
		.description('Absolute path of the folder the Vault tab lists (empty: <home>/Vault).')
		.volatile(),
	skillSetup: z
		.boolean()
		.default(true)
		.description('Register the vault-setup skill, which scaffolds or adopts a vault folder through the vault_setup tool.')
		.volatile(),
	writeRoot: z
		.string()
		.default('')
		.description('Absolute path the vault_write tool may write (empty: the Vault path above). Reading never needs this.')
		.volatile(),
	vaultGrantDefault: z
		.boolean()
		.default(false)
		.description('Start a session under Workspace Write with the Vault Grant on. Read Only never writes, Full access always does.')
		.volatile(),
	gitCommit: z
		.boolean()
		.default(true)
		.description('Let vault_git commit the vault repository — after its integrity audit and the user’s confirmation. Status and audit stay available with this off; nothing else in this plugin ever runs git.')
		.volatile(),
});

/** Volatile fields arrive as `{ get() }` references; plain values pass through. */
function currentValue(value) {
	return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/** Effective listing root: configured path (with `~` support) or `<home>/Vault`. */
function resolveRoot(raw) {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) return path.join(os.homedir(), 'Vault');
	if (value === '~') return os.homedir();
	if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
	return path.resolve(value);
}

/** Absolute path with `~` support, or `undefined` when the input is not one. */
function absolutePath(raw) {
	if (typeof raw !== 'string') return void 0;
	const value = raw.trim();
	if (!value) return void 0;
	if (value === '~') return os.homedir();
	if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
	if (!path.isAbsolute(value)) return void 0;
	return path.resolve(value);
}

/** Today as `YYYY-MM-DD`, filling the `{{DATE}}` placeholder of the assets. */
function today() {
	return new Date().toISOString().slice(0, 10);
}

/** Read one shipped asset with its placeholders resolved. */
async function readAsset(name) {
	const text = await readFile(path.join(HERE, 'assets', name), 'utf8');
	return text.replace(/\{\{DATE\}\}/g, today());
}

/** Existence and kind of one path, without throwing on the common misses. */
async function probe(target) {
	try {
		const info = await stat(target);
		return { exists: true, directory: info.isDirectory() };
	} catch (error) {
		if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { exists: false, directory: false };
		throw error;
	}
}

// --- Vault write -------------------------------------------------------------
//
// The grant lives here, in memory, keyed by session. It is NOT a session event:
// a plugin cannot append a new event type and reopen the log afterwards, and
// `appendPluginRecord` is reserved for DSH's own experimental packages. So the
// decision of the user lives as long as the session lives in this Host process,
// and a restart returns to `Config.vaultGrantDefault`.

/** Sessions whose Vault Grant the user decided by hand, by session id. */
const grants = new Map();

/** Largest content one `vault_write` accepts. */
const MAX_WRITE_BYTES = 1 << 20;

/** Notes one link scan reads at most; a bigger vault reports `truncated`. */
const LINK_SCAN_CAP = 4000;

/** Referrer lines one call reports; the count is exact, the list is a sample. */
const LINK_REPORT_CAP = 40;

/** Starting grant of a session that never toggled it. */
function grantDefault(config) {
	return currentValue(config && config.vaultGrantDefault) === true;
}

/** Effective write root: the configured one, else the (defaulted) read root. */
function writeRootOf(config) {
	return absolutePath(currentValue(config && config.writeRoot)) || resolveRoot(currentValue(config && config.root));
}

/**
 * The one resolver of "may this session write to the vault", shared by the tool,
 * the command and the composer chip so the control can never disagree with the
 * enforcement. The sandbox mode decides; the stored choice only matters under
 * `workspace-write`, which is the one regime where this adds a capability.
 */
function grantState(ctx, session, fallback) {
	const policy = ctx.get('sandboxPolicy');
	const mode = policy ? policy.resolve({ session }).mode : void 0;
	if (mode === 'danger-full-access') return { mode, allowed: true, editable: false };
	if (mode !== 'workspace-write') return { mode, allowed: false, editable: false };
	if (grants.has(session.header.id)) return { mode, allowed: grants.get(session.header.id), editable: true };
	// A fork inherits the parent's decision; a delegated child never does — the
	// two are told apart by `origin`, which only a subagent sets.
	const parent = session.header.parentSession;
	const inherited = parent && session.header.origin !== 'subagent' && grants.has(parent) ? grants.get(parent) : fallback;
	return { mode, allowed: inherited, editable: true };
}

/** What to answer when a path is not a usable vault-relative path. */
const PATH_HINT = 'Keep the path inside the vault root: relative to it, no leading slash, no .. segment.';

/**
 * The checks every vault mutation shares, in the one order that matters: a live
 * session, the user’s grant for it, and a write root that is actually a folder.
 * Returns `{ root }` or the refusal the tool should hand straight back.
 */
async function mutationGate(ctx, config, exec, tool) {
	const agent = exec.agent;
	if (!agent) return { error: 'no-session', hint: `${tool} only runs for a live session, whose user decides the grant.` };
	const state = grantState(ctx, agent.session, grantDefault(config));
	if (!state.allowed) {
		return {
			error: state.mode === 'read-only' ? 'session-read-only' : 'grant-off',
			hint:
				state.mode === 'read-only'
					? 'The session is Read Only: ask the user to raise the permission to Workspace Write, then to switch the Vault control on.'
					: 'Ask the user to switch the Vault control on, in the composer next to the permission selector. Do not retry and do not use bash.',
		};
	}
	if (exec.signal?.aborted) return { error: 'cancelled', hint: 'The call was cancelled.' };
	return resolvedWriteRoot(config);
}

/**
 * The same root checks without the grant: a link scan reads the vault, and
 * reading is not a mutation — `dryRun` and the delete link check answer whether
 * a change is safe before the user has decided anything.
 */
async function readGate(ctx, config) {
	return resolvedWriteRoot(config);
}

/** The configured write root, proven to be a folder, or the refusal to hand back. */
async function resolvedWriteRoot(config) {
	const root = writeRootOf(config);
	if (!absolutePath(root)) return { error: 'write-root-invalid', hint: 'Set an absolute Vault write path in Plugins → Vault Tab.' };
	if (!(await probe(root)).directory) return { error: 'write-root-missing', root, hint: 'The vault folder does not exist; ask the user, or use vault_setup.' };
	return { root };
}

/** The errno a rename or remove failed on, in the vocabulary the vault tools answer with. */
function failureOf(error, what) {
	const message = String((error && error.message) || error);
	switch (error && error.code) {
		case 'ENOENT':
			return { error: 'not-found', hint: `The ${what} disappeared before the change; nothing was touched.` };
		case 'EXDEV':
			return { error: 'cross-device', hint: 'The two paths sit on different devices; the vault tool does not copy.' };
		case 'EISDIR':
		case 'ENOTDIR':
			return { error: 'wrong-kind', hint: message };
		case 'EPERM':
		case 'EACCES':
			return { error: 'denied-by-system', hint: message };
		default:
			return { error: 'change-failed', hint: message };
	}
}

/**
 * One vault link: `[[path]]`, `[[path#anchor|alias]]`, and the `![[…]]` embeds,
 * which contain the `[[…]]` form and need no extra rule. Group 1 is the path,
 * 2 the `#` anchor, 3 the `|` alias — the tail is captured so a rewrite can put
 * it back untouched.
 */
const LINK_PATTERN = /\[\[([^[\]|#]+)((?:#[^[\]|]*))?(\|[^[\]]*)?\]\]/g;

/** The same link, non-global: to re-extract groups from an ORIGINAL line after matching on a masked one. */
const LINK_ONCE = new RegExp(LINK_PATTERN.source);

/** Vault links carry no extension; a stray `.md` is tolerated when reading. Compared in NFC, the form the tools keep. */
function linkPath(raw) {
	return String(raw).trim().normalize('NFC').replace(/\.md$/, '');
}

/**
 * True when link path `p` is the target, or something inside it for a folder.
 * Placeholders are never links: `POLICY.md` and the templates document the
 * convention with `[[90-Reference/<project>]]` and `[[<path/from/root>]]`, and a
 * folder prefix would otherwise rewrite the rules that describe the folder.
 */
function refersTo(p, target, folder) {
	if (p.includes('<') || p.includes('>') || p.includes('…')) return false;
	return p === target || (folder === true && p.startsWith(target + '/'));
}

/** Lines outside ``` fences, with 1-based numbers: a link inside a fence is an example, not a link. */
function proseLines(text) {
	const lines = [];
	let fence = false;
	text.split('\n').forEach((line, index) => {
		if (line.trimStart().startsWith('```')) {
			fence = !fence;
			return;
		}
		if (!fence) lines.push({ text: line, line: index + 1 });
	});
	return lines;
}

/** Blank out inline code spans, so `[[nodiscard]]` written as code is not read as a link. */
function maskInlineCode(line) {
	return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/** Folders whose files the vault declares read-only: hits there are reported, never rewritten. */
const IMMUTABLE_LINK_DIRS = ['90-Reference'];

/** Folders that hold vault machinery rather than notes: no link points at them, so a link check says nothing. */
const PROTECTED_DELETE_DIRS = ['99-Templates'];

function inFolders(rel, folders) {
	return folders.some((folder) => rel === folder || rel.startsWith(folder + '/'));
}

/** Every `.md` under `dir`, dot folders skipped; bounded so a huge vault cannot stall the call. */
async function collectMarkdown(dir, out, depth) {
	if (depth > 24 || out.length >= LINK_SCAN_CAP) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= LINK_SCAN_CAP) return;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!entry.name.startsWith('.')) await collectMarkdown(full, out, depth + 1);
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			out.push(full);
		}
	}
}

/** The vault-relative form of an absolute path, the only form links and reports use. */
function relPath(root, target) {
	return path.relative(root, target).split(path.sep).join('/');
}

/** One line of a referrer, short: the caller shows these to a human, not the whole file. */
function linkHit(rel, line, text) {
	return { path: rel, line, text: text.trim().slice(0, 200) };
}

/**
 * Read every note and collect the links that point at `target` — a folder
 * includes what is inside it, which is how Obsidian links work: nobody links a
 * folder, everyone links the notes inside it. `immutable` holds the hits the
 * tool may not fix, so an upkeep that looks clean is not.
 */
async function scanLinks(root, target, folder, skip) {
	const files = [];
	await collectMarkdown(root, files, 0);
	const referrers = [];
	const immutable = [];
	let scanned = 0;
	let hits = 0;
	let truncated = false;
	for (const file of files) {
		if (scanned >= LINK_SCAN_CAP) {
			truncated = true;
			break;
		}
		const rel = relPath(root, file);
		// Deleting never counts the links that live INSIDE the deleted path:
		// they go with it, and a self-reference must not look like a broken one.
		if (skip && (rel === skip || rel.startsWith(skip + '/'))) continue;
		scanned += 1;
		let text;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue;
		}
		for (const entry of proseLines(text)) {
			// The prose rule of the lint, here too: a link inside inline code is an example, not a link.
			const line = maskInlineCode(entry.text);
			LINK_PATTERN.lastIndex = 0;
			let match;
			while ((match = LINK_PATTERN.exec(line))) {
				if (!refersTo(linkPath(match[1]), target, folder)) continue;
				hits += 1;
				(inFolders(rel, IMMUTABLE_LINK_DIRS) ? immutable : referrers).push(linkHit(rel, entry.line, entry.text));
			}
		}
	}
	return {
		hits,
		scanned,
		truncated,
		referrers: referrers.slice(0, LINK_REPORT_CAP),
		immutable: immutable.slice(0, LINK_REPORT_CAP),
	};
}

/**
 * Point every link at `target` to `newTarget` and write the files that changed.
 * The rewrite touches only what the regex matched, and never a file under an
 * immutable folder; `untouchable` reports those so the caller can stop and ask
 * instead of believing the vault is consistent.
 */
async function applyLinkRewrite(root, target, newTarget, folder) {
	const files = [];
	await collectMarkdown(root, files, 0);
	const changed = [];
	const untouchable = [];
	const failed = [];
	let scanned = 0;
	let truncated = false;
	for (const file of files) {
		if (scanned >= LINK_SCAN_CAP) {
			truncated = true;
			break;
		}
		const rel = relPath(root, file);
		scanned += 1;
		let text;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue;
		}
		let hits = 0;
		const rewrite = (whole, p, anchor = '', alias = '') => {
			const clean = linkPath(p);
			if (!refersTo(clean, target, folder)) return whole;
			hits += 1;
			const next = clean === target ? newTarget : newTarget + clean.slice(target.length);
			return `[[${next}${anchor}${alias}]]`;
		};
		// The same prose rule as the scan: a link inside a code fence — or inside
		// inline code — is an example, and an upkeep that edited examples would
		// corrupt the very documents that teach the convention. Matching happens on
		// the masked line, splicing on the original one: an alias carrying backticks
		// keeps its bytes.
		const lines = text.split('\n');
		for (const entry of proseLines(text)) {
			const masked = maskInlineCode(entry.text);
			let nextLine = '';
			let cursor = 0;
			let match;
			LINK_PATTERN.lastIndex = 0;
			while ((match = LINK_PATTERN.exec(masked))) {
				const groups = entry.text.slice(match.index, match.index + match[0].length).match(LINK_ONCE);
				if (!groups) continue;
				const replaced = rewrite(groups[0], groups[1], groups[2] ?? '', groups[3] ?? '');
				if (replaced === groups[0]) continue;
				nextLine += entry.text.slice(cursor, match.index) + replaced;
				cursor = match.index + match[0].length;
			}
			if (cursor) lines[entry.line - 1] = nextLine + entry.text.slice(cursor);
		}
		const rewritten = lines.join('\n');
		if (hits === 0) continue;
		if (inFolders(rel, IMMUTABLE_LINK_DIRS)) {
			untouchable.push({ path: rel, hits });
			continue;
		}
		if (Buffer.byteLength(rewritten) > MAX_WRITE_BYTES) {
			failed.push({ path: rel, reason: 'too-large' });
			continue;
		}
		// Atomic, like every other vault write: a reader never sees half a note.
		const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
		try {
			await writeFile(temp, rewritten, 'utf8');
			await rename(temp, file);
			changed.push({ path: rel, hits });
		} catch {
			await rm(temp, { force: true }).catch(() => {});
			failed.push({ path: rel, reason: 'write-denied' });
		}
	}
	return {
		changed,
		untouchable,
		failed,
		scanned,
		truncated,
		hits: changed.reduce((sum, entry) => sum + entry.hits, 0) + untouchable.reduce((sum, entry) => sum + entry.hits, 0),
	};
}

/**
 * Resolve `rel` under `root` and prove containment on CANONICAL paths: the
 * lexical test rejects the obvious escapes, then the deepest existing ancestor
 * is realpath'd so a symlinked folder cannot carry the target outside, and only
 * then is the missing suffix re-joined. Returns `{ target }` or `{ error }`.
 */
async function confinePath(root, rel) {
	// The vault's one form for special characters: NFC (composed). It is taught by
	// the skill and enforced at the boundary, so names, links and indexes all
	// speak the same bytes; file *content* is never normalized.
	const clean = String(rel ?? '').normalize('NFC').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!clean || clean.split('/').some((part) => part === '' || part === '.' || part === '..')) return { error: 'invalid-path' };
	const lexical = path.resolve(root, clean);
	if (lexical !== root && !lexical.startsWith(root + path.sep)) return { error: 'outside-root' };
	const base = await realpath(root).catch(() => root);
	let cursor = lexical;
	const suffix = [];
	for (;;) {
		const resolved = await realpath(cursor).catch(() => void 0);
		if (resolved !== void 0) {
			const target = suffix.length ? path.join(resolved, ...suffix.reverse()) : resolved;
			return target === base || target.startsWith(base + path.sep) ? { target } : { error: 'outside-root' };
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return { error: 'unresolvable' };
		suffix.push(path.basename(cursor));
		cursor = parent;
	}
}

// --- Vault retrieval ---------------------------------------------------------
//
// Reading the vault is not a permission: these helpers answer in every session
// mode and never consult the Vault Grant. They exist because the retrieval the
// policy describes (§3) is a discipline — grep the metadata before the content,
// read only what you selected, keep `90-Reference/` out of the search — and a
// model holding a raw `grep` breaks it: whole folders read, a 4000-line
// reference loaded to answer one question, `città` searched with `citta`. Each
// helper does one grep-first step and returns the smallest answer that lets the
// next step be decided.

/** Files one search walks at most; a bigger tree reports `truncated`. */
const SEARCH_SCAN_CAP = 6000;

/** Rows one search returns; the total is exact, the list is the best `limit`. */
const SEARCH_ROW_CAP = 60;

/** Lines `vault_read` returns when it was asked for none. */
const READ_DEFAULT_LINES = 120;

/** Lines `vault_read` returns at most: a whole reference document never fits in one answer. */
const READ_MAX_LINES = 400;

/** Bytes one file may hold to be read by the full-text search. */
const SEARCH_FILE_BYTES = 1 << 21;

/** Bytes of text `vault_read` returns at most, whatever the line counts are. */
const READ_TEXT_CAP = 96 * 1024;

/** Folders the policy keeps out of retrieval: §7 (integral sources) and §8 (templates). */
const SEARCH_EXCLUDE = ['90-Reference', '99-Templates'];

/** Extensions the full-text search reads. The metadata scan is Markdown only. */
const SEARCH_TEXT_EXTS = new Set(['.md', '.txt', '.log', '.json', '.csv', '.yaml', '.yml']);

/** `summary` budgets (policy §1): the target, and the maximum nothing may pass. */
const SUMMARY_TARGET = 100;
const SUMMARY_MAX = 140;

/** One concept per note, ~80 lines (policy §2). Tuned on a real 308-note vault where 23 passed 50. */
const NOTE_LINE_TARGET = 80;

/** Code points in a string, so an emoji counts as one and a budget means what it says. */
function textLength(value) {
	return Array.from(String(value ?? '')).length;
}

/**
 * Fold accents and case away: the vault is searched the way the policy says,
 * `citta` finding `città`. `NFKD` splits ligatures too, and the combining marks
 * left behind are dropped. Folding the haystack rather than the keyword is what
 * makes one comparison enough — plain `grep` cannot do this, which is why the
 * old vault carried a `sed` recipe for it.
 */
function foldText(value) {
	return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Decoration the vault keeps out of its retrieval keys. Arrows are not emoji: `→` stays legal. */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/** `kebab-case.md`; a dated note may carry the `YYYY-MM-DD-` prefix (policy §2). The seeded
 * home index is the one canonical name with a capital, so it is allowed by name. */
const KEBAB_NAME = /^([a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][a-z0-9._\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}-]*|00-Home)\.md$/u;

/** A policy file is vault machinery, not a note: the root one and any section policy. */
function isPolicyFile(rel) {
	return String(rel ?? '').split('/').pop() === 'POLICY.md';
}

/**
 * The frontmatter block of a note: `fields` holds the top-level `key: value`
 * pairs with quotes removed, `end` is the 1-based line the closing `---` sits on
 * (0 when the block never closes). No YAML parser on purpose: the vault schema is
 * flat by policy (§1), and a real parser would disagree with Obsidian at the
 * edges we cannot change.
 */
function frontmatterOf(text) {
	const lines = String(text ?? '').split('\n');
	if ((lines[0] ?? '').trim() !== '---') return { present: false, closed: false, fields: {}, end: 0 };
	const fields = {};
	let end = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '---') {
			end = i + 1;
			break;
		}
		if (!/^[A-Za-z0-9_-]+:/.test(line)) continue;
		const at = line.indexOf(':');
		let value = line.slice(at + 1).trim();
		if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
		fields[line.slice(0, at).trim()] = value;
	}
	return { present: true, closed: end > 0, fields, end };
}

/** The keywords of one call, split, deduplicated, folded once for every comparison. */
function normalizeKeywords(input) {
	const list = Array.isArray(input) ? input : [input];
	const out = [];
	for (const item of list) {
		for (const word of String(item ?? '').split(/[\s,]+/)) {
			const clean = word.trim();
			if (clean && !out.includes(clean)) out.push(clean);
		}
	}
	return out.slice(0, 8);
}

/**
 * Every file and folder under `dir`, as vault-relative paths, sorted for a
 * stable answer. Dot folders are pruned (`.git` holds no notes), `exclude` prunes
 * what the policy keeps out of search, and the cap bounds one call on a tree that
 * grew past the vault's meaning.
 */
async function collectVaultFiles(root, options = {}) {
	const { scope = '', extensions = null, exclude = [], cap = SEARCH_SCAN_CAP } = options;
	const base = scope ? path.join(root, scope) : root;
	const files = [];
	const folders = [];
	let truncated = false;
	const walk = async (dir, depth) => {
		if (depth > 24) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= cap) {
				truncated = true;
				return;
			}
			const full = path.join(dir, entry.name);
			const rel = relPath(root, full);
			if (entry.isDirectory()) {
				if (entry.name.startsWith('.')) continue;
				if (exclude.some((folder) => rel === folder || rel.startsWith(folder + '/'))) continue;
				folders.push(rel);
				await walk(full, depth + 1);
			} else if (entry.isFile() && (!extensions || extensions.has(path.extname(entry.name).toLowerCase()))) {
				files.push(rel);
			}
		}
	};
	await walk(base, 0);
	files.sort();
	folders.sort();
	return { files, folders, truncated };
}

/** The first bytes of a file: enough for frontmatter, cheap on a long document. */
async function readHead(file, bytes = 4096) {
	let handle;
	try {
		handle = await open(file, 'r');
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} catch {
		return '';
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** The MOC of one folder: `00-<folder>.md` when it exists, else the first `00-*.md` there. */
async function mocOfFolder(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return '';
	}
	const indexes = entries.filter((entry) => entry.isFile() && entry.name.startsWith('00-') && entry.name.endsWith('.md')).map((entry) => entry.name);
	if (!indexes.length) return '';
	return indexes.find((name) => name === `00-${path.basename(dir)}.md`) ?? [...indexes].sort()[0];
}

/**
 * The index that owns a note: the MOC inside its folder, else the nearest
 * ancestor MOC, else the root home (§5: every note is reachable from an index).
 * Walking up is how a note in `30-Resources/citta/giappone/tokyo/` finds
 * `00-tokyo.md` instead of landing on Home.
 */
async function indexForFolder(root, folderRel) {
	// `.` survives `dirname` chains at the root ("./x" → "."): it names the root
	// itself, and a literal segment would poison the returned path (`./00-Home.md`).
	const segments = String(folderRel ?? '').split('/').filter((part) => part && part !== '.');
	for (;;) {
		const dir = segments.length ? path.join(root, ...segments) : root;
		const name = await mocOfFolder(dir);
		if (name) return { path: [...segments, name].join('/'), level: segments.length ? 'section' : 'home' };
		if (!segments.length) return null;
		segments.pop();
	}
}

/**
 * The vault's path index for one lint pass: note keys without extension, folder
 * paths, and how many notes share each file name — which is the difference
 * between a short link Obsidian still resolves and one that points at nothing.
 */
async function buildPathIndex(root) {
	const found = await collectVaultFiles(root, { cap: LINK_SCAN_CAP });
	const keys = new Set(found.files.filter((rel) => rel.endsWith('.md')).map((rel) => rel.slice(0, -3)));
	const unique = new Map();
	for (const key of keys) {
		const base = key.split('/').pop();
		unique.set(base, (unique.get(base) ?? 0) + 1);
	}
	return { keys, folders: new Set(found.folders), unique, scanned: keys.size, truncated: found.truncated };
}

/**
 * Where the links of one note point. `broken` is nothing the vault holds;
 * `notCanonical` is a short name Obsidian resolves today by unique-basename
 * matching and the write rule forbids. Code fences and inline code are excluded —
 * an example is not a link — and material the policy declares immutable is never
 * reported, because nothing may fix it there.
 */
async function linkFindings(root, rel, text, index) {
	if (inFolders(rel, [...IMMUTABLE_LINK_DIRS, ...PROTECTED_DELETE_DIRS]) || isPolicyFile(rel)) return { broken: [], notCanonical: [] };
	const broken = new Set();
	const notCanonical = new Set();
	for (const entry of proseLines(text)) {
		const line = maskInlineCode(entry.text);
		LINK_PATTERN.lastIndex = 0;
		let match;
		while ((match = LINK_PATTERN.exec(line))) {
			const target = linkPath(match[1]);
			if (!target || target.includes('<') || target.includes('>') || target.includes('…')) continue;
			if (target.startsWith('/') || target.split('/').includes('..')) {
				broken.add(target);
				continue;
			}
			if (index.keys.has(target) || index.folders.has(target)) continue;
			const base = target.split('/').pop();
			if (!target.includes('/') && index.unique.get(base) === 1) {
				notCanonical.add(target);
				continue;
			}
			// An attachment (`.png`, `.pdf`) is a file and not a note: ask the disk.
			if (/\.[a-z0-9]{2,5}$/.test(base)) {
				// `probe` rejects paths that cannot even be built (a stray control
				// character) and folders the OS shields: a broken-looking link is a
				// warning, never a reason to abort the pass.
				let there = false;
				try {
					there = (await probe(path.join(root, target))).exists;
				} catch {
					there = false;
				}
				if (there) continue;
			}
			broken.add(target);
		}
	}
	return { broken: [...broken], notCanonical: [...notCanonical] };
}

/**
 * The note budgets of the policy, checked instead of hoped for: `summary` as the
 * retrieval key, one concept per note, kebab names without emoji, a MOC holding
 * links only, no link pointing at nothing. `hard` is what the caller refuses —
 * the summary maximum, which the real vault already respects 308 times out of
 * 308, so a refusal catches a mistake and never a style. Everything else is a
 * warning the caller can act on in the same change.
 */
async function lintNote(root, rel, text, index) {
	if (!rel.endsWith('.md') || inFolders(rel, [...IMMUTABLE_LINK_DIRS, ...PROTECTED_DELETE_DIRS]) || isPolicyFile(rel)) {
		return { hard: [], soft: [] };
	}
	const hard = [];
	const soft = [];
	const fm = frontmatterOf(text);
	const base = rel.split('/').pop();
	// An index is a MOC by type or by the `00-` convention (§2). It holds links,
	// so the note schema and the atomicity budget do not apply to it.
	const isMoc = fm.fields.type === 'moc' || base.startsWith('00-');

	if (fm.present && !fm.closed) soft.push({ code: 'frontmatter-unclosed', message: 'The frontmatter block never closes: Obsidian will show it as text.' });
	if (!fm.present) soft.push({ code: 'frontmatter-missing', message: 'No frontmatter block: the note is invisible to search and outside the schema (§1).' });

	const summary = fm.fields.summary ?? '';
	if (!summary) {
		if (fm.present) soft.push({ code: 'summary-missing', message: '`summary:` is empty: `vault_search` reads it as the retrieval key, so this note will never be found (§1).' });
	} else {
		const length = textLength(summary);
		if (length > SUMMARY_MAX) hard.push({ code: 'summary-too-long', message: `The summary is ${length} characters; the policy stops at ${SUMMARY_MAX}.`, examples: [summary] });
		else if (length > SUMMARY_TARGET) soft.push({ code: 'summary-over-target', message: `The summary is ${length} characters; the target is ${SUMMARY_TARGET}. Descriptive richness belongs in the MOC annotation (§1).` });
		if (EMOJI_PATTERN.test(summary)) soft.push({ code: 'emoji-in-key', message: 'The summary holds an emoji: retrieval is textual, decoration stays out of the vault (§2).' });
	}

	if (fm.present) {
		for (const field of ['type', 'status', 'created']) {
			if (!fm.fields[field]) soft.push({ code: 'frontmatter-field-missing', message: `\`${field}\` is empty or missing: every note carries it (§1).` });
		}
	}

	const bodyLines = text.split('\n').length - (fm.closed ? fm.end : 0);
	if (!isMoc && bodyLines > NOTE_LINE_TARGET) {
		soft.push({ code: 'not-atomic', message: `${bodyLines} lines of body: one concept is ~${NOTE_LINE_TARGET}. Split it and link the parts, or keep the long material in 90-Reference/ (§2).` });
	}

	if (!KEBAB_NAME.test(base)) soft.push({ code: 'path-not-kebab', message: `\`${base}\` is not kebab-case (CJK letters are welcome too) (§2).` });
	const odd = rel
		.split('/')
		.slice(0, -1)
		.filter((folder, depth) => !(depth === 0 && /^\d\d-[A-Z]/.test(folder)) && !/^[a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][a-z0-9._\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}-]*$/u.test(folder));
	if (odd.length) soft.push({ code: 'path-not-kebab', message: `Folder names that are not kebab-case (CJK letters are welcome too): ${odd.join(', ')} (§2).` });

	if (isMoc) {
		const prose = proseLines(text)
			.filter((entry) => entry.line > fm.end)
			.map((entry) => entry.text.trim())
			.filter((line) => line && !/^#{1,6}\s/.test(line) && !/^[-*]\s/.test(line) && !/^_.*_$/.test(line));
		if (prose.length) {
			soft.push({ code: 'moc-has-prose', message: `A MOC is an index of links (§5): ${prose.length} line${prose.length === 1 ? '' : 's'} of argument belong in a note.`, examples: prose.slice(0, 3).map((line) => line.slice(0, 120)) });
		}
	}

	const links = await linkFindings(root, rel, text, index);
	if (links.broken.length) soft.push({ code: 'broken-link', message: `${links.broken.length} link${links.broken.length === 1 ? '' : 's'} point at nothing in the vault: create the target in the same change, or drop the link (§6).`, examples: links.broken.slice(0, 6) });
	if (links.notCanonical.length) soft.push({ code: 'link-not-canonical', message: `${links.notCanonical.length} link${links.notCanonical.length === 1 ? '' : 's'} use a short name: write [[path/from/the/vault/root]], the form the tools keep correct.`, examples: links.notCanonical.slice(0, 6) });

	return { hard, soft };
}

// --- Composing a note (the storage half) -------------------------------------

/**
 * A `kebab-case` file name out of a title: accents folded away (the vault searches
 * without them), anything non-alphanumeric collapsed to `-`, plus the
 * `YYYY-MM-DD-` prefix a log note carries. Never empty: `nota` keeps a note
 * creatable even from a title made of punctuation.
 */
function slugifyTitle(title, options = {}) {
	// The slug keeps the chosen title faithful: Latin folds to kebab, and Han,
	// hiragana and katakana stay their own characters (ー and 々 are Script=Common,
	// so they are named). The second NFC pass re-composes what the fold splits:
	// kana dakuten come back whole instead of falling out as separators. Every
	// other script folds away, as it always did.
	const slug = foldText(String(title ?? '').normalize('NFC')).normalize('NFC')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}ー々]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	const base = slug || 'nota';
	return options.dated === true ? `${today()}-${base}` : base;
}

/** `{{date:YYYY-MM-DD}}` and friends, in the template syntax the vault already uses (§8). */
function formatDate(pattern) {
	const now = new Date();
	const parts = {
		YYYY: String(now.getFullYear()),
		MM: String(now.getMonth() + 1).padStart(2, '0'),
		DD: String(now.getDate()).padStart(2, '0'),
	};
	return String(pattern || 'YYYY-MM-DD').replace(/YYYY|MM|DD/g, (token) => parts[token]);
}

/** Fill the placeholders the templates use: `{{title}}`, `{{DATE}}`, `{{date:...}}`. */
function fillPlaceholders(text, values) {
	return String(text ?? '')
		.replace(/\{\{\s*date:([^}]*)\}\}/g, (_all, pattern) => formatDate(String(pattern).trim()))
		.replace(/\{\{\s*DATE\s*\}\}/g, today())
		.replace(/\{\{\s*title\s*\}\}/g, values.title ?? '')
		.replace(/\{\{\s*summary\s*\}\}/g, values.summary ?? '');
}

/** Quote a YAML scalar only when it needs it, keeping the vault's readable `source: https://…`. */
function yamlValue(value) {
	const text = String(value ?? '');
	if (!text) return '';
	const needsQuotes = /[:#\[{\]}"'`|>!*@&%]/.test(text) || /^[-?\s]/.test(text) || /\s$/.test(text);
	return needsQuotes ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

/**
 * Set one top-level frontmatter key: the template's field order wins, a key the
 * template never had is appended before the closing fence. Only lines starting at
 * column zero count, so a list written under `tags:` keeps its shape.
 */
function setFrontmatterKey(text, key, value) {
	const lines = String(text).split('\n');
	const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	if (closing < 0) return String(text);
	const isKey = new RegExp(`^${key}:(\\s|$)`);
	const rendered = value === '' ? `${key}:` : `${key}: ${value}`;
	for (let i = 1; i < closing; i++) {
		if (!isKey.test(lines[i])) continue;
		lines[i] = rendered;
		return lines.join('\n');
	}
	lines.splice(closing, 0, rendered);
	return lines.join('\n');
}

/** One MOC entry: the link form the upkeep engine keeps correct, plus a short annotation. */
function mocEntryLine(key, annotation) {
	const note = String(annotation ?? '').replace(/\s+/g, ' ').trim().slice(0, 90).replace(/[.\u2014-]+\s*$/, '');
	return note ? `- [[${key}]] \u2014 ${note}` : `- [[${key}]]`;
}

/** Append one line to a MOC, touching nothing else in it. */
function appendMocLine(text, line) {
	const body = String(text).replace(/\s+$/, '');
	return body ? `${body}\n${line}\n` : `${line}\n`;
}

/** The body of a note: heading from the title, then the model's text. */
function noteBody(title, body) {
	const tail = String(body ?? '').replace(/^\s+/, '').replace(/\s+$/, '');
	return tail ? `# ${title}\n\n${tail}\n` : `# ${title}\n`;
}

// --- Reading: search, outline, region ----------------------------------------

/**
 * The grep-first search. Metadata by default — names and `summary:`, the two keys
 * the policy defines — bodies only when asked for, and always the smallest row
 * that lets the next step be decided. No keyword at all means inventory: what a
 * folder holds, plus the index that owns it, which is the other half of
 * navigation and the reason there is no fourth tool for browsing.
 */
async function searchVault(root, options = {}) {
	const keywords = normalizeKeywords(options.keywords).map(foldText);
	const where = options.where === 'fulltext' ? 'fulltext' : 'metadata';
	const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 20)), SEARCH_ROW_CAP);
	const scope = String(options.scope ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
	const wanted = options.type ? foldText(options.type) : '';
	const excluded = SEARCH_EXCLUDE.filter((folder) => {
		if (folder === '90-Reference' && options.includeReference === true) return false;
		// A scope inside an excluded folder is a deliberate visit: policy §7 lets
		// you deepen there, it only forbids stumbling on it while searching.
		return !(scope && (scope === folder || scope.startsWith(folder + '/')));
	});
	const found = await collectVaultFiles(root, {
		scope,
		extensions: where === 'fulltext' ? SEARCH_TEXT_EXTS : new Set(['.md']),
		exclude: excluded,
	});
	const shape = {
		keywords: normalizeKeywords(options.keywords),
		...(scope ? { scope } : {}),
		scanned: found.files.length,
		...(found.truncated ? { truncated: true } : {}),
	};

	if (where === 'fulltext') {
		const scored = [];
		for (const rel of found.files) {
			const full = path.join(root, rel);
			let text;
			try {
				const info = await stat(full);
				if (info.size > SEARCH_FILE_BYTES) continue;
				text = await readFile(full, 'utf8');
			} catch {
				continue;
			}
			const hay = foldText(text);
			if (!keywords.every((keyword) => hay.includes(keyword))) continue;
			const fm = frontmatterOf(text);
			// `type` narrows both modes: a body search for notes skips templates and logs.
			if (wanted && foldText(fm.fields.type ?? '') !== wanted) continue;
			// The frontmatter is what the metadata search already answers: prefer the
			// lines of the body, and fall back to the first hit when the term only
			// lives in the summary.
			const start = fm.end;
			const lines = [];
			const body = text.split('\n');
			for (let i = start; i < body.length && lines.length < 3; i++) {
				if (!keywords.some((keyword) => foldText(body[i]).includes(keyword))) continue;
				lines.push({ line: i + 1, text: body[i].trim().slice(0, 200) });
			}
			if (!lines.length) {
				const at = body.findIndex((line) => keywords.some((keyword) => foldText(line).includes(keyword)));
				if (at >= 0) lines.push({ line: at + 1, text: body[at].trim().slice(0, 200) });
			}
			scored.push({ score: lines.length, row: { path: rel, hits: lines.length, lines } });
		}
		scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path));
		const results = scored.slice(0, limit).map((entry) => entry.row);
		return {
			mode: 'fulltext',
			...shape,
			total: scored.length,
			results,
			hint: results.length
				? scored.length > results.length
					? `${scored.length} matches in total: this is the best ${results.length}. Narrow the scope or add a keyword.`
					: 'Read only the region you need: vault_read { path, from: <line> } starts where a hit is.'
				: fulltextMissHint(excluded, scope),
		};
	}

	const scored = [];
	for (const rel of found.files) {
		const nameHay = foldText(rel.endsWith('.md') ? rel.slice(0, -3) : rel);
		const fm = frontmatterOf(await readHead(path.join(root, rel)));
		const summary = fm.fields.summary ?? '';
		const summaryHay = foldText(summary);
		let nameHits = 0;
		let summaryHits = 0;
		let ok = true;
		for (const keyword of keywords) {
			// AND across keywords, any order: every keyword must appear somewhere.
			const inName = nameHay.includes(keyword);
			const inSummary = summaryHay.includes(keyword);
			if (!inName && !inSummary) {
				ok = false;
				break;
			}
			if (inName) nameHits += 1;
			if (inSummary) summaryHits += 1;
		}
		if (!ok) continue;
		if (wanted && foldText(fm.fields.type ?? '') !== wanted) continue;
		const row = { path: rel };
		if (summary) row.summary = summary;
		if (keywords.length) {
			const matched = [];
			if (nameHits) matched.push('name');
			if (summaryHits) matched.push('summary');
			row.matched = matched;
		}
		if (fm.fields.status && fm.fields.status !== 'active') row.status = fm.fields.status;
		scored.push({ score: nameHits * 3 + summaryHits, row });
	}
	scored.sort((a, b) => b.score - a.score || a.row.path.length - b.row.path.length || a.row.path.localeCompare(b.row.path));
	const results = scored.slice(0, limit).map((entry) => entry.row);
	const out = { mode: keywords.length ? 'metadata' : 'inventory', ...shape, total: scored.length, results };

	if (!keywords.length) {
		// Inventory answers "what is here": the children, how big they are, and
		// the index the policy would read next.
		const counts = new Map();
		for (const rel of found.files) {
			const owner = rel.slice(scope ? scope.length + 1 : 0).split('/')[0];
			counts.set(owner, (counts.get(owner) ?? 0) + 1);
		}
		const folders = found.folders
			.filter((rel) => {
				const tail = rel.slice(scope ? scope.length + 1 : 0);
				return tail && !tail.includes('/');
			})
			.map((rel) => ({ path: rel, notes: counts.get(rel.slice(scope ? scope.length + 1 : 0)) ?? 0 }));
		if (folders.length) out.folders = folders;
		const index = await indexForFolder(root, scope);
		if (index) out.index = index.path;
	}

	if (results.length) {
		out.hint = scored.length > results.length ? `${scored.length} matches in total: this is the best ${results.length}. Narrow the scope or add a keyword.` : 'Read only the notes you selected: they are atomic on purpose.';
	} else if (keywords.length) {
		out.hint = `No note matches all of ${shape.keywords.join(', ')} in its name or summary. Try one keyword at a time, the singular, a synonym, or the English term${excluded.length ? ` (90-Reference/ is out of the search by policy: includeReference: true reads it)` : ''}. With nothing left, the note does not exist: create it with vault_note.`;
	}
	return out;
}

/** The miss hint of a body search: the exclusion is the usual reason. */
function fulltextMissHint(excluded, scope) {
	if (excluded.length && !(scope && excluded.some((folder) => scope === folder || scope.startsWith(folder + '/')))) {
		return 'No body matches. The whole vault was read except 90-Reference/ and 99-Templates/ (policy §7): pass includeReference: true, or set scope inside 90-Reference/, when the integral documents are what you want.';
	}
	return 'No body matches. Try one keyword at a time, the singular, or a synonym; accents are folded, spelling is not.';
}

/**
 * The headings of a document with their line numbers, fences skipped. Reading a
 * long reference file starts here, not at line 1.
 */
function outlineOf(text, cap = 200) {
	const out = [];
	let fence = false;
	String(text ?? '').split('\n').forEach((line, index) => {
		if (line.trimStart().startsWith('```')) {
			fence = !fence;
			return;
		}
		if (fence) return;
		const match = /^(#{1,6})\s+(.*)$/.exec(line);
		if (match && out.length < cap) out.push({ level: match[1].length, text: match[2].trim().slice(0, 160), line: index + 1 });
	});
	return out;
}

/**
 * One bounded slice of one file. The cap is the point: a 4000-line specification
 * is entered through a search hit or the outline, and the answer says where the
 * next chunk starts instead of pretending the file is small.
 */
async function readRegion(root, rel, options = {}) {
	const full = path.join(root, rel);
	let info;
	try {
		info = await stat(full);
	} catch {
		return { error: 'not-found', hint: 'Nothing at that path: check it with vault_search or in the Vault tab.' };
	}
	if (info.isDirectory()) return { error: 'is-directory', hint: 'That is a folder: ask for a file, or list it with vault_search { scope }.' };
	if (info.size > SEARCH_FILE_BYTES * 4) return { error: 'too-large', bytes: info.size, hint: 'Read it in regions with from/lines, or search inside it with vault_search { where: "fulltext" }.' };
	let raw;
	try {
		raw = await readFile(full, 'utf8');
	} catch {
		return { error: 'unreadable', hint: 'The file could not be read.' };
	}
	if (raw.includes('\u0000')) return { error: 'binary-file', hint: 'Not text: link the attachment from a note instead of reading it.' };
	const lines = raw.split('\n');
	const base = { path: rel, totalLines: lines.length, totalBytes: info.size };
	if (options.outline === true) return { ...base, outline: outlineOf(raw) };
	const from = Math.min(Math.max(1, Math.trunc(options.from ?? 1)), Math.max(1, lines.length));
	const count = Math.min(Math.max(1, Math.trunc(options.lines ?? READ_DEFAULT_LINES)), READ_MAX_LINES);
	const to = Math.min(lines.length, from + count - 1);
	let text = lines.slice(from - 1, to).join('\n');
	let cut = false;
	if (text.length > READ_TEXT_CAP) {
		text = text.slice(0, READ_TEXT_CAP);
		cut = true;
	}
	return {
		...base,
		from,
		to,
		text,
		hasMore: to < lines.length,
		...(to < lines.length ? { nextFrom: to + 1 } : {}),
		...(cut ? { cut: true } : {}),
	};
}

/**
 * True when some MOC links `key`: the reachability rule of policy §5, checked
 * after a write instead of assumed. Only the indexes are read, which is what
 * makes the check cheap enough to run on every note written.
 */
async function indexedBy(root, key) {
	const found = await collectVaultFiles(root, { extensions: new Set(['.md']), cap: LINK_SCAN_CAP });
	const indexes = found.files.filter((rel) => path.basename(rel).startsWith('00-'));
	for (const rel of indexes) {
		let text;
		try {
			text = await readFile(path.join(root, rel), 'utf8');
		} catch {
			continue;
		}
		for (const entry of proseLines(text)) {
			LINK_PATTERN.lastIndex = 0;
			let match;
			while ((match = LINK_PATTERN.exec(entry.text))) {
				if (linkPath(match[1]) === key) return { indexed: true, moc: rel };
			}
		}
	}
	return { indexed: false, mocs: indexes.length };
}

/** One atomic write of vault content: a reader never sees half a file. */
async function atomicWrite(target, content) {
	const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(temp, content, 'utf8');
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * §5: a section that grew past a handful of notes owns an index, and Home links
 * indexes only. Used to question a note that was just appended to Home.
 */
async function folderNeedsMoc(root, folderRel) {
	const section = String(folderRel ?? '').split('/').filter(Boolean)[0];
	if (!section) return false;
	const found = await collectVaultFiles(root, { scope: section, extensions: new Set(['.md']) });
	return found.files.filter((rel) => !path.basename(rel).startsWith('00-')).length > 3;
}

/**
 * Facts about one root — the configured one or a proposed path — for the skill
 * to judge from: the tool reports, the model decides. `exact` is the verdict of
 * the no-adaptation rubric: all section folders, a `00-Home.md` index, and no
 * other top-level folders. A folder either matches the standard structure or it
 * is not a vault; there is no in-between and `exact` is never a permission to
 * write.
 */
async function inspectRoot(root) {
	const at = await probe(root);
	if (!at.exists) return { root, state: 'missing', dirs: [], files: [], hasHome: false, hasPolicy: false, sections: [], otherDirs: [], markdownNotes: 0, exact: false, notes: ['root does not exist'] };
	if (!at.directory) return { root, state: 'populated', dirs: [], files: [], hasHome: false, hasPolicy: false, sections: [], otherDirs: [], markdownNotes: 0, exact: false, notes: ['root exists but is not a folder'] };
	const entries = await readdir(root, { withFileTypes: true });
	const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
	if (entries.length === 0) return { root, state: 'empty', dirs: [], files: [], hasHome: false, hasPolicy: false, sections: [], otherDirs: [], markdownNotes: 0, exact: false, notes: ['folder exists and is empty'] };
	const sections = SECTIONS.filter((section) => dirs.includes(section));
	const otherDirs = dirs.filter((dir) => !SECTIONS.includes(dir) && !dir.startsWith('.'));
	const hasHome = files.includes('00-Home.md');
	const hasPolicy = files.includes('POLICY.md');
	const exact = hasHome && sections.length === SECTIONS.length && otherDirs.length === 0;
	const notes = [];
	if (!hasHome) notes.push('no 00-Home.md index at the root');
	if (sections.length < SECTIONS.length) notes.push('missing standard folders: ' + SECTIONS.filter((section) => !sections.includes(section)).join(', '));
	if (otherDirs.length > 0) notes.push('top-level folders outside the standard structure: ' + otherDirs.slice(0, 8).join(', '));
	if (dirs.includes('99-AI')) notes.push('legacy 99-AI folder present; this structure keeps POLICY.md at the root');
	return {
		root,
		state: 'populated',
		dirs,
		files: files.slice(0, 60),
		hasHome,
		hasPolicy,
		sections,
		otherDirs,
		markdownNotes: files.filter((file) => file.endsWith('.md')).length,
		exact,
		notes,
	};
}

/**
 * Persist one field of this row's config through the Loader path. `root` is
 * volatile, so writing it changes the listing without re-activating the row;
 * `skillSetup` is not, so writing it re-applies the row — callers finish their
 * own work first. `false` means no config editor or no addressable row, not a
 * rejected value.
 */
async function writeConfig(ctx, patch) {
	const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : ctx.configEditor;
	if (!editor) return false;
	const entry = editor.entries().find((candidate) => (candidate.options && candidate.options.id === ROW_ID) || candidate.id === ROW_ID);
	if (!entry) return false;
	await editor.edit(entry, (current) => Object.assign({}, current || {}, patch));
	return true;
}

/** Create the missing folders and seed files of a vault; existing files win. */
async function scaffold(root) {
	const createdDirs = [];
	const createdFiles = [];
	const skipped = [];
	for (const section of SECTIONS) {
		const target = path.join(root, section);
		if ((await probe(target)).exists) skipped.push(section + '/');
		else {
			await mkdir(target, { recursive: true });
			createdDirs.push(section + '/');
		}
	}
	for (const seed of SEEDS) {
		const target = path.join(root, seed.rel);
		if ((await probe(target)).exists) {
			skipped.push(seed.rel);
			continue;
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, await readAsset(seed.asset), 'utf8');
		createdFiles.push(seed.rel);
	}
	return { createdDirs, createdFiles, skipped };
}

/** Model-facing contract; kept short because it is read on every request. */
const TOOL_DESCRIPTION =
	'Set up or adopt the vault folder that the Vault Tab plugin lists. Plugin Host code performs the work, ' +
	'so it also works when the Session is read-only or workspace-write, where the Session’s own write, edit ' +
	'and bash tools are denied on these paths. Use the vault-setup skill for the order of operations. ' +
	'Actions: inspect (read-only facts about a root; an optional path judges a candidate folder without ' +
	'moving the plugin root), create (seed the PARA structure; a path also moves the plugin root there), ' +
	'set-root (point the plugin at an existing absolute path), write-policy (write POLICY.md at the root; ' +
	'an existing one is never replaced), hide-skill (retire the setup skill). create, set-root and ' +
	'write-policy require confirm: true, set only after the user agreed to that specific write.';

function setupTool(ctx, config) {
	return {
		name: 'vault_setup',
		description: TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['inspect', 'create', 'set-root', 'write-policy', 'hide-skill'],
					description: 'Which setup step to run.',
				},
				path: {
					type: 'string',
					description: 'Absolute vault path (empty: the plugin’s configured root). Used by inspect, create and set-root.',
				},
				confirm: {
					type: 'boolean',
					description: 'Must be true for create, set-root and write-policy: the user agreed to this write.',
				},
			},
			required: ['action'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					error: { type: 'string', description: 'Failure code; only present when the action did nothing.' },
					action: { type: 'string' },
					root: { type: 'string', description: 'Vault folder the result refers to.' },
				},
				additionalProperties: true,
			},
			render(args, value) {
				return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
			},
		},
		async execute(args) {
			const action = args && args.action;
			const configured = resolveRoot(currentValue(config && config.root));
			if (action === 'inspect') {
				const at = args.path === void 0 || String(args.path).trim() === '' ? configured : absolutePath(args.path);
				if (!at) return { action, error: 'path-must-be-absolute' };
				return Object.assign({ action }, await inspectRoot(at));
			}

			if (action === 'hide-skill') {
				// Retire the live registration directly: the volatile write below
				// also reaches `syncSkill` through the loader event, and both paths
				// are idempotent.
				const hidden = typeof skillOff === 'function' ? skillOff() : false;
				let persisted = false;
				try {
					persisted = await writeConfig(ctx, { skillSetup: false });
				} catch (error) {
					persisted = false;
				}
				return { action, hidden, persisted };
			}

			if (action !== 'create' && action !== 'set-root' && action !== 'write-policy') return { action, error: 'unknown-action' };
			if (args.confirm !== true) return { action, error: 'confirmation-required' };
			const target = args.path === void 0 || String(args.path).trim() === '' ? configured : absolutePath(args.path);
			if (!target) return { action, error: 'path-must-be-absolute' };
			if (NEVER_ROOTS.has(target)) return { action, root: target, error: 'path-not-usable-as-vault' };

			if (action === 'set-root') {
				const at = await probe(target);
				if (!at.exists) return { action, root: target, error: 'path-missing' };
				if (!at.directory) return { action, root: target, error: 'path-not-a-folder' };
				if (target === configured) return { action, root: target, changed: false, persisted: false };
				return { action, root: target, changed: true, persisted: await writeConfig(ctx, { root: target }) };
			}

			if (action === 'write-policy') {
				const at = await probe(target);
				if (!at.exists || !at.directory) return { action, root: target, error: 'vault-folder-missing' };
				const policy = path.join(target, 'POLICY.md');
				const existed = (await probe(policy)).exists;
				if (existed) return { action, root: target, path: policy, exists: true, written: false, error: 'policy-exists' };
				await writeFile(policy, await readAsset('vault-policy.md'), 'utf8');
				return { action, root: target, path: policy, existed, written: true };
			}

			// create: an empty or missing folder is seeded; a folder that already
			// carries a home index or a policy is a vault, so the missing pieces of
			// the structure are added without touching what exists (a re-run after a
			// partial seed must not need a delete). Anything else stays untouched.
			const at = await probe(target);
			if (at.exists && !at.directory) return { action, root: target, error: 'path-not-a-folder' };
			let completed = false;
			if (at.exists) {
				const entries = await readdir(target, { withFileTypes: true });
				if (entries.length > 0) {
					const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
					if (!files.includes('00-Home.md') && !files.includes('POLICY.md')) {
						// Facts for the model: what a seeded vault would add here. Checked
						// on disk rather than against the top-level names, since seeds nest.
						const missing = [];
						for (const section of SECTIONS) if (!entries.some((entry) => entry.isDirectory() && entry.name === section)) missing.push(section + '/');
						for (const seed of SEEDS) if (!(await probe(path.join(target, seed.rel))).exists) missing.push(seed.rel);
						return { action, root: target, error: 'folder-not-empty', entries: entries.length, missing, hint: 'inspect it, then adopt it with write-policy' };
					}
					completed = true;
				}
			}
			await mkdir(target, { recursive: true });
			const seeded = await scaffold(target);
			const rootChanged = target !== configured;
			return Object.assign({ action }, seeded, { root: target, completed, rootChanged, rootPersisted: rootChanged ? await writeConfig(ctx, { root: target }) : false });
		},
	};
}

/** Unregister closure of the live setup-skill registration, while one is installed. */
let skillOff = null;

/** Bring the live registration in line with the (volatile) `skillSetup` flag. */
function syncSkill(ctx, config) {
	if (!ctx) return;
	const want = currentValue(config && config.skillSetup) !== false;
	if (want) {
		if (!skillOff) registerSetupSkill(ctx);
	} else if (skillOff) skillOff();
}

const SKILL_NAME = 'vault-setup';
const SKILL_DESCRIPTION = 'Create or adopt the vault folder that the Vault Tab plugin lists: check the configured path, seed the PARA structure, write the root POLICY.md.';
const SKILL_WHEN_TO_USE = 'Use when the vault path is missing, empty or not yet trusted, or when the user asks to set up, initialise, adopt, move or re-check a vault folder.';

const NOTE_SKILL_NAME = 'vault-write';
const NOTE_SKILL_DESCRIPTION = 'Write into the vault with the vault tools: rules first (root POLICY.md, then the target folder’s POLICY.md); a note created and indexed in one call, files written and replaced, rename/move with link upkeep, deletion behind a link check, the policy warnings the tools answer with; the Vault Grant and what to do when writing is refused.';
const NOTE_SKILL_WHEN_TO_USE = 'Use whenever something in the vault should change: save or jot down a note, file an idea, add or update a note, MOC line or log, rename or move a file or folder, delete a note — even when the user does not say “vault” but means their second brain.';

const READ_SKILL_NAME = 'vault-read';
const READ_SKILL_DESCRIPTION = 'Retrieve from the vault with the read tools: grep-first over file names and summaries with minimal context, inventory of a folder, full text with line numbers, 90-Reference only for deepening — and store what the vault does not have as one atomic, indexed note.';
const READ_SKILL_WHEN_TO_USE = 'Use whenever something in the vault should be found or remembered: answer from the second brain, look up a note, check what is already known before writing it, save a fact, decision or idea, file what you just learned — even when the user does not say “vault” or “search”.';

const GIT_SKILL_NAME = 'vault-git';
const GIT_SKILL_DESCRIPTION = 'Commit the vault git working tree with the vault_git tool: an integrity audit first (valid links, policy budgets), commits only on the user’s explicit word, unrelated topics split into separate commits with brief indicative messages, never a push or a rewrite.';
const GIT_SKILL_WHEN_TO_USE = 'Use when the user asks to commit the vault, save its changes to git, checkpoint them, or check whether pending vault changes are safe to commit — even when they say “salva in git” without naming the vault. A request to change the vault never implies this one.';

/** Model-facing contract of the write tool; short because it is read on every request. */
const WRITE_TOOL_DESCRIPTION =
	'Write one UTF-8 file inside the vault folder configured in the Vault Tab plugin. Plugin Host code performs ' +
	'the write, so it also works while the Session is workspace-write, where the Session’s own write, edit and ' +
	'bash tools are denied outside its workspace. The path is relative to the vault root and cannot leave it. ' +
	'Writing needs the user’s Vault Grant, decided in the composer beside the permission selector: when the ' +
	'tool reports the grant is off or the Session is read-only, tell the user instead of retrying, and never ' +
	'fall back to bash or the native write. For a note prefer vault_note, which composes the frontmatter '
	'and the MOC line; this tool writes the files a note is not. The content is checked against the vault '
	'policy: a summary over its maximum is refused, the other rule breaks come back as warnings '
	'(lint: "off" skips them).';

function writeTool(ctx, config) {
	return {
		name: 'vault_write',
		description: WRITE_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File inside the vault root, relative to it, for example 30-Resources/nota.md.' },
				content: { type: 'string', description: 'Complete new content of the file, UTF-8 text.' },
				overwrite: { type: 'boolean', description: 'True replaces an existing file: read it first, then pass the whole new content.' },
				lint: {
					type: 'string',
					enum: ['warn', 'off'],
					description: 'Policy check on the content: default "warn" refuses a summary over the maximum and answers with the other rule breaks; "off" writes without checking.',
				},
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Written path, relative to the vault root.' },
					bytes: { type: 'integer', description: 'Bytes written.' },
					action: { type: 'string', enum: ['created', 'replaced'], description: 'Whether the file already existed.' },
					root: { type: 'string', description: 'Absolute vault root the path is under.' },
					warnings: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								code: { type: 'string', description: 'Which rule, e.g. not-atomic or broken-link.' },
								message: { type: 'string', description: 'What to fix, in one line.' },
								examples: { type: 'array', items: { type: 'string' } },
							},
							additionalProperties: false,
						},
						description: 'Rules the content breaks: written anyway, meant to be fixed in the same change.',
					},
					error: { type: 'string', description: 'Refusal reason, when nothing was written.' },
					hint: { type: 'string', description: 'What to do instead, when nothing was written.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => [
				{
					type: 'text',
					text: value.error
						? `vault_write refused (${value.error}): ${value.hint ?? ''}`.trimEnd()
						: `vault_write ${value.action} ${value.path} (${value.bytes} bytes)${value.warnings?.length ? ` | ${value.warnings.length} policy warning${value.warnings.length === 1 ? '' : 's'}: ${value.warnings.map((entry) => entry.code).join(', ')}` : ''}`,
				},
			],
		},
		// Two writes on one file cannot be ordered, and the tool is the boundary.
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const gate = await mutationGate(ctx, config, exec, 'vault_write');
			if (gate.error) return gate;
			const root = gate.root;
			const confined = await confinePath(root, args.path);
			if (confined.error) return { error: confined.error, hint: PATH_HINT };
			const bytes = Buffer.byteLength(String(args.content ?? ''), 'utf8');
			if (bytes > MAX_WRITE_BYTES) return { error: 'too-large', bytes, hint: `The limit is ${MAX_WRITE_BYTES} bytes.` };
			const existing = await probe(confined.target);
			if (existing.directory) return { error: 'is-directory', path: confined.target, hint: 'Choose a file path, not a folder.' };
			if (existing.exists && args.overwrite !== true) return { error: 'exists', hint: 'Read the file, then send the complete new content with overwrite: true.' };
			const rel = relPath(root, confined.target);
			// The write budgets of the policy are checked here rather than hoped for: the vault stays
			// searchable only while its summaries stay retrieval keys and its notes stay atomic. The
			// maximum is the one refusal — the real vault broke it 0 times out of 308, so it catches a
			// mistake and never a style — the rest comes back as warnings the same change fixes.
			let warnings = [];
			if (args.lint !== 'off') {
				// The lint never aborts a write: a pathological vault answers with a warning, not an exception.
				let verdict;
				try {
					verdict = await lintNote(root, rel, String(args.content ?? ''), await buildPathIndex(root));
				} catch (error) {
					verdict = { hard: [], soft: [{ code: 'lint-unavailable', message: `Policy lint could not run (${String((error && error.message) || error)}): check the note against POLICY.md by hand.` }] };
				}
				if (verdict.hard.length) {
					return {
						error: 'policy-violation',
						path: rel,
						warnings: verdict.hard,
						hint: `${verdict.hard[0].message} Shorten it, or repeat with lint: "off" only when the vault intends that exception.`,
					};
				}
				warnings = verdict.soft;
			}
			// Re-check containment immediately before the syscalls: the checked
			// path must be the written one, and an ancestor symlink may have been
			// swapped since the first pass.
			const fresh = await confinePath(root, args.path);
			if (fresh.error || fresh.target !== confined.target) return { error: 'outside-root', hint: 'The path changed while writing; nothing was written.' };
			try {
				await atomicWrite(fresh.target, String(args.content ?? ''));
			} catch (error) {
				return { error: 'write-failed', hint: String((error && error.message) || error) };
			}
			// A note no index links is a file, not knowledge (§5). New notes only: a replace was
			// indexed when it was born, and an index, a policy or the exempt folders are not notes.
			if (args.lint !== 'off' && !existing.exists && rel.endsWith('.md') && !path.basename(rel).startsWith('00-') && !isPolicyFile(rel) && !inFolders(rel, [...IMMUTABLE_LINK_DIRS, ...PROTECTED_DELETE_DIRS])) {
				if (!(await indexedBy(root, rel.slice(0, -3))).indexed) {
					warnings = [...warnings, { code: 'not-indexed', message: 'No MOC links this note: add one line to the index that owns the folder (§5), or create it with vault_note, which does it.' }];
				}
			}
			return {
				path: rel,
				bytes,
				action: existing.exists ? 'replaced' : 'created',
				...(warnings.length ? { warnings } : {}),
				root,
			};
		},
	};
}

/** Model-facing contract of the move tool; short because it is read on every request. */
const MOVE_TOOL_DESCRIPTION =
	'Rename or move one file or folder inside the vault: both paths are relative to the vault root and ' +
	'neither can leave it, and a folder moves with everything under it. The `[[…]]` links that point at the ' +
	'old path are kept correct by this tool: by default every `[[old]]` and `[[old/…]]` in the vault becomes ' +
	'the new path, code fences excluded, and the answer lists the files it changed. Pass links "report" to ' +
	'move without rewriting and list the referrers instead, or dryRun to see the plan without touching ' +
	'anything. Hits inside an immutable folder are reported, never rewritten. Needs the user’s Vault Grant.';

/** Collapse per-line link hits into one entry per file, for the compact `untouchable` list. */
function foldHits(entries) {
	const byPath = new Map();
	for (const entry of entries) byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1);
	return [...byPath].map(([hitPath, hits]) => ({ path: hitPath, hits }));
}

/**
 * The link part of a move answer, in the one shape each kind needs. `plan` says
 * what a dry run would rewrite, `applied` what it did rewrite, `report` what is
 * left pointing at the old path. The scan and the rewrite return different
 * fields, so the kind is passed in rather than guessed from what is missing.
 */
function upkeepFields(mode, kind, data) {
	if (mode === 'off') return { linksMode: 'off' };
	const immutable = data.immutable ? foldHits(data.immutable) : (data.untouchable ?? []);
	const fields = {
		linksMode: mode,
		linksScanned: data.scanned,
		...(data.truncated ? { linksTruncated: true } : {}),
		...(immutable.length ? { untouchable: immutable } : {}),
	};
	if (kind === 'applied') {
		if (data.changed.length) fields.changed = data.changed;
		if (data.failed.length) fields.failed = data.failed;
	} else if (kind === 'plan') {
		const would = foldHits([...data.referrers, ...data.immutable]);
		if (would.length) fields.changed = would;
	} else if (data.referrers.length) {
		fields.referrers = data.referrers;
	}
	return fields;
}

function moveTool(ctx, config) {
	return {
		name: 'vault_move',
		description: MOVE_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				from: { type: 'string', description: 'Existing file or folder inside the vault root, relative to it.' },
				to: { type: 'string', description: 'New path inside the vault root, relative to it. A path in the same folder is a pure rename.' },
				overwrite: { type: 'boolean', description: 'True replaces an existing file at the target. A folder is never merged into or replaces another folder.' },
				links: {
					type: 'string',
					enum: ['auto', 'report', 'off'],
					description: 'What to do with the `[[…]]` links pointing at the old path. Default "auto" rewrites them; "report" leaves them and lists the referrers; "off" does neither.',
				},
				dryRun: { type: 'boolean', description: 'True reports what the move and the link upkeep would do, without touching the vault. Reading needs no grant.' },
			},
			required: ['from', 'to'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					from: { type: 'string', description: 'Old path, relative to the vault root.' },
					to: { type: 'string', description: 'New path, relative to the vault root.' },
					kind: { type: 'string', enum: ['file', 'directory'], description: 'What moved.' },
					action: { type: 'string', enum: ['renamed', 'moved'], description: 'Renamed keeps the parent folder, moved changes it.' },
					replaced: { type: 'boolean', description: 'True when an existing file at the target was replaced.' },
					dryRun: { type: 'boolean', description: 'True when nothing was touched: the answer is the plan.' },
					linksMode: { type: 'string', enum: ['auto', 'report', 'off'], description: 'The link behaviour that was applied.' },
					linksScanned: { type: 'integer', description: 'Notes read to look for links.' },
					linksTruncated: { type: 'boolean', description: 'True when the scan stopped at its cap: the vault is bigger than the sample.' },
					changed: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, hits: { type: 'integer' } },
							additionalProperties: false,
						},
						description: 'Notes whose links were rewritten, and how many each held.',
					},
					referrers: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } },
							additionalProperties: false,
						},
						description: 'Notes still pointing at the old path, as file:line samples.',
					},
					untouchable: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, hits: { type: 'integer' } },
							additionalProperties: false,
						},
						description: 'Notes holding links the tool may not rewrite (immutable folders). They stay broken: ask the user.',
					},
					failed: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, reason: { type: 'string' } },
							additionalProperties: false,
						},
						description: 'Notes whose link rewrite did not happen; the move itself is already done.',
					},
					root: { type: 'string', description: 'Absolute vault root both paths are under.' },
					error: { type: 'string', description: 'Refusal reason, when nothing moved.' },
					hint: { type: 'string', description: 'What to do instead, when nothing moved.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => {
				if (value.error) {
					return [{ type: 'text', text: `vault_move refused (${value.error}): ${value.hint ?? ''}`.trimEnd() }];
				}
				const upkeep =
					value.linksMode === 'off'
						? ''
						: value.linksMode === 'auto'
							? ` | links: ${(value.changed ?? []).reduce((sum, entry) => sum + entry.hits, 0)} ${value.dryRun ? 'would be rewritten' : 'rewritten'} in ${(value.changed ?? []).length} notes`
							: ` | links: ${(value.referrers ?? []).length} notes still point at the old path`;
				const verb = value.dryRun ? (value.action === 'renamed' ? 'rename' : 'move') : value.action;
				return [
					{
						type: 'text',
						text:
							`${value.dryRun ? 'vault_move would ' : 'vault_move '}${verb} ${value.from} → ${value.to} (${value.kind}${value.replaced === true ? ', replacing the file that was there' : ''})` +
							`${value.untouchable?.length ? ` | ${value.untouchable.length} notes hold links this tool may not fix` : ''}` +
							`${value.failed?.length ? ` | links FAILED in ${value.failed.length} notes` : ''}` +
							upkeep,
					},
				];
			},
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const dry = args.dryRun === true;
			// A plan only reads the vault, so it runs without the grant: the user can
			// see the blast radius of a move before deciding anything.
			const gate = dry ? await readGate(ctx, config) : await mutationGate(ctx, config, exec, 'vault_move');
			if (gate.error) return gate;
			const root = gate.root;
			const linksMode = args.links === 'report' || args.links === 'off' ? args.links : 'auto';
			const source = await confinePath(root, args.from);
			if (source.error) return { error: source.error, hint: PATH_HINT };
			const target = await confinePath(root, args.to);
			if (target.error) return { error: target.error, hint: PATH_HINT };
			if (source.target === root) return { error: 'is-root', hint: 'The vault root itself is never moved; change the path in Plugins → Vault Tab.' };
			if (source.target === target.target) return { error: 'same-path', hint: 'Both paths resolve to the same entry; nothing was done.' };
			const here = await probe(source.target);
			if (!here.exists) return { error: 'not-found', hint: 'Check the path with glob or in the Vault tab; nothing was moved.' };
			if (here.directory && target.target.startsWith(source.target + path.sep)) {
				return { error: 'into-itself', hint: 'A folder cannot move inside itself; choose a target outside it.' };
			}
			const there = await probe(target.target);
			if (there.directory) return { error: 'target-is-directory', hint: 'The target is a folder, and folders are never merged: choose a name inside it.' };
			if (there.exists && args.overwrite !== true) return { error: 'exists', hint: 'Choose another target, or pass overwrite: true to replace that file.' };
			const fromRel = relPath(root, source.target);
			const toRel = relPath(root, target.target);
			// Links carry no extension, so upkeep compares and writes the key form:
			// `30-Resources/parigi`, never `30-Resources/parigi.md`.
			const fromKey = linkPath(fromRel);
			const toKey = linkPath(toRel);
			const shape = {
				from: fromRel,
				to: toRel,
				kind: here.directory ? 'directory' : 'file',
				action: path.dirname(source.target) === path.dirname(target.target) ? 'renamed' : 'moved',
				root,
			};
			if (dry) {
				const plan = await scanLinks(root, fromKey, here.directory);
				return { ...shape, dryRun: true, ...upkeepFields(linksMode, linksMode === 'report' ? 'report' : 'plan', plan) };
			}
			// Both paths are verified again immediately before the syscall, exactly
			// as the write does: the verified paths must be the ones `rename` sees.
			const freshFrom = await confinePath(root, args.from);
			const freshTo = await confinePath(root, args.to);
			if (freshFrom.error || freshTo.error || freshFrom.target !== source.target || freshTo.target !== target.target) {
				return { error: 'outside-root', hint: 'A path changed while moving; nothing was moved.' };
			}
			try {
				await mkdir(path.dirname(freshTo.target), { recursive: true });
				if (there.exists) {
					// The replaced file steps aside first: if the rename fails it goes back,
					// and a failed move never destroys the file it was replacing.
					const aside = freshTo.target + '.dsh-replaced-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
					await rename(freshTo.target, aside);
					try {
						await rename(freshFrom.target, freshTo.target);
					} catch (error) {
						await rename(aside, freshTo.target).catch(() => {});
						throw error;
					}
					await rm(aside, { force: true }).catch(() => {});
				} else {
					await rename(freshFrom.target, freshTo.target);
				}
			} catch (error) {
				return failureOf(error, there.exists ? 'target' : 'source');
			}
			const moved = { ...shape, ...(there.exists ? { replaced: true } : {}) };
			if (linksMode === 'off') return { ...moved, linksMode };
			// The rename is the fact; the upkeep follows it, so a failed rewrite leaves
			// a correctly moved file with stale links — reported, not hidden.
			const upkeep = linksMode === 'auto' ? await applyLinkRewrite(root, fromKey, toKey, here.directory) : await scanLinks(root, fromKey, here.directory);
			return { ...moved, ...upkeepFields(linksMode, linksMode === 'auto' ? 'applied' : 'report', upkeep) };
		},
	};
}

/** Model-facing contract of the delete tool: the destructive one, so its cost is stated up front. */
const DELETE_TOOL_DESCRIPTION =
	'Delete one file or folder inside the vault root. There is no trash and no undo: the content is gone, ' +
	'and a folder takes everything under it. The `[[…]]` links are checked first. Nothing points at the ' +
	'path → a file goes at once. Something points at it → refused with the referrers, and force only after ' +
	'the user saw them and chose to go ahead. A folder, or anything in the vault’s template folders, always ' +
	'needs a confirm the user gave for that exact path: links point at the notes inside a folder, never at ' +
	'the folder, so a clean check says nothing about it. Needs the user’s Vault Grant.';

function deleteTool(ctx, config) {
	return {
		name: 'vault_delete',
		description: DELETE_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File or folder inside the vault root, relative to it.' },
				recursive: { type: 'boolean', description: 'True deletes a folder together with everything under it. Never needed for a file.' },
				confirm: { type: 'boolean', description: 'Must be true for a folder or a template folder, and only after the user agreed to delete this exact path.' },
				force: { type: 'boolean', description: 'True deletes although notes link this path. Only after the user was shown the referrers and chose to proceed.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Deleted path, relative to the vault root.' },
					kind: { type: 'string', enum: ['file', 'directory'], description: 'What was deleted.' },
					entries: { type: 'integer', description: 'How many entries a deleted folder held.' },
					linksScanned: { type: 'integer', description: 'Notes read for the link check.' },
					linksTruncated: { type: 'boolean', description: 'True when the scan stopped at its cap: the check is partial.' },
					referrers: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } },
							additionalProperties: false,
						},
						description: 'Notes that link this path, as file:line samples. Show them to the user.',
					},
					untouchable: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, hits: { type: 'integer' } },
							additionalProperties: false,
						},
						description: 'Links inside immutable folders: nothing can rewrite them, so deleting leaves a broken reference for good.',
					},
					forced: { type: 'boolean', description: 'True when links existed and the caller forced the delete.' },
					root: { type: 'string', description: 'Absolute vault root the path is under.' },
					error: { type: 'string', description: 'Refusal reason, when nothing was deleted.' },
					hint: { type: 'string', description: 'What to do instead, when nothing was deleted.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => [
				{
					type: 'text',
					text: value.error
						? `vault_delete refused (${value.error}): ${value.hint ?? ''}`.trimEnd()
						: `vault_delete deleted ${value.path} (${value.kind}${value.entries === void 0 ? '' : `, ${value.entries} entries`}${value.forced ? ', linked notes were forced' : ''}). ${value.hint ?? ''}`.trimEnd(),
				},
			],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const gate = await mutationGate(ctx, config, exec, 'vault_delete');
			if (gate.error) return gate;
			const root = gate.root;
			const confined = await confinePath(root, args.path);
			if (confined.error) return { error: confined.error, hint: PATH_HINT };
			if (confined.target === root) return { error: 'is-root', hint: 'The vault root itself is never deleted; change the path in Plugins → Vault Tab.' };
			const at = await probe(confined.target);
			if (!at.exists) return { error: 'not-found', hint: 'Nothing was deleted.' };
			if (at.directory && args.recursive !== true) return { error: 'is-directory', hint: 'Pass recursive: true to delete the folder and everything under it.' };
			const rel = relPath(root, confined.target);
			let entries;
			if (at.directory) {
				try {
					entries = (await readdir(confined.target)).length;
				} catch {
					entries = void 0;
				}
			}
			// The link check runs before any agreement is asked for: an orphan file is
			// routine debris and goes without a round trip, while a linked one is a
			// decision about other notes and belongs to the user.
			const links = await scanLinks(root, linkPath(rel), at.directory, rel);
			const linkFields = {
				linksScanned: links.scanned,
				...(links.truncated ? { linksTruncated: true } : {}),
				...(links.referrers.length ? { referrers: links.referrers } : {}),
				...(links.immutable.length ? { untouchable: foldHits(links.immutable) } : {}),
			};
			if (links.hits > 0 && args.force !== true) {
				return {
					error: 'linked',
					hint: `${links.hits} link${links.hits === 1 ? '' : 's'} in ${new Set([...links.referrers, ...links.immutable].map((hit) => hit.path)).size} note${new Set([...links.referrers, ...links.immutable].map((hit) => hit.path)).size === 1 ? '' : 's'} still point here. Show them to the user: move or rewrite the referrers first, or delete with force: true if the user accepts the broken links.`,
					...linkFields,
				};
			}
			// A folder or a template folder is worth a confirm even when nothing links
			// it, and the user’s agreement stays the last gate before the removal.
			const structural = at.directory || inFolders(rel, PROTECTED_DELETE_DIRS);
			if (structural && args.confirm !== true) {
				return {
					error: 'needs-confirm',
					hint: at.directory
						? `This is a folder (${entries ?? 'unknown'} entries inside). Nothing links it, but a folder holds its whole subtree: ask the user to confirm this exact path, then repeat with confirm: true.`
						: 'This sits in a folder the vault uses as machinery, not as a note: ask the user to confirm this exact path, then repeat with confirm: true.',
					...linkFields,
				};
			}
			const fresh = await confinePath(root, args.path);
			if (fresh.error || fresh.target !== confined.target) return { error: 'outside-root', hint: 'The path changed while deleting; nothing was deleted.' };
			try {
				await rm(fresh.target, { recursive: at.directory, force: true });
			} catch (error) {
				return failureOf(error, 'target');
			}
			// A forced delete leaves the lines that pointed here: say so, with the
			// list, instead of letting the vault keep a silent broken link (policy 5).
			const pointing = new Set([...links.referrers, ...links.immutable].map((hit) => hit.path));
			return {
				path: relPath(root, fresh.target),
				kind: at.directory ? 'directory' : 'file',
				...(entries === void 0 ? {} : { entries }),
				...(links.hits > 0
					? {
						forced: true,
						hint: `${pointing.size} note${pointing.size === 1 ? '' : 's'} still link${pointing.size === 1 ? 's' : ''} this path (${[...pointing].slice(0, 3).join(', ')}): rewrite those lines with vault_write now, or the vault keeps a broken link.`,
					}
				: {}),
				...linkFields,
				root,
			};
		},
	};
}

/** Model-facing contract of the read-only info tool; short, read on every request. */
const INFO_TOOL_DESCRIPTION =
	'Read-only facts about the vault the Vault Tab plugin manages, for the rules-first write flow: the ' +
	'absolute vault root and write root, whether the vault keeps a POLICY.md at its root (with its path, ' +
	'to read with the normal tools), this session’s Vault Grant state, and — with include "default-policy" ' +
	'— the plugin’s default vault policy text for vaults that have none of their own. Writes nothing.';

/** The lightweight companion of `vault_write`: locate the rules, check the grant, cost nothing. */
function infoTool(ctx, config) {
	return {
		name: 'vault_info',
		description: INFO_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				include: {
					type: 'string',
					enum: ['default-policy'],
					description: 'Also return the plugin’s default policy text; set it only when the vault has no POLICY.md at its root.',
				},
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					root: { type: 'string', description: 'Absolute folder the Vault tab lists.' },
					writeRoot: { type: 'string', description: 'Absolute folder vault_write may write.' },
					exists: { type: 'boolean', description: 'Whether the write root currently exists as a folder.' },
					hasPolicy: { type: 'boolean', description: 'True when POLICY.md sits at the vault root.' },
					policyPath: { type: 'string', description: 'Absolute path of the root POLICY.md, when it exists.' },
					defaultPolicy: { type: 'string', description: 'The plugin’s default policy text, when requested and the vault has none.' },
					grant: {
						type: 'object',
						properties: {
							mode: { type: 'string', description: 'Session permission mode: read-only, workspace-write or danger-full-access. Omitted when no live session answers.' },
							allowed: { type: 'boolean', description: 'Whether vault_write would write right now.' },
							editable: { type: 'boolean', description: 'Whether the user can toggle the Vault Grant in this mode.' },
						},
					},
					error: { type: 'string', description: 'Refusal reason, when something could not be reported.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const root = resolveRoot(currentValue(config.root));
			const writeRoot = writeRootOf(config);
			const at = await probe(writeRoot);
			const policy = path.join(writeRoot, 'POLICY.md');
			const policyAt = await probe(policy);
			const hasPolicy = policyAt.exists && !policyAt.directory;
			const state = exec.agent ? grantState(ctx, exec.agent.session, grantDefault(config)) : { mode: null, allowed: false, editable: false };
			const out = {
				root,
				writeRoot,
				exists: at.directory,
				hasPolicy,
				...(hasPolicy ? { policyPath: policy } : {}),
				// `null` has no place in the output schema, whose subset allows one
				// type per node: a mode that does not exist is simply omitted.
				grant: { ...(state.mode ? { mode: state.mode } : {}), allowed: state.allowed, editable: state.editable },
			};
			if (args?.include === 'default-policy') {
				if (hasPolicy) out.error = 'vault-has-own-policy';
				else {
					try {
						out.defaultPolicy = await readAsset('vault-policy.md');
					} catch (error) {
						out.error = 'default-policy-unavailable';
					}
				}
			}
			return out;
		},
	};
}

// --- Vault git -----------------------------------------------------------------
//
// The vault's history belongs to the user, and its policy (§10) is blunt: a
// request to change something never implies a commit, and nothing repairs a
// mistake by rewriting history. So this tool runs a fixed vocabulary —
// `status`, `audit`, `commit` — through argv, never a shell string: `push`,
// `reset`, `amend` and `rebase` are not merely discouraged, they are not
// reachable. On top of the Vault Grant, `commit` holds two more locks: an
// integrity audit whose token proves the tree was not touched since it passed,
// and `confirm: true` the user gave for that exact plan of commits.

/** Files one `status` reports; the count is exact, the list is the first `cap`. */
const GIT_FILE_CAP = 500;

/** Commits one `commit` call may carry; a bigger plan is one call away. */
const GIT_COMMIT_CAP = 20;

/** Code points in a commit message's first line: "breve e indicativo" has a number. */
const GIT_SUBJECT_MAX = 120;

/** git itself, always: fixed binary, fixed directory, no shell, no ambient locale. */
function runGit(root, args, { allowFail = false } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			['-C', root, ...args],
			{ encoding: 'utf8', maxBuffer: 4 << 20, timeout: 30_000, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } },
			(error, stdout, stderr) => {
				if (!error) return resolve(String(stdout ?? ''));
				if (allowFail) return resolve(null);
				reject(new Error(String((stderr && stderr.trim()) || error.message || 'git failed').slice(0, 400)));
			},
		);
	});
}

/**
 * The check every git action starts with: the write root must be the top of a
 * repository. A vault nested inside a bigger repo is refused — committing there
 * would speak for material outside the vault — and so is a folder with no git
 * at all: initializing a repository is the user's decision, not a side effect.
 */
async function vaultRepo(root) {
	const top = await runGit(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
	if (top === null) return { error: 'not-a-repo', hint: 'The vault folder is not a git repository (or git is unavailable): ask the user to create one, the tool never writes .git/.' };
	const realTop = await realpath(top.trim()).catch(() => top.trim());
	const realRoot = await realpath(root).catch(() => root);
	if (realTop !== realRoot) return { error: 'not-vault-repo', hint: `The vault sits inside the repository at ${realTop}: commits there would reach material outside the vault. Ask the user how to proceed.` };
	return { repo: true };
}

/**
 * `git status --porcelain -z` as entries: two status letters, the path, and the
 * original path of a staged rename. `-uall` lists untracked files one by one —
 * a commit plan names files, never a directory someone might later drop other
 * things into.
 */
async function gitStatusFiles(root) {
	const raw = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
	const tokens = raw.split('\0');
	const entries = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token || token.startsWith('##')) continue;
		const xy = token.slice(0, 2);
		const rel = token.slice(3).normalize('NFC');
		if (!rel) continue;
		const entry = { xy, path: rel };
		if (xy.includes('R') || xy.includes('C')) {
			const orig = String(tokens[++i] ?? '').normalize('NFC');
			if (orig) entry.orig = orig;
		}
		entries.push(entry);
	}
	return entries;
}

/** Head, branch and dirty entries: the facts one call reports. */
async function gitSnapshot(root) {
	const head = ((await runGit(root, ['rev-parse', '--short', 'HEAD'], { allowFail: true })) ?? '').trim();
	const branch = ((await runGit(root, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })) ?? '').trim();
	const files = await gitStatusFiles(root);
	return { head, branch, files };
}

/**
 * The proof that the audited tree is still the tree: head plus, for every dirty
 * path, its status letters, its rename origin and the hash of its current
 * bytes. Any edit after an audit — a fixed link, an unlinked note — changes
 * the token, so a commit can never carry content the audit never saw.
 */
async function treeToken(root, head, files) {
	const lines = [`HEAD ${head}`];
	for (const entry of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		let content = 'gone';
		try {
			content = createHash('sha256').update(await readFile(path.join(root, entry.path), 'utf8')).digest('hex');
		} catch (error) {
			if (error && error.code !== 'ENOENT') content = 'unreadable';
		}
		lines.push(`${entry.xy} ${entry.path}${entry.orig ? ` <- ${entry.orig}` : ''} ${content}`);
	}
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A suggested grouping of dirty paths: the folder one level below the section. */
function groupDirtyPaths(files) {
	const groups = new Map();
	for (const entry of files) {
		const segments = entry.path.split('/');
		const group = segments.length === 1 ? '.' : segments.length <= 2 ? segments[0] : segments.slice(0, 2).join('/');
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group).push(entry.path);
	}
	return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([group, paths]) => ({ group, paths }));
}

/**
 * The blocking/warning audit of a working tree, the same contract for `audit`
 * and for the refusal inside `commit`:
 *
 * - every changed note passes the policy lint; a hard budget (a summary past
 *   its maximum) blocks, the rest are warnings — except `broken-link`, which
 *   the commit rule promotes: links must be valid;
 * - every path the change removes or renames away is searched for referrers:
 *   a link still pointing at what is gone is the change's own damage, and it
 *   blocks. The scan is one pass over the notes, so a hundred deletions cost
 *   one walk;
 * - with `scope: 'vault'` the whole tree is link-checked and the pre-existing
 *   rot is reported — never blocking: older notes are not this change's fault,
 *   but a serious audit says what the vault actually looks like.
 */
async function auditWorkingTree(root, files, scope) {
	const blocking = [];
	const warnings = [];
	const index = await buildPathIndex(root);
	let scannedNotes = 0;

	for (const entry of files) {
		if (!entry.path.endsWith('.md') || entry.xy.includes('D')) continue;
		let text;
		try {
			text = await readFile(path.join(root, entry.path), 'utf8');
		} catch {
			continue;
		}
		scannedNotes += 1;
		const lint = await lintNote(root, entry.path, text, index);
		for (const finding of lint.hard) blocking.push({ code: finding.code, path: entry.path, message: finding.message, ...(finding.examples?.length ? { examples: finding.examples } : {}) });
		for (const finding of lint.soft) {
			const item = { code: finding.code, path: entry.path, message: finding.message, ...(finding.examples?.length ? { examples: finding.examples } : {}) };
			if (finding.code === 'broken-link') blocking.push(item);
			else warnings.push(item);
		}
	}

	const removed = new Map();
	for (const entry of files) {
		// The map speaks the link's language: `linkPath` drops the `.md` that git
		// shows and vault links never carry, so [[some/note]] matches a deleted
		// `some/note.md`. Attachments keep their extension on both sides.
		if (entry.xy.includes('R')) removed.set(linkPath(entry.orig ?? entry.path), linkPath(entry.path));
		else if (entry.xy.includes('D')) removed.set(linkPath(entry.path), '');
	}
	if (removed.size) {
		const notes = [];
		await collectMarkdown(root, notes, 0);
		for (const file of notes) {
			const rel = relPath(root, file);
			let text;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				continue;
			}
			for (const line of proseLines(text)) {
				const masked = maskInlineCode(line.text);
				LINK_PATTERN.lastIndex = 0;
				let match;
				while ((match = LINK_PATTERN.exec(masked))) {
					const target = linkPath(match[1]);
					if (!target || target.includes('<') || target.includes('>') || target.includes('…')) continue;
					for (const [gone, into] of removed) {
						if (!refersTo(target, gone, true)) continue;
						// A link that still resolves is not this change's damage. The
						// prefix rule speaks of folders, but git lists files: when
						// `X.md` dies and the folder `X/` rises with notes inside,
						// [[X/figlio]] points at a note that exists and [[X]] points
						// at a folder, which the vault accepts. Only links left
						// pointing at nothing block, so the audit catches the move
						// half-done ([[X/dimenticato]], [[X]] with nothing behind it)
						// and never the split that finished.
						if (index.keys.has(target) || index.folders.has(target)) continue;
						if (/\.[a-z0-9]{2,5}$/.test(target.split('/').pop())) {
							let there = false;
							try {
								there = (await probe(path.join(root, target))).exists;
							} catch {
								there = false;
							}
							if (there) continue;
						}
						blocking.push({
							code: 'link-to-removed',
							path: rel,
							line: line.line,
							message: into ? `[[${target}]] still points at the old path; it now lives at [[${into}]].` : `[[${target}]] points at a path this change deletes.`,
							examples: [`${rel}:${line.line}`],
						});
					}
				}
			}
		}
	}

	let vault;
	if (scope === 'vault') {
		const notes = [];
		await collectMarkdown(root, notes, 0);
		const samples = [];
		let broken = 0;
		let notCanonical = 0;
		for (const file of notes) {
			if (samples.length >= 12 && broken + notCanonical >= 12) break;
			const rel = relPath(root, file);
			let text;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				continue;
			}
			const found = await linkFindings(root, rel, text, index);
			broken += found.broken.length;
			notCanonical += found.notCanonical.length;
			for (const target of found.broken) if (samples.length < 12) samples.push(`${rel} -> [[${target}]]`);
			for (const target of found.notCanonical) if (samples.length < 12) samples.push(`${rel} -> [[${target}]] (short name)`);
		}
		vault = { scanned: notes.length, broken, notCanonical, samples };
	}

	return { blocking, warnings, scannedNotes, vault };
}

/**
 * What a dirty index is made of: the staged paths, and among them the ones
 * whose staged snapshot differs from the disk (second porcelain letter busy:
 * MM, MD…). The first list is what unstaging would release; the second is
 * what unstaging would DISCARD — an intermediate version newer or different
 * from the files. "Unstaging" is the effect (empty the index back to HEAD,
 * however the user gets it: `git restore --staged .` or a mixed `git reset`
 * without arguments — commands that never touch the files or the history).
 * The tool never resolves that tension itself, and never runs those commands:
 * it shows the evidence, and the index stays the user's.
 */
function stagedInfo(files) {
	const stagedPaths = files.filter((entry) => entry.xy[0] !== ' ' && entry.xy[0] !== '?').map((entry) => entry.path);
	const stagedDifferFromWorktree = files.filter((entry) => entry.xy[0] !== ' ' && entry.xy[0] !== '?' && entry.xy[1] !== ' ' && entry.xy[1] !== '?').map((entry) => entry.path);
	return { stagedPaths, stagedDifferFromWorktree };
}

/** Model-facing contract of the git tool. */
const GIT_TOOL_DESCRIPTION =
	'Commit the vault git working tree the way the vault policy allows: commit only on an explicit user request, never push or rewrite history. ' +
	'action status (no Vault Grant): branch, dirty files grouped by folder, recent messages. action audit (no Grant): every changed note is linted and its links checked; links left pointing at deleted or renamed-away paths block. A clean audit returns auditToken, ' +
	'which the first edit after it invalidates. action commit (Vault Grant + confirm: true + fresh auditToken): commits is a list of { message, paths } staged and committed in order — split unrelated topics into separate commits, brief indicative message in the language of the vault. ' +
	'The tool never pushes, amends, resets or rebases, and its scope is the vault repository root only.';

function gitTool(ctx, config) {
	return {
		name: 'vault_git',
		description: GIT_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['status', 'audit', 'commit'], description: 'Look, check integrity, or commit.' },
				scope: { type: 'string', enum: ['changes', 'vault'], description: 'audit only: changes (default) checks what would be committed; vault also reports the pre-existing link health of the whole tree.' },
				commits: {
					type: 'array',
					description: 'commit only: the plan, applied in order — one entry per commit, each staging exactly its paths.',
					items: {
						type: 'object',
						properties: {
							message: { type: 'string', description: 'Brief and indicative of what the commit does; first line ≤ 120 characters, optional body after it.' },
							paths: { type: 'array', items: { type: 'string' }, description: 'Dirty files this commit takes, relative to the vault root — the status paths, verbatim.' },
						},
						required: ['message', 'paths'],
						additionalProperties: false,
					},
				},
				auditToken: { type: 'string', description: 'commit only: the token from the latest clean audit of this exact tree.' },
				confirm: { type: 'boolean', description: 'commit only: true only when the user explicitly asked to commit and agreed to this plan.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					root: { type: 'string', description: 'Absolute vault root the repository is at.' },
					repo: { type: 'boolean', description: 'True when the root is a repository of its own; see error when it is not.' },
					branch: { type: 'string', description: 'Current branch; empty on a detached head.' },
					head: { type: 'string', description: 'Short sha of HEAD; empty before the first commit.' },
					upstream: { type: 'string', description: 'Tracked remote branch, when the branch has one.' },
					ahead: { type: 'integer', description: 'Commits ahead of the upstream.' },
					behind: { type: 'integer', description: 'Commits behind the upstream.' },
					staged: { type: 'boolean', description: 'True when the index already holds staged changes: commit refuses until the user resolves that.' },
					stagedPaths: { type: 'array', items: { type: 'string' }, description: 'What is staged: the paths unstaging would release.' },
					stagedDifferFromWorktree: { type: 'array', items: { type: 'string' }, description: 'Staged paths whose snapshot differs from the disk: what unstaging would discard. The files on disk stay untouched either way.' },
					total: { type: 'integer', description: 'Dirty entries; files may be shorter.' },
					files: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								status: { type: 'string', description: 'The two porcelain letters: first index, second work tree.' },
								path: { type: 'string', description: 'Path relative to the vault root.' },
								orig: { type: 'string', description: 'Rename source, for R entries.' },
							},
							additionalProperties: false,
						},
						description: 'The dirty files: what a commit could take.' },
					groups: {
						type: 'array',
						items: {
							type: 'object',
							properties: { group: { type: 'string', description: 'The folder below the section, or "." at the root.' }, paths: { type: 'array', items: { type: 'string' } } },
							additionalProperties: false,
						},
						description: 'A starting point for the topic split — refine it with the meaning of the change, not just the folder.',
					},
					recentCommits: {
						type: 'array',
						items: {
							type: 'object',
							properties: { sha: { type: 'string' }, message: { type: 'string' } },
							additionalProperties: false,
						},
						description: 'The last messages: the language and shape the vault history uses.',
					},
					scope: { type: 'string', enum: ['changes', 'vault'], description: 'audit: what was checked.' },
					blocking: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								code: { type: 'string', description: 'broken-link, link-to-removed, summary-too-long, …' },
								path: { type: 'string', description: 'Where the problem lives.' },
								line: { type: 'integer', description: 'The offending line, when known.' },
								message: { type: 'string' },
								examples: { type: 'array', items: { type: 'string' } },
							},
							additionalProperties: false,
						},
						description: 'What must be fixed before a commit; empty is the only passing result.',
					},
					warnings: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								code: { type: 'string' },
								path: { type: 'string' },
								message: { type: 'string' },
								examples: { type: 'array', items: { type: 'string' } },
							},
							additionalProperties: false,
						},
						description: 'Policy findings that do not block: report them, fix what belongs to this change.',
					},
					scannedNotes: { type: 'integer', description: 'Changed notes linted.' },
					vault: {
						type: 'object',
						properties: {
							scanned: { type: 'integer', description: 'Notes link-checked across the tree.' },
							broken: { type: 'integer', description: 'Broken links found anywhere, this change included.' },
							notCanonical: { type: 'integer', description: 'Short-name links found anywhere.' },
							samples: { type: 'array', items: { type: 'string' }, description: 'The first findings, as `note -> [[target]]`.' },
						},
						additionalProperties: false,
						description: 'audit with scope vault: the pre-existing health, reported but never blocking.',
					},
					auditToken: { type: 'string', description: 'Valid only when blocking is empty: the proof of this exact tree. Pass it to commit.' },
					committed: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								sha: { type: 'string', description: 'Short sha of the commit made.' },
								message: { type: 'string', description: 'Its first line.' },
								paths: { type: 'array', items: { type: 'string' }, description: 'What it took.' },
							},
							additionalProperties: false,
						},
						description: 'commit: the commits made, in order. They stand: the tool never rewrites them.',
					},
					leftUncommitted: { type: 'array', items: { type: 'string' }, description: 'Dirty files the plan did not take: say so plainly.' },
					hint: { type: 'string', description: 'The next step, or why this was refused.' },
					error: { type: 'string', description: 'Refusal reason.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => [
				{ type: 'text', text: value.error ? `vault_git ${args?.action ?? ''} refused (${value.error}): ${value.hint ?? ''}`.trimEnd() : JSON.stringify(value, null, 2) },
			],
		},
		isConcurrencySafe: (args) => args?.action !== 'commit',
		async execute(args, exec) {
			const action = String(args?.action ?? '');
			// Reading the repository is not a mutation: status and audit answer
			// without the Grant, exactly like vault_search; only commit passes
			// through the gate that writes.
			const gate = action === 'commit' ? await mutationGate(ctx, config, exec, 'vault_git') : await readGate(ctx, config);
			if (gate.error) return gate;
			const repo = await vaultRepo(gate.root);
			if (repo.error) return { root: gate.root, repo: false, error: repo.error, hint: repo.hint };
			const root = gate.root;
			const snapshot = await gitSnapshot(root);

			if (action === 'status') {
				const staged = stagedInfo(snapshot.files);
				const out = {
					root,
					repo: true,
					branch: snapshot.branch,
					head: snapshot.head,
					staged: staged.stagedPaths.length > 0,
					...(staged.stagedPaths.length ? { stagedPaths: staged.stagedPaths.slice(0, GIT_FILE_CAP) } : {}),
					...(staged.stagedDifferFromWorktree.length ? { stagedDifferFromWorktree: staged.stagedDifferFromWorktree.slice(0, GIT_FILE_CAP) } : {}),
					total: snapshot.files.length,
					files: snapshot.files.slice(0, GIT_FILE_CAP).map((entry) => ({ status: entry.xy, path: entry.path, ...(entry.orig ? { orig: entry.orig } : {}) })),
					groups: groupDirtyPaths(snapshot.files),
				};
				const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true });
				if (upstream) {
					out.upstream = upstream.trim();
					const counts = await runGit(root, ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], { allowFail: true });
					const [behind, ahead] = String(counts ?? '').trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
					if (Number.isFinite(ahead)) out.ahead = ahead;
					if (Number.isFinite(behind)) out.behind = behind;
				}
				const log = await runGit(root, ['log', '--oneline', '-5'], { allowFail: true });
				if (log) {
					out.recentCommits = log
						.trim()
						.split('\n')
						.map((line) => {
							const at = line.indexOf(' ');
							return { sha: line.slice(0, at), message: line.slice(at + 1) };
						});
				}
				out.hint = snapshot.files.length ? 'Nothing is committed by looking: audit, propose a plan split by topic, and commit only when the user agrees.' : 'The working tree is clean.';
				return out;
			}

			if (action === 'audit') {
				const scope = args?.scope === 'vault' ? 'vault' : 'changes';
				const audit = await auditWorkingTree(root, snapshot.files, scope);
				const token = await treeToken(root, snapshot.head, snapshot.files);
				const out = { root, repo: true, scope, blocking: audit.blocking, warnings: audit.warnings, scannedNotes: audit.scannedNotes };
				if (audit.vault) out.vault = audit.vault;
				if (!audit.blocking.length) out.auditToken = token;
				out.hint = audit.blocking.length
					? 'Fix every blocking finding, then audit again: the token only exists for a passing tree.'
					: snapshot.files.length
						? 'The tree passes. Propose the commit split to the user; this token commits it until the next edit.'
						: 'Nothing is dirty: there is nothing to commit.';
				return out;
			}

			// commit — the four locks, in order: capability, user consent, a
			// passing audit of THIS tree, and a plan that names only dirty files.
			if (currentValue(config.gitCommit) === false) return { root, error: 'git-disabled', hint: 'Git commits are switched off for this plugin: Plugins → Vault Tab → Git commits.' };
			if (args?.confirm !== true) return { root, error: 'confirm-required', hint: 'A commit needs confirm: true, which means the user explicitly asked to commit and agreed to this exact plan. Ask first.' };
			const name = ((await runGit(root, ['config', 'user.name'], { allowFail: true })) ?? '').trim();
			const email = ((await runGit(root, ['config', 'user.email'], { allowFail: true })) ?? '').trim();
			if (!name || !email) return { root, error: 'git-identity-missing', hint: 'The repository has no user.name/user.email: ask the user to set them, the tool never invents an identity.' };
			const staged = stagedInfo(snapshot.files);
			if (staged.stagedPaths.length) {
				const differList = staged.stagedDifferFromWorktree.slice(0, 5).join(', ');
				return {
					root,
					error: 'index-not-clean',
					stagedPaths: staged.stagedPaths.slice(0, GIT_FILE_CAP),
					...(staged.stagedDifferFromWorktree.length ? { stagedDifferFromWorktree: staged.stagedDifferFromWorktree.slice(0, GIT_FILE_CAP) } : {}),
					hint: staged.stagedDifferFromWorktree.length
						? `The git index already holds ${staged.stagedPaths.length} staged change(s) and ${staged.stagedDifferFromWorktree.length} of them (${differList}${staged.stagedDifferFromWorktree.length > 5 ? ', …' : ''}) differ from the files on disk: unstaging releases the index but DISCARDS those staged snapshots. Show both lists and let the user decide; the tool never touches the index.`
						: `The git index already holds ${staged.stagedPaths.length} staged change(s), identical to the files on disk: unstaging (the user's own \`git restore --staged .\`, or a mixed \`git reset\` without arguments — files and history untouched) loses nothing. Ask the user; the tool never touches the index.`,
				};
			}
			const fresh = await treeToken(root, snapshot.head, snapshot.files);
			if (!args?.auditToken) return { root, error: 'audit-required', hint: 'Run vault_git audit first and pass its auditToken: nothing reaches history unchecked.' };
			if (args.auditToken !== fresh) return { root, error: 'audit-stale', hint: 'The tree changed since the audit that issued that token: audit again, and re-check the plan still matches what you showed the user.' };

			const plan = Array.isArray(args.commits) ? args.commits : null;
			if (!plan?.length) return { root, error: 'invalid-plan', hint: 'commits must list at least one { message, paths }. Status shows the dirty files to plan from.' };
			if (plan.length > GIT_COMMIT_CAP) return { root, error: 'invalid-plan', hint: `At most ${GIT_COMMIT_CAP} commits per call; split the plan across calls.` };
			const dirty = new Map(snapshot.files.map((entry) => [entry.path, entry]));
			const claimed = new Set();
			const problems = [];
			for (const [i, entry] of plan.entries()) {
				const message = String(entry?.message ?? '');
				if (!message.trim()) problems.push(`commit ${i + 1}: empty message`);
				else {
					const subject = message.trim().split('\n')[0];
					if (textLength(subject) > GIT_SUBJECT_MAX) problems.push(`commit ${i + 1}: the first line is ${textLength(subject)} characters; keep it under ${GIT_SUBJECT_MAX} — the detail goes in the body`);
				}
				const paths = Array.isArray(entry?.paths) ? entry.paths : [];
				if (!paths.length) problems.push(`commit ${i + 1}: no paths`);
				for (const raw of paths) {
					const rel = String(raw ?? '').normalize('NFC');
					if (!dirty.has(rel)) problems.push(`commit ${i + 1}: ${rel} is not a dirty file of this tree`);
					else if (claimed.has(rel)) problems.push(`${rel} appears in more than one commit`);
					else claimed.add(rel);
				}
			}
			if (problems.length) return { root, error: 'invalid-plan', hint: problems.slice(0, 8).join('; ') };

			const committed = [];
			for (const entry of plan) {
				const paths = entry.paths.map((p) => String(p).normalize('NFC'));
				try {
					await runGit(root, ['add', '-A', '--', ...paths]);
					await runGit(root, ['commit', '-m', String(entry.message).replace(/\s+$/, '')]);
					const sha = ((await runGit(root, ['rev-parse', '--short', 'HEAD'])) ?? '').trim();
					committed.push({ sha, message: String(entry.message).trim().split('\n')[0], paths });
				} catch (error) {
					const out = { root, error: 'commit-failed', committed, hint: `Commit ${committed.length + 1} failed (${String(error.message)}). The ${committed.length} already made stand — the tool never rewrites history. Report and wait for the user.` };
					return out;
				}
			}
			const out = { root, committed, leftUncommitted: snapshot.files.filter((entry) => !claimed.has(entry.path)).map((entry) => entry.path) };
			out.hint = out.leftUncommitted.length ? `${out.leftUncommitted.length} file(s) are still uncommitted: tell the user.` : 'The history now holds exactly what the user agreed to.';
			return out;
		},
	};
}

// --- Vault read tools --------------------------------------------------------
//
// They are registered on `tools` alone: no grant, no command, no sandbox policy.
// A session that cannot write to the vault must still be able to search it, and
// a profile without `sandboxPolicy` must still get its retrieval — the opposite
// of the write capability, which needs everything.

/** The folder retrieval reads: the one the Vault tab lists, whatever writes go to. */
async function retrievalRoot(config) {
	const root = resolveRoot(currentValue(config && config.root));
	if (!(await probe(root)).directory) return { error: 'root-missing', root, hint: 'The vault folder is not there: ask the user, or use vault_setup.' };
	return { root };
}

/** Model-facing contract of the search tool. */
const SEARCH_TOOL_DESCRIPTION =
	'Read-only grep-first search of the vault the Vault Tab plugin lists; reading needs no Vault Grant and ' +
	'answers in every session permission. It reads only file names and the frontmatter `summary:` — the two ' +
	'retrieval keys the vault policy defines — folding accents (citta finds città) and requiring every ' +
	'keyword; rows are path plus summary, never bodies. No keyword means inventory of `scope`: what the ' +
	'folder holds, its subfolders, and the MOC that indexes it. where "fulltext" searches bodies and returns ' +
	'the matching lines with their numbers, so vault_read can start there. 90-Reference/ and 99-Templates/ ' +
	'stay out unless includeReference or the scope is inside them.';

function searchTool(ctx, config) {
	return {
		name: 'vault_search',
		description: SEARCH_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				keywords: {
					type: 'array',
					items: { type: 'string' },
					description: 'Words that must ALL appear in the file name or the summary. One concept per keyword; up to 8.',
				},
				scope: { type: 'string', description: 'Folder to search, relative to the vault root (empty: the whole vault). Narrows both modes.' },
				where: { type: 'string', enum: ['metadata', 'fulltext'], description: 'metadata (default): names and summaries only. fulltext: bodies too, returning matching lines with numbers.' },
				type: { type: 'string', description: 'Keep only notes whose frontmatter `type` matches (note, project, area, resource, log, moc).' },
				includeReference: { type: 'boolean', description: 'True brings 90-Reference/ into the search, which policy §7 keeps out by default.' },
				limit: { type: 'integer', description: 'Rows to return: default 20, maximum 60.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: ['metadata', 'inventory', 'fulltext'], description: 'What was searched.' },
					keywords: { type: 'array', items: { type: 'string' }, description: 'The keywords, as searched (AND).' },
					scope: { type: 'string', description: 'The folder the search covered, when it was narrowed.' },
					root: { type: 'string', description: 'Absolute vault root the paths are under.' },
					scanned: { type: 'integer', description: 'Files examined.' },
					truncated: { type: 'boolean', description: 'True when the walk stopped at its cap: the vault is bigger than the answer.' },
					total: { type: 'integer', description: 'Matches found; `results` may be shorter.' },
					results: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								path: { type: 'string', description: 'Note path, relative to the vault root.' },
								summary: { type: 'string', description: 'The frontmatter summary, the retrieval key.' },
								matched: { type: 'array', items: { type: 'string' }, description: 'Which keys the keywords hit: name, summary.' },
								status: { type: 'string', description: 'Frontmatter status, when it is not active (done, archived).' },
								hits: { type: 'integer', description: 'Matching lines reported, full-text mode.' },
								lines: {
									type: 'array',
									items: {
										type: 'object',
										properties: { line: { type: 'integer' }, text: { type: 'string' } },
										additionalProperties: false,
									},
									description: 'The matching lines, numbered: read from one of them.',
								},
							},
							additionalProperties: false,
						},
					},
					folders: {
						type: 'array',
						items: {
							type: 'object',
							properties: { path: { type: 'string' }, notes: { type: 'integer' } },
							additionalProperties: false,
						},
						description: 'Inventory mode: the subfolders of the scope and how many notes each holds.',
					},
					index: { type: 'string', description: 'Inventory mode: the MOC that indexes this folder, if the vault has one.' },
					hint: { type: 'string', description: 'The next step, including what to do when nothing matched.' },
					error: { type: 'string', description: 'Refusal reason, when nothing was searched.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => {
				if (value.error) return [{ type: 'text', text: `vault_search refused (${value.error}): ${value.hint ?? ''}`.trimEnd() }];
				const head = `vault_search ${value.mode}${value.keywords?.length ? ` [${value.keywords.join(', ')}]` : ''}${value.scope ? ` in ${value.scope}` : ''}: ${value.total} of ${value.scanned} files`;
				return [{ type: 'text', text: value.results?.length ? `${head}\n${value.results.map((row) => [row.path, row.summary].filter(Boolean).join('\t')).join('\n')}` : head }];
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const gate = await retrievalRoot(config);
			if (gate.error) return gate;
			// The scope is a path like every other: confined to the root, never above it.
			let scope = '';
			if (String(args?.scope ?? '').trim()) {
				const confined = await confinePath(gate.root, String(args.scope).trim().replace(/^\/+/, ''));
				if (confined.error) return { error: confined.error, hint: PATH_HINT };
				const at = await probe(confined.target);
				if (!at.exists) return { error: 'scope-missing', hint: 'No such folder in the vault: search the whole tree with scope "".' };
				if (!at.directory) return { error: 'scope-is-file', hint: '`scope` is a folder; one file is read with vault_read.' };
				scope = relPath(gate.root, confined.target);
			}
			const result = await searchVault(gate.root, { ...(args ?? {}), scope });
			return { root: gate.root, ...result };
		},
	};
}

/** Model-facing contract of the bounded reader. */
const READ_TOOL_DESCRIPTION =
	'Read one file inside the vault root, bounded: 120 lines by default, 400 at most, starting at any line; ' +
	'the answer carries totalLines and nextFrom, so the next chunk is one call away. Reading needs no Vault ' +
	'Grant. outline: true returns the headings with their line numbers instead of the text — how a long ' +
	'document in 90-Reference/ is approached, after vault_search { where: "fulltext" } has found the term. ' +
	'It is never a way to load a whole document.';

function readTool(ctx, config) {
	return {
		name: 'vault_read',
		description: READ_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File inside the vault root, relative to it.' },
				from: { type: 'integer', description: '1-based line to start from (default 1).' },
				lines: { type: 'integer', description: 'Lines to return, default 120, maximum 400.' },
				outline: { type: 'boolean', description: 'True returns the headings and their line numbers instead of the text.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Read path, relative to the vault root.' },
					totalLines: { type: 'integer', description: 'Lines in the whole file.' },
					totalBytes: { type: 'integer', description: 'Size of the whole file.' },
					from: { type: 'integer', description: 'First line returned.' },
					to: { type: 'integer', description: 'Last line returned.' },
					text: { type: 'string', description: 'The lines, joined by newlines.' },
					hasMore: { type: 'boolean', description: 'True when the file continues past `to`.' },
					nextFrom: { type: 'integer', description: 'Line to ask for next.' },
					cut: { type: 'boolean', description: 'True when the answer was cut by its size, not by the line count.' },
					outline: {
						type: 'array',
						items: {
							type: 'object',
							properties: { level: { type: 'integer' }, text: { type: 'string' }, line: { type: 'integer' } },
							additionalProperties: false,
						},
						description: 'The headings, with the line each sits on (outline mode).' },
					root: { type: 'string', description: 'Absolute vault root the file is under.' },
					error: { type: 'string', description: 'Refusal reason.' },
					hint: { type: 'string', description: 'What to do instead.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => {
				if (value.error) return [{ type: 'text', text: `vault_read refused (${value.error}): ${value.hint ?? ''}`.trimEnd() }];
				if (value.outline) {
					return [{ type: 'text', text: `vault_read outline of ${value.path} (${value.totalLines} lines)\n${value.outline.map((entry) => `${'  '.repeat(entry.level - 1)}${entry.line}: ${entry.text}`).join('\n')}` }];
				}
				const tail = value.hasMore ? ` (from line ${value.nextFrom} to continue)` : '';
				return [{ type: 'text', text: `${value.path}:${value.from}-${value.to} of ${value.totalLines}${tail}\n${value.text}` }];
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const gate = await retrievalRoot(config);
			if (gate.error) return gate;
			const confined = await confinePath(gate.root, args?.path);
			if (confined.error) return { error: confined.error, hint: PATH_HINT };
			const result = await readRegion(gate.root, relPath(gate.root, confined.target), args ?? {});
			return result.error ? result : { ...result, root: gate.root };
		},
	};
}

/** The types a note may take, and the template each one asks for (policy §8). */
const NOTE_TYPES = ['note', 'project', 'area', 'resource', 'log', 'moc'];
const TEMPLATE_ASSETS = {
	note: 'vault-template-note.md',
	project: 'vault-template-project.md',
	area: 'vault-template-note.md',
	resource: 'vault-template-resource.md',
	log: 'vault-template-log.md',
	moc: 'vault-template-moc.md',
};
const TEMPLATE_FOLDER = '99-Templates';

/** Model-facing contract of the storage tool. */
const NOTE_TOOL_DESCRIPTION =
	'Create one note in the vault and index it, in one call: the file name is built from the title ' +
	'(kebab-case, accents folded; a log note gets the date prefix, a moc the 00- prefix), the frontmatter ' +
	'comes from the vault’s own 99-Templates/<type>.md with the placeholders and the summary filled, and one ' +
	'line is appended to the MOC that owns the folder (false in moc opts out). summary is required because it ' +
	'is the retrieval key: target 100 characters, refused above 140. Keep the body to one concept (~80 lines); ' +
	'material that cannot be atomic goes to 90-Reference/ through vault_write. Refuses to overwrite — search ' +
	'first with vault_search and update the note that exists. Needs the user’s Vault Grant.';

function noteTool(ctx, config) {
	return {
		name: 'vault_note',
		description: NOTE_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				folder: { type: 'string', description: 'Folder for the note, relative to the vault root (30-Resources/citta/giappone). Missing folders are created.' },
				title: { type: 'string', description: 'The note title: becomes the `# ` heading and, kebab-cased, the file name.' },
				summary: { type: 'string', description: 'The retrieval key: the words someone would search for. Target 100 characters, maximum 140.' },
				type: { type: 'string', enum: NOTE_TYPES, description: 'Which frontmatter template to use; default note.' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the frontmatter (kebab-case, no accents).' },
				source: { type: 'string', description: 'Where the note comes from (policy §6): a URL, a "[[90-Reference/…]]" link, or a short origin.' },
				body: { type: 'string', description: 'The body under the heading, one concept. Omit it to get the template skeleton.' },
				name: { type: 'string', description: 'File name override, kebab-case without extension. Default: derived from the title.' },
				moc: { type: 'boolean', description: 'False skips the index line. Default true: the owning MOC gets one, which is what makes the note reachable.' },
			},
			required: ['folder', 'title', 'summary'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Created note, relative to the vault root.' },
					type: { type: 'string', description: 'The frontmatter type written.' },
					template: { type: 'string', enum: ['vault', 'default'], description: 'Where the frontmatter came from: the vault’s template folder, or the plugin default.' },
					summary: { type: 'string', description: 'The summary as stored.' },
					moc: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'The MOC that now lists the note.' },
							added: { type: 'boolean', description: 'False when it already linked the note.' },
							line: { type: 'string', description: 'The line appended, so the annotation can be edited.' },
						},
						additionalProperties: false,
						description: 'The index upkeep done with the note.',
					},
					mocSkipped: {
						type: 'object',
						properties: {
							reason: { type: 'string', description: 'Why no index line was written.' },
							hint: { type: 'string', description: 'What to do about it.' },
						},
						additionalProperties: false,
					},
					warnings: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								code: { type: 'string', description: 'Which rule, e.g. broken-link or folder-needs-moc.' },
								message: { type: 'string', description: 'What to fix, in one line.' },
								examples: { type: 'array', items: { type: 'string' } },
							},
							additionalProperties: false,
						},
						description: 'Policy checks the note did not pass; the note is written anyway.',
					},
					root: { type: 'string', description: 'Absolute vault root the note is under.' },
					error: { type: 'string', description: 'Refusal reason, when nothing was written.' },
					hint: { type: 'string', description: 'What to do instead, when nothing was written.' },
				},
				additionalProperties: false,
			},
			render: (args, value) => [
				{
					type: 'text',
					text: value.error
						? `vault_note refused (${value.error}): ${value.hint ?? ''}`.trimEnd()
						: `vault_note created ${value.path} (${value.type}, ${value.template} template)${value.moc ? ` | indexed in ${value.moc.path}${value.moc.added ? '' : ' (already there)'}` : ` | not indexed (${value.mocSkipped?.reason})`}${value.warnings?.length ? ` | ${value.warnings.length} policy warning${value.warnings.length === 1 ? '' : 's'}` : ''}`,
				},
			],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const gate = await mutationGate(ctx, config, exec, 'vault_note');
			if (gate.error) return gate;
			const root = gate.root;

			const type = NOTE_TYPES.includes(args?.type) ? args.type : 'note';
			const title = String(args?.title ?? '').trim();
			const summary = String(args?.summary ?? '').replace(/\s+/g, ' ').trim();
			if (!title) return { error: 'title-required', hint: 'The title names the note and becomes its file name.' };
			if (!summary) return { error: 'summary-required', hint: 'The summary is the retrieval key: without it the note exists but is never found (policy §1).' };
			if (textLength(summary) > SUMMARY_MAX) {
				return { error: 'summary-too-long', hint: `The summary is ${textLength(summary)} characters; the policy stops at ${SUMMARY_MAX}. Keep the keywords, drop the sentence.` };
			}

			const folder = String(args?.folder ?? '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
			if (!folder) return { error: 'folder-required', hint: 'Choose the section and folder the note belongs to (10-Projects, 20-Areas, 30-Resources, 40-Archive).' };
			if (/\.md$/i.test(folder)) return { error: 'folder-is-file', hint: '`folder` is a folder: the file name comes from the title.' };
			const confinedFolder = await confinePath(root, folder);
			if (confinedFolder.error) return { error: confinedFolder.error, hint: PATH_HINT };
			if (inFolders(relPath(root, confinedFolder.target), [...IMMUTABLE_LINK_DIRS, ...PROTECTED_DELETE_DIRS])) {
				return { error: 'folder-not-for-notes', hint: '90-Reference/ holds integral documents and 99-Templates/ the templates: a note goes in a PARA section, and vault_write writes those folders.' };
			}

			const slug = slugifyTitle(args?.name || title, { dated: type === 'log' });
			const rel = `${relPath(root, confinedFolder.target)}/${type === 'moc' && !slug.startsWith('00-') ? `00-${slug}` : slug}.md`;
			const confined = await confinePath(root, rel);
			if (confined.error) return { error: confined.error, hint: PATH_HINT };
			if ((await probe(confined.target)).exists) {
				return { error: 'exists', path: rel, hint: 'A note already lives here: vault_search found it for a reason. Update it with vault_write { overwrite: true }, or choose a title that says what is different.' };
			}

			// The vault's own template wins: a vault that edited its templates edited
			// them on purpose (§8). The shipped default is the fallback, never a
			// replacement.
			const vaultTemplate = path.join(root, TEMPLATE_FOLDER, `${type}.md`);
			let text;
			let template = 'vault';
			try {
				text = await readFile(vaultTemplate, 'utf8');
			} catch {
				text = await readAsset(TEMPLATE_ASSETS[type]).catch(() => `---\ntype: ${type}\nstatus: active\ntags: []\ncreated: {{DATE}}\nsummary: ""\n---\n\n# {{title}}\n`);
				template = 'default';
			}

			const body = args?.body === void 0 ? '' : String(args.body);
			if (/^\s*---\s*\n/.test(body)) return { error: 'body-has-frontmatter', hint: 'The frontmatter is composed here: send the body only, starting after it.' };

			text = fillPlaceholders(text, { title, summary });
			const fm = frontmatterOf(text);
			text = setFrontmatterKey(text, 'type', type);
			if (!fm.fields.status) text = setFrontmatterKey(text, 'status', 'active');
			text = setFrontmatterKey(text, 'created', today());
			text = setFrontmatterKey(text, 'summary', yamlValue(summary));
			if (Array.isArray(args?.tags) && args.tags.length) {
				text = setFrontmatterKey(text, 'tags', `[${args.tags.map((tag) => slugifyTitle(tag)).filter(Boolean).join(', ')}]`);
			}
			if (args?.source) text = setFrontmatterKey(text, 'source', yamlValue(args.source));
			if (body.trim()) {
				const head = fm.closed ? text.split('\n').slice(0, fm.end).join('\n') : text;
				text = `${head}\n\n${noteBody(title, body)}`;
			}

			const bytes = Buffer.byteLength(text, 'utf8');
			if (bytes > MAX_WRITE_BYTES) return { error: 'too-large', bytes, hint: `The limit is ${MAX_WRITE_BYTES} bytes.` };

			const fresh = await confinePath(root, rel);
			if (fresh.error || fresh.target !== confined.target) return { error: 'outside-root', hint: 'The path changed while writing; nothing was written.' };
			try {
				await atomicWrite(fresh.target, text);
			} catch (error) {
				return { error: 'write-failed', hint: String((error && error.message) || error) };
			}

			const key = rel.slice(0, -3);
			const out = { path: rel, type, template, summary, root };

			// The index line is the second half of "a note exists": without it the
			// vault has a file, not knowledge. Failures here are reported, never
			// hidden, and never undo the note that is already written.
			if (args?.moc === false) {
				out.mocSkipped = { reason: 'declined', hint: 'The policy still wants one line in a MOC: add it when the note has its final title.' };
			} else {
				let target = await indexForFolder(root, path.dirname(rel));
				// A MOC does not index itself: the index that owns it is the one that
				// owns the folder it sits in, so when the walk finds the file just
				// written the search restarts from the parent folder.
				if (type === 'moc' && target && target.path === rel) target = await indexForFolder(root, path.dirname(path.dirname(rel)));
				if (target && target.path === rel) target = null;
				if (!target) {
					out.mocSkipped = { reason: 'no-index', hint: 'Neither the folder nor any ancestor holds a 00-*.md, and there is no 00-Home.md at the root: create the index, then link the note.' };
				} else {
					const mocFile = await confinePath(root, target.path);
					if (mocFile.error) {
						out.mocSkipped = { reason: 'index-unwritable', hint: `The index ${target.path} does not resolve inside the vault (${mocFile.error}): add the line for [[${key}]] by hand.` };
					} else {
						let current = '';
						try {
							current = await readFile(mocFile.target, 'utf8');
						} catch {
							current = '';
						}
						const already = proseLines(current).some((entry) => {
							LINK_PATTERN.lastIndex = 0;
							let match;
							while ((match = LINK_PATTERN.exec(entry.text))) if (linkPath(match[1]) === key) return true;
							return false;
						});
						if (already) {
							out.moc = { path: target.path, added: false };
						} else {
							const line = mocEntryLine(key, summary);
							try {
								await atomicWrite(mocFile.target, appendMocLine(current, line));
								out.moc = { path: target.path, added: true, line };
							} catch (error) {
								out.mocSkipped = { reason: 'index-unwritable', hint: `The note is written but not indexed (${String((error && error.message) || error)}): add the line \`${line}\` to ${target.path} yourself.` };
							}
						}
					}
				}
			}

			const index = await buildPathIndex(root);
			let soft = [];
			// Same rule as `vault_write`: the note is already on disk, a lint that
			// cannot run must not report the whole call as failed.
			try {
				soft = (await lintNote(root, rel, text, index)).soft;
			} catch {
				soft = [{ code: 'lint-unavailable', message: 'Policy lint could not run: check the note against POLICY.md by hand.' }];
			}
			const folderRel = path.dirname(rel);
			const section = folderRel.split('/')[0];
			if (!/^(10|20|30|40)-/.test(section)) {
				soft.push({ code: 'folder-outside-para', message: `${section}/ is not a PARA section: notes live under 10-Projects, 20-Areas, 30-Resources or 40-Archive.` });
			}
			if (out.mocSkipped) {
				soft.push({ code: 'not-indexed', message: `No MOC lists this note yet (§5): ${out.mocSkipped.reason}.` });
			} else if (out.moc && path.dirname(out.moc.path) === '.' && (await folderNeedsMoc(root, folderRel))) {
				soft.push({ code: 'folder-needs-moc', message: `The note landed on Home, but ${folderRel.split('/')[0]}/ already holds several notes: policy §5 gives a grown section its own 00-<section>.md and keeps Home linking indexes only.` });
			}
			if (soft.length) out.warnings = soft;
			return out;
		},
	};
}

/** Human-only switch of the grant: the composer chip calls it, the model never does. */
function writeCommand(ctx, config) {
	return {
		name: 'vault-write',
		description: 'Show or change this session’s Vault Grant — the Vault control beside the permission selector.',
		input: { hint: 'on | off | status' },
		handler: ({ agent, rawInput }) => {
			const root = writeRootOf(config);
			const state = grantState(ctx, agent.session, grantDefault(config));
			const arg = String(rawInput ?? '').trim().toLowerCase();
			if (arg === 'on' || arg === 'off') {
				if (!state.editable) {
					return { kind: 'error', text: `The Vault Grant only changes under Workspace Write (this session is ${state.mode ?? 'unknown'}).` };
				}
				grants.set(agent.session.header.id, arg === 'on');
				return { kind: 'success', text: `Vault Grant ${arg}: writes inside ${root} are ${arg === 'on' ? 'allowed' : 'blocked'}.` };
			}
			if (arg !== '' && arg !== 'status') return { kind: 'error', text: 'Usage: /vault-write on | off | status' };
			return {
				kind: 'success',
				text: `Vault Grant: ${state.allowed ? 'on' : 'off'} · permission ${state.mode ?? 'unknown'} · ${
					state.editable ? 'editable' : 'not editable under this permission'
				} · root ${root}`,
			};
		},
	};
}

export function apply(ctx, config) {
	// --- Vault tab listing -----------------------------------------------------
	const handler = async (req, res) => {
		if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
		// Resolved per request: saving the card swaps the volatile reference
		// value without re-activating this row, and the listing follows.
		const root = resolveRoot(currentValue(config && config.root));
		// Same-site guard that survives the Caddy rewrite of Host/Origin: the
		// browser's own Sec-Fetch-Site is the authoritative hint when present.
		const site = req.headers['sec-fetch-site'];
		if (site && site !== 'same-origin') return json(res, 403, { error: 'foreign-origin' });
		const url = new URL(req.url, 'http://dsh.invalid');
		const rel = (url.searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
		// Containment like the tools': lexical check plus realpath of the deepest
		// existing ancestor, so a symlinked folder cannot leak a listing from outside.
		const confined = rel ? await confinePath(root, rel) : { target: path.resolve(root) };
		if (confined.error) return json(res, 403, { error: 'outside-root' });
		const target = confined.target;
		let dirents;
		try {
			dirents = await readdir(target, { withFileTypes: true });
		} catch (err) {
			// A missing configured root is a state to explain, not an error:
			// the Client renders "folder not found + where to configure it".
			if (rel === '' && err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES')) {
				return json(res, 200, { root, entries: [], missing: true, truncated: false });
			}
			const code = err && err.code === 'ENOENT' ? 404 : err && err.code === 'ENOTDIR' ? 400 : 500;
			return json(res, code, { error: 'unreadable' });
		}
		const entries = dirents
			.slice(0, MAX_ENTRIES)
			.map((d) => ({
				name: d.name,
				kind: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
				path: rel ? rel + '/' + d.name : d.name,
			}))
			.sort((a, b) =>
				a.kind === b.kind
					? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
					: a.kind === 'directory'
						? -1
						: 1,
			);
		return json(res, 200, { root, entries, truncated: dirents.length > MAX_ENTRIES });
	};
	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/vault-tab/list', handler }), 'dsh-vault-tab: list route');

	// --- Vault Grant state for the composer chip -------------------------------
	// Read-only by design: this route reports the shared resolver's verdict and
	// never changes it. Granting authority stays a human action, so the only
	// write path is the /vault-write command, which arrives through the peer's
	// own session binding — a route this Host could answer to a local curl could
	// let the model grant itself.
	const grantHandler = async (req, res) => {
		if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
		const site = req.headers['sec-fetch-site'];
		if (site && site !== 'same-origin') return json(res, 403, { error: 'foreign-origin' });
		const url = new URL(req.url, 'http://dsh.invalid');
		const id = url.searchParams.get('session') ?? '';
		const root = writeRootOf(config);
		const agent = ctx.get('agents')?.get(id);
		if (!agent) return json(res, 200, { root, mode: null, allowed: false, editable: false, reason: 'no-live-session' });
		const state = grantState(ctx, agent.session, grantDefault(config));
		return json(res, 200, { root, mode: state.mode ?? null, allowed: state.allowed, editable: state.editable });
	};
	ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/vault-tab/grant', handler: grantHandler }), 'dsh-vault-tab: grant route');

	// The write capability needs the mode, a tool slot and a human command; a
	// profile without any of them still gets the tab and the read-only listing.
	// Retrieval binds here too: the tool slot the agents actually inherit is the
	// one alongside commands and the sandbox policy — an injector asking for
	// `tools` alone never fires. Placement is not a gate: `vault_search` and
	// `vault_read` never consult the Grant, so they work in every session mode.
	ctx.inject(['tools', 'commands', 'sandboxPolicy'], (scope) => {
		scope.effect(() => scope.tools.register(writeTool(scope, config)), 'dsh-vault-tab: write tool');
		scope.effect(() => scope.tools.register(noteTool(scope, config)), 'dsh-vault-tab: note tool');
		scope.effect(() => scope.tools.register(moveTool(scope, config)), 'dsh-vault-tab: move tool');
		scope.effect(() => scope.tools.register(deleteTool(scope, config)), 'dsh-vault-tab: delete tool');
		scope.effect(() => scope.tools.register(infoTool(scope, config)), 'dsh-vault-tab: info tool');
		scope.effect(() => scope.tools.register(gitTool(scope, config)), 'dsh-vault-tab: git tool');
		scope.effect(() => scope.tools.register(searchTool(scope, config)), 'dsh-vault-tab: search tool');
		scope.effect(() => scope.tools.register(readTool(scope, config)), 'dsh-vault-tab: read tool');
		scope.effect(() => scope.commands.register(writeCommand(scope, config)), 'dsh-vault-tab: write command');
	});

	// Two skills, one per direction: the vault is read with the search tools and
	// changed with the `vault_*` mutations. Both are always registered — unlike the
	// setup skill they describe behaviour the tools cannot enforce on their own.
	ctx.inject(['skills'], (scope) => {
		registerTextSkill(scope, {
			file: 'vault-write.md',
			name: NOTE_SKILL_NAME,
			description: NOTE_SKILL_DESCRIPTION,
			whenToUse: NOTE_SKILL_WHEN_TO_USE,
			label: 'dsh-vault-tab: note skill',
		});
		registerTextSkill(scope, {
			file: 'vault-read.md',
			name: READ_SKILL_NAME,
			description: READ_SKILL_DESCRIPTION,
			whenToUse: READ_SKILL_WHEN_TO_USE,
			label: 'dsh-vault-tab: read skill',
		});
		registerTextSkill(scope, {
			file: 'vault-git.md',
			name: GIT_SKILL_NAME,
			description: GIT_SKILL_DESCRIPTION,
			whenToUse: GIT_SKILL_WHEN_TO_USE,
			label: 'dsh-vault-tab: git skill',
		});
	});

/** Register one skill shipped as a Markdown file, frontmatter stripped. */
function registerTextSkill(ctx, options) {
	let text;
	try {
		text = readFileSync(path.join(HERE, 'skills', options.file), 'utf8');
	} catch (error) {
		ctx.logger.warn('%s unreadable, skill not registered (%s)', options.file, String((error && error.message) || error));
		return;
	}
	const body = text.replace(/^\uFEFF/, '').replace(/^---[^]*?---\s*/, '').trim();
	ctx.effect(
		() =>
			ctx.skills.register({
				name: options.name,
				description: options.description,
				whenToUse: options.whenToUse,
				content: body,
				// `source` is required even though `register()` does not check it: the
				// loader validates the whole definition, so a registration without it shows
				// up in the catalog and then fails the moment anyone loads the skill.
				source: 'runtime',
				provider: '@local/dsh-vault-tab',
			}),
		options.label,
	);
}

	// --- Vault setup capability --------------------------------------------------
	// The skill is guidance only, so it costs context in every session: the
	// card toggle removes it, and the skill's last step offers to do that.
	// `skillSetup` is volatile, so saving it never restarts this row: the
	// loader commits the value into the live reference and emits
	// "loader/volatile-update" on this fiber's ctx, and the registration
	// follows the switch live. The event is loader-internal; if a future
	// loader dropped it, the flag would still apply at the next activation,
	// and the `hide-skill` action works through `skillOff` regardless.
	let setupScope = null;
	ctx.effect(() => {
		const off = typeof ctx.on === 'function' ? ctx.on('loader/volatile-update', () => syncSkill(setupScope, config)) : void 0;
		return typeof off === 'function' ? off : void 0;
	}, 'dsh-vault-tab: volatile skill sync');
	ctx.inject(['tools', 'skills'], (setupCtx) => {
		setupScope = setupCtx;
		setupCtx.effect(() => () => {
			if (setupScope === setupCtx) setupScope = null;
		}, 'dsh-vault-tab: setup scope release');
		setupCtx.effect(() => setupCtx.tools.register(setupTool(setupCtx, config)), 'dsh-vault-tab: setup tool');
		syncSkill(setupCtx, config);
	});
}

/** Register `skills/vault-setup.md` against the setup scope; `syncSkill` decides when. */
function registerSetupSkill(ctx) {
	if (!ctx) return;
	let definition;
	try {
		definition = {
			name: SKILL_NAME,
			description: SKILL_DESCRIPTION,
			whenToUse: SKILL_WHEN_TO_USE,
			source: 'runtime',
			content: readFileSync(path.join(HERE, 'skills', 'vault-setup.md'), 'utf8'),
		};
	} catch (error) {
		if (ctx.logger && ctx.logger.warn) ctx.logger.warn('vault-tab: setup skill unavailable: %s', error && error.message);
		return;
	}
	const state = { gone: false };
	const off = ctx.skills.register(definition);
	const mine = () => {
		if (state.gone) return false;
		state.gone = true;
		if (skillOff === mine) skillOff = null;
		off();
		return true;
	};
	skillOff = mine;
	// The service unregisters with the scope's own teardown; this cleanup only
	// marks the state and releases the module pointer. Calling the disposer
	// during teardown would re-enter a teardown already in progress and fail
	// the whole config reload.
	ctx.effect(() => () => {
		state.gone = true;
		// Compare before clearing: a replacement activation may already own
		// the module pointer, and this cleanup must not steal it.
		if (skillOff === mine) skillOff = null;
	}, 'dsh-vault-tab: setup skill');
}

function json(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}
