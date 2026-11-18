// Test del tool vault_git. Come gli altri: importa il modulo VERO, lo registra
// con un ctx finto, poi chiama i tool su un vault-repository vero costruito in
// tmp (git init + commit iniziale). Copre i quattro lucchetti del commit
// (capability, confirm, token d'audit fresco, piano valido), l'audit dei link
// in entrambe le direzioni (link rotti nei file cambiati, link rimasti puntati
// su percorsi cancellati), e la suddivisione per argomenti.
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.join(import.meta.dirname, '..');
const ROOT = process.env.VAULT_GIT_FIXTURE ?? path.join(os.tmpdir(), 'dsh-vault-tab-git');
const NOT_A_REPO = ROOT + '-plain';
const mod = await import(path.join(PLUGIN, 'index.js'));

const git = (cwd, ...args) =>
	new Promise((resolve, reject) => {
		execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message))) : resolve(String(stdout).trim())));
	});

// --- fixture: un vault che è anche repository --------------------------------
await rm(ROOT, { recursive: true, force: true });
await rm(NOT_A_REPO, { recursive: true, force: true });
const w = async (rel, content) => {
	const full = path.join(ROOT, rel);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, content, 'utf8');
};
const note = (title, summary, body = '') => `---\ntype: note\nstatus: active\ntags: [fisso]\ncreated: 2026-11-01\nsummary: "${summary}"\n---\n\n# ${title}\n${body}\n`;
await w('POLICY.md', '# Policy\n\nregole\n');
await w('20-Areas/viaggi/00-viaggi.md', `---\ntype: moc\nstatus: active\ntags: [viaggi]\ncreated: 2026-11-01\nsummary: "Indice viaggi"\n---\n\n# Viaggi — MOC\n\n- [[20-Areas/viaggi/tokyo-2024]] — Shibuya\n- [[30-Resources/citta/paris]] — arrondissement\n`);
await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
await w('30-Resources/citta/paris.md', note('Paris', 'Parigi: arrondissement e boulangerie', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
await mkdir(NOT_A_REPO, { recursive: true });
await writeFile(path.join(NOT_A_REPO, 'nota.md'), note('Fuori dal repo', 'Vault senza git'), 'utf8');
await git(ROOT, 'init', '-q', '-b', 'main');
await git(ROOT, 'config', 'user.name', 'Vault Test');
await git(ROOT, 'config', 'user.email', 'vault@test.local');
await git(ROOT, 'add', '-A');
await git(ROOT, 'commit', '-q', '-m', 'chore: impianto del vault');

// --- harness -----------------------------------------------------------------
function harness({ mode = 'danger-full-access', root = ROOT, config = {} } = {}) {
	const tools = {};
	const skills = [];
	const ctx = {
		effect: (fn) => {
			const off = fn();
			return typeof off === 'function' ? off : () => {};
		},
		inject: (_deps, fn) => fn(ctx),
		get: (name) => {
			if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) };
			if (name === 'agents') return { get: () => void 0 };
			return void 0;
		},
		on: () => () => {},
		webServer: { register: () => {} },
		tools: { register: (tool) => ((tools[tool.name] = tool), () => delete tools[tool.name]) },
		commands: { register: () => () => {} },
		skills: { register: (skill) => (skills.push(skill), () => {}) },
		logger: { warn() {}, info() {}, debug() {} },
	};
	mod.apply(ctx, { root, writeRoot: '', skillSetup: true, vaultGrantDefault: false, ...config });
	return { tools, skills, exec: { agent: { session: { header: { id: 'git-test-session' } } } } };
}

// Validatore del sottoinsieme JSON Schema degli output (come nel test dei tool).
function checkSchema(node, value, at, errors) {
	if (value === void 0 || Number.isNaN(value)) return (errors.push(`${at}: undefined/NaN`), errors);
	if (node.enum && !node.enum.includes(value)) errors.push(`${at}: enum`);
	if (node.type === 'object') {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return (errors.push(`${at}: not object`), errors);
		for (const key of node.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: missing`);
		for (const [key, inner] of Object.entries(value)) {
			const child = node.properties?.[key];
			if (!child) {
				if (node.additionalProperties === false) errors.push(`${at}.${key}: undeclared`);
				continue;
			}
			checkSchema(child, inner, `${at}.${key}`, errors);
		}
	} else if (node.type === 'array') {
		if (!Array.isArray(value)) errors.push(`${at}: not array`);
		else value.forEach((item, i) => checkSchema(node.items ?? {}, item, `${at}[${i}]`, errors));
	} else if (node.type === 'string' && typeof value !== 'string') errors.push(`${at}: not string`);
	else if ((node.type === 'integer' || node.type === 'number') && typeof value !== 'number') errors.push(`${at}: not number`);
	else if (node.type === 'boolean' && typeof value !== 'boolean') errors.push(`${at}: not boolean`);
	return errors;
}

const results = [];
const check = async (name, fn) => {
	try {
		const detail = await fn();
		results.push({ name, pass: detail === true || detail === undefined, detail: detail === true || detail === undefined ? '' : String(detail) });
	} catch (error) {
		results.push({ name, pass: false, detail: String((error && error.stack) || error) });
	}
};
const assert = (cond, detail) => cond === true || `${detail ?? 'falso'}`;

const H = harness();
const { tools } = H;
const gitCall = (args) => tools.vault_git.execute(args, H.exec);
const shape = (value) => {
	const errors = checkSchema(tools.vault_git.output.schema, value, 'vault_git', []);
	return errors.length === 0 ? true : errors.join(' | ');
};

// --- status --------------------------------------------------------------------
await check('status: albero pulito dopo il commit iniziale', async () => {
	const out = await gitCall({ action: 'status' });
	return assert(out.repo === true && out.branch === 'main' && out.head && out.total === 0 && out.files.length === 0 && Array.isArray(out.groups), JSON.stringify(out)) === true ? shape(out) : JSON.stringify(out);
});
await check('status su una cartella che non è repo: not-a-repo', async () => {
	const plain = harness({ root: NOT_A_REPO });
	const out = await plain.tools.vault_git.execute({ action: 'status' }, plain.exec);
	return assert(out.error === 'not-a-repo' && out.repo === false, JSON.stringify(out));
});

// --- due argomenti, due commit --------------------------------------------------
await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]]. Aggiunto un riga.\n'));
await w('20-Areas/viaggi/osaka.md', note('Osaka', 'Osaka: street food a Dotonbori', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
await w('30-Resources/citta/lione.md', note('Lione', 'Lione: bouchon e la Saona', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
let AUDIT = null;
await check('status: 3 file sporchi raggruppati per cartella', async () => {
	const out = await gitCall({ action: 'status' });
	const groups = out.groups.map((g) => g.group).join(',');
	return assert(out.total === 3 && groups === '20-Areas/viaggi,30-Resources/citta' && out.recentCommits?.length === 1, JSON.stringify({ total: out.total, groups, log: out.recentCommits }));
});
await check('audit pulito: nessun blocking e token emesso', async () => {
	AUDIT = await gitCall({ action: 'audit' });
	// Il modello vede il testo renderizzato: deve portare il token, o il commit
	// diventa impossibile. (Stessa ragione per cui vault_info renderizza il JSON.)
	const rendered = tools.vault_git.output.render({ action: 'audit' }, AUDIT)[0].text;
	return assert(AUDIT.blocking.length === 0 && typeof AUDIT.auditToken === 'string' && AUDIT.scannedNotes === 3 && rendered.includes(AUDIT.auditToken), JSON.stringify({ token: !!AUDIT.auditToken, rendered: rendered.slice(0, 120) })) === true ? shape(AUDIT) : JSON.stringify(AUDIT);
});
await check('commit senza confirm: confirm-required', async () => {
	const out = await gitCall({ action: 'commit', commits: [{ message: 'docs: tutto', paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(out.error === 'confirm-required', JSON.stringify(out));
});
await check('commit senza token: audit-required', async () => {
	const out = await gitCall({ action: 'commit', confirm: true, commits: [{ message: 'docs: tutto', paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(out.error === 'audit-required', JSON.stringify(out));
});
await check('commit con token falso: audit-stale', async () => {
	const out = await gitCall({ action: 'commit', confirm: true, auditToken: 'x'.repeat(64), commits: [{ message: 'docs: tutto', paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(out.error === 'audit-stale', JSON.stringify(out));
});
await check('commit con grant spento (workspace-write): grant-off', async () => {
	const weak = harness({ mode: 'workspace-write' });
	const out = await weak.tools.vault_git.execute({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: tutto', paths: ['20-Areas/viaggi/osaka.md'] }] }, weak.exec);
	return assert(out.error === 'grant-off', JSON.stringify(out));
});
await check('status e audit rispondono anche senza grant', async () => {
	const weak = harness({ mode: 'workspace-write' });
	const s = await weak.tools.vault_git.execute({ action: 'status' }, weak.exec);
	const a = await weak.tools.vault_git.execute({ action: 'audit' }, weak.exec);
	return assert(s.total === 3 && !!a.auditToken, JSON.stringify({ s: s.total, a: !!a.auditToken }));
});
await check('commit con capacità gitCommit spenta: git-disabled', async () => {
	const off = harness({ config: { gitCommit: false } });
	const out = await off.tools.vault_git.execute({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: tutto', paths: ['20-Areas/viaggi/osaka.md'] }] }, off.exec);
	return assert(out.error === 'git-disabled', JSON.stringify(out));
});
await check('piano invalido: path non sporco, messaggi vuoti, doppioni', async () => {
	const a = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: roba', paths: ['non-esiste.md'] }] });
	const b = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: '   ', paths: ['20-Areas/viaggi/osaka.md'] }] });
	const c = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: uno', paths: ['20-Areas/viaggi/osaka.md'] }, { message: 'docs: due', paths: ['20-Areas/viaggi/osaka.md'] }] });
	const d = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: soggetto lunghissimo ' + 'x'.repeat(120), paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(a.error === 'invalid-plan' && b.error === 'invalid-plan' && c.error === 'invalid-plan' && d.error === 'invalid-plan', JSON.stringify([a.error, b.error, c.error, d.error]));
});
await check('commit per argomento: due commit, piano rispettato', async () => {
	const out = await gitCall({
		action: 'commit',
		confirm: true,
		auditToken: AUDIT.auditToken,
		commits: [
			{ message: 'docs(viaggi): nota Osaka e riga in più su Tokyo', paths: ['20-Areas/viaggi/tokyo-2024.md', '20-Areas/viaggi/osaka.md'] },
			{ message: 'docs(citta): nuova nota Lione', paths: ['30-Resources/citta/lione.md'] },
		],
	});
	const log = (await git(ROOT, 'log', '--pretty=%s')).split('\n');
	const clean = await gitCall({ action: 'status' });
	return assert(out.committed?.length === 2 && out.leftUncommitted.length === 0 && log.length === 3 && log[0] === 'docs(citta): nuova nota Lione' && clean.total === 0, JSON.stringify({ out, log })) === true ? shape(out) : JSON.stringify({ out, log });
});
await check('token muore alla prima modifica dopo la sua audit', async () => {
	await w('20-Areas/viaggi/osaka.md', note('Osaka', 'Osaka: street food a Dotonbori', 'Vedi [[20-Areas/viaggi/00-viaggi]]. Seconda riga.\n'));
	const out = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: obsoleto', paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(out.error === 'audit-stale', JSON.stringify(out));
});

// --- audit: link rotti e referrer orfani ---------------------------------------
await check('audit: link rotto in una nota cambiata è blocking, niente token', async () => {
	await w('20-Areas/viaggi/osaka.md', note('Osaka', 'Osaka: street food a Dotonbori', 'Vedi [[20-Areas/viaggi/quantaltro]].\n'));
	const out = await gitCall({ action: 'audit' });
	const hit = out.blocking.find((b) => b.code === 'broken-link');
	const commit = await gitCall({ action: 'commit', confirm: true, auditToken: AUDIT.auditToken, commits: [{ message: 'docs: rotto', paths: ['20-Areas/viaggi/osaka.md'] }] });
	return assert(hit && !out.auditToken && commit.error === 'audit-stale', JSON.stringify({ blocking: out.blocking, e: commit.error }));
});
await check('audit: referrer verso un path cancellato è blocking', async () => {
	// cancello paris.md senza toccare la MOC che la linka (20-Areas/viaggi/00-viaggi.md)
	await rm(path.join(ROOT, '30-Resources/citta/paris.md'));
	const out = await gitCall({ action: 'audit' });
	const hit = out.blocking.find((b) => b.code === 'link-to-removed' && b.path === '20-Areas/viaggi/00-viaggi.md');
	return assert(hit && !out.auditToken, JSON.stringify(out));
});
await check('audit scope vault: salute preesistente riportata, non blocking', async () => {
	const out = await gitCall({ action: 'audit', scope: 'vault' });
	return assert(out.scope === 'vault' && out.vault && out.vault.scanned >= 4 && out.vault.broken >= 2 && Array.isArray(out.vault.samples), JSON.stringify(out)) === true ? shape(out) : JSON.stringify(out);
});
await check('sistemato tutto: audit pulito e commit unico della cancellazione', async () => {
	// Fixing osaka means reverting it to the committed bytes: it stops being dirty,
	// and only the deletion and the MOC are left for the commit.
	await w('20-Areas/viaggi/osaka.md', note('Osaka', 'Osaka: street food a Dotonbori', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
	await w('20-Areas/viaggi/00-viaggi.md', `---\ntype: moc\nstatus: active\ntags: [viaggi]\ncreated: 2026-11-01\nsummary: "Indice viaggi"\n---\n\n# Viaggi — MOC\n\n- [[20-Areas/viaggi/tokyo-2024]] — Shibuya\n- [[20-Areas/viaggi/osaka]] — Dotonbori\n- [[30-Resources/citta/lione]] — bouchon\n`);
	const audited = await gitCall({ action: 'audit' });
	const out = await gitCall({ action: 'commit', confirm: true, auditToken: audited.auditToken, commits: [{ message: 'refactor(citta): rimossa Paris, MOC allineata', paths: ['30-Resources/citta/paris.md', '20-Areas/viaggi/00-viaggi.md'] }] });
	const status = await gitCall({ action: 'status' });
	return assert(audited.blocking.length === 0 && out.committed?.length === 1 && status.total === 0, JSON.stringify({ audited: audited.blocking, out, total: status.total }));
});

// --- regressione: X.md muore, la cartella X/ nasce con lo stesso nome ---------
await check('split finito: [[X/figlio]] verso la nuova cartella NON è link-to-removed', async () => {
	await w('20-Areas/viaggi/osaka/nyusho.md', note('Nyusho', 'Osaka: Dotonbori di sera, kun ku kae', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
	await w('20-Areas/viaggi/00-viaggi.md', `---\ntype: moc\nstatus: active\ntags: [viaggi]\ncreated: 2026-11-01\nsummary: "Indice viaggi"\n---\n\n# Viaggi — MOC\n\n- [[20-Areas/viaggi/tokyo-2024]] — Shibuya\n- [[20-Areas/viaggi/osaka/nyusho]] — Dotonbori\n- [[30-Resources/citta/lione]] — bouchon\n`);
	await rm(path.join(ROOT, '20-Areas/viaggi/osaka.md'));
	const out = await gitCall({ action: 'audit' });
	return assert(out.blocking.length === 0 && !!out.auditToken, JSON.stringify(out.blocking));
});
await check('split a metà: un figlio dimenticato nel link blocca lo stesso', async () => {
	await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]] e [[20-Areas/viaggi/osaka/fantasma]].\n'));
	const out = await gitCall({ action: 'audit' });
	const hit = out.blocking.find((b) => b.code === 'link-to-removed' && String(b.message).includes('osaka/fantasma'));
	await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]].\n'));
	return assert(!!hit, JSON.stringify(out.blocking));
});

// --- index sporco ----------------------------------------------------------------
await check('index già sporco: index-not-clean porta le prove (paths staged vs disco)', async () => {
	await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]]. Terza riga.\n'));
	await git(ROOT, 'add', '--', '20-Areas/viaggi/tokyo-2024.md');
	await w('20-Areas/viaggi/tokyo-2024.md', note('Tokyo 2024', 'Viaggio Tokyo: Shibuya e ramen', 'Vedi [[20-Areas/viaggi/00-viaggi]]. Quarta riga, più nuova dello snapshot.\n'));
	const out = await gitCall({ action: 'commit', confirm: true, auditToken: 'y'.repeat(64), commits: [{ message: 'docs: staged', paths: ['20-Areas/viaggi/tokyo-2024.md'] }] });
	const st = await gitCall({ action: 'status' });
	await git(ROOT, 'reset', '-q');
	const ok =
		out.error === 'index-not-clean' &&
		out.stagedPaths?.includes('20-Areas/viaggi/tokyo-2024.md') &&
		out.stagedDifferFromWorktree?.includes('20-Areas/viaggi/tokyo-2024.md') &&
		st.staged === true &&
		st.stagedPaths?.includes('20-Areas/viaggi/tokyo-2024.md') &&
		st.stagedDifferFromWorktree?.includes('20-Areas/viaggi/tokyo-2024.md');
	return ok === true ? shape(out) && shape(st) : JSON.stringify({ e: out.error, sp: out.stagedPaths, sd: out.stagedDifferFromWorktree });
});

// --- identità git -----------------------------------------------------------------
await check('identità mancante: git-identity-missing, mai inventata', async () => {
	await w('30-Resources/citta/lione.md', note('Lione', 'Lione: bouchon e la Saona', 'Vedi [[20-Areas/viaggi/00-viaggi]]. Due righe.\n'));
	const audited = await gitCall({ action: 'audit' });
	await git(ROOT, 'config', '--unset', 'user.email');
	const out = await gitCall({ action: 'commit', confirm: true, auditToken: audited.auditToken, commits: [{ message: 'docs(citta): riga in più su Lione', paths: ['30-Resources/citta/lione.md'] }] });
	await git(ROOT, 'config', 'user.email', 'vault@test.local');
	const done = await gitCall({ action: 'commit', confirm: true, auditToken: audited.auditToken, commits: [{ message: 'docs(citta): riga in più su Lione', paths: ['30-Resources/citta/lione.md'] }] });
	return assert(out.error === 'git-identity-missing' && done.committed?.length === 1, JSON.stringify({ out, done }));
});

// --- riepilogo ---------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
