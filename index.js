// Host half of @local/dsh-vault-tab.
//
// Two capabilities live here:
//
// 1. The Vault tab listing: one exact JSON route listing one level of the
//    configured root. An unset root falls back to `<home>/Vault`, so a fresh
//    install works out of the box; a missing root folder is reported as
//    `{ root, missing: true }` and the Client shows where to reconfigure. Any
//    requested path is resolved and must stay under the root. File previews do
//    not go through this route: the Client opens the built-in Document viewer,
//    whose reads follow the Session's own file-read authority.
//
// 2. Vault setup: the `vault_setup` tool plus the `vault-setup` skill. Plugin
//    Host code runs in the Host process, outside both enforcement points the
//    sandbox has (the `ctx.fs` policy fence and the confined `ctx.shell`
//    runners), so this is the only path that can scaffold a vault folder while
//    the Session is `read-only` or `workspace-write`. The tool is therefore the
//    single place where the vault boundary is decided; the skill only explains
//    the order of operations, and the user is asked before anything is written.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
		const target = path.resolve(root, rel);
		if (target !== root && !target.startsWith(root + path.sep)) return json(res, 403, { error: 'outside-root' });
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
