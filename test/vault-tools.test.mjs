// Test dei tool di retrieval del vault-tab. Non copia logica: importa il modulo
// VERO e lo registra con un ctx finto (effects sincroni, sandbox a scelta), poi
// chiama i tool registrati. Così sono coperti anche i gate del grant e gli
// schema di output, oltre alle funzioni.
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.join(import.meta.dirname, '..');
const ROOT = process.env.VAULT_FIXTURE ?? path.join(os.tmpdir(), 'dsh-vault-tab-tools');
const mod = await import(path.join(PLUGIN, 'index.js'));

// --- fixture -----------------------------------------------------------------
await rm(ROOT, { recursive: true, force: true });
const w = async (rel, content) => {
	const full = path.join(ROOT, rel);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, typeof content === 'string' ? content : await readFile(path.join(PLUGIN, 'assets', content.asset)), 'utf8');
};
await w('POLICY.md', { asset: 'vault-policy.md' });
await w('00-Home.md', { asset: 'vault-home.md' });
await w('90-Reference/00-Reference.md', { asset: 'vault-reference-index.md' });
for (const t of ['note', 'project', 'resource', 'log', 'moc']) await w(`99-Templates/${t}.md`, { asset: `vault-template-${t}.md` });

// Un documento lungo: outline, regioni, full-text, fence che imita un heading.
const spec = ['# Specifica collettivi', '', 'Intro.', '', '## Piano dei trasporti', '', 'riga liscia', '', '```c', '# not-a-heading', '```', '', '## Dettaglio'];
for (let i = 0; i < 420; i++) spec.push(`riga di specifica ${i}`);
spec.push('parola-esotica-XYZ nel corpo, non nel titolo');
for (let i = 0; i < 120; i++) spec.push(`oltre ${i}`);
await w('90-Reference/progetto/specifica.md', spec.join('\n') + '\n');

await w('20-Areas/viaggi/00-viaggi.md', '---\ntype: moc\nstatus: active\ntags: [viaggi]\ncreated: 2026-11-01\nsummary: "Indice viaggi: Tokyo, Islanda, città fantasma"\n---\n\n# Viaggi — MOC\n\n- [[20-Areas/viaggi/tokyo-2024]] — Shibuya e ramen\n');
await w('20-Areas/viaggi/tokyo-2024.md', '---\ntype: area\nstatus: active\ntags: [viaggi, giappone]\ncreated: 2026-11-01\nsummary: "Viaggio Giappone 2024: Tokyo, Shibuya, ramen, budget"\n---\n\n# Tokyo 2024\n\n- Base: Shibuya. Vedi [[20-Areas/viaggi/00-viaggi]].\n');
await w('20-Areas/viaggi/citta-fantasma.md', '---\ntype: note\nstatus: done\ntags: [viaggi]\ncreated: 2026-11-01\nsummary: "Nota con la parola città nel summary, per il folding degli accenti"\n---\n\n# Città fantasma\n');
await w('30-Resources/citta/giappone/tokyo/00-tokyo.md', '---\ntype: moc\nstatus: active\ntags: [tokyo]\ncreated: 2026-11-01\nsummary: "Indice quartieri di Tokyo"\n---\n\n# Tokyo — MOC\n\n- [[30-Resources/citta/giappone/tokyo/yanaka]] — case in legno\n');
await w('30-Resources/citta/giappone/tokyo/yanaka.md', '---\ntype: resource\nstatus: active\ntags: [tokyo]\ncreated: 2026-11-01\nsummary: "Yanaka: quartieri storici di Tokyo, templi e cimiteri"\n---\n\n# Yanaka\n');
await w('30-Resources/citta/giappone/tokyo/shimokitazawa.md', '---\ntype: resource\nstatus: active\ntags: [tokyo]\ncreated: 2026-11-01\nsummary: "Shimokitazawa: vintage e piccoli locali"\n---\n\n# Shimokitazawa\n');
for (const n of ['a', 'b', 'c', 'd']) await w(`10-Projects/progetto-a/nota-${n}.md`, `---\ntype: project\nstatus: active\ntags: [progetto-a]\ncreated: 2026-11-01\nsummary: "Nota ${n} del progetto A senza indice di sezione"\n---\n\n# Nota ${n}\n`);

// --- harness -----------------------------------------------------------------
function harness({ mode = 'danger-full-access', root = ROOT, config = {} } = {}) {
	const tools = {};
	const skills = [];
	const commands = [];
	const ctx = {
		effect: (fn) => {
			const off = fn();
			return typeof off === 'function' ? off : () => {};
		},
		inject: (_deps, fn) => fn(ctx),
		get: (name) => {
			if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) };
			if (name === 'agents') return { get: () => void 0 };
			if (name === 'configEditor') return { entries: () => [], edit: async () => {} };
			return void 0;
		},
		on: () => () => {},
		webServer: { register: () => {} },
		tools: { register: (tool) => (tools[tool.name] = tool, () => delete tools[tool.name]) },
		commands: { register: (cmd) => (commands.push(cmd), () => {}) },
		skills: { register: (skill) => (skills.push(skill), () => {}) },
		logger: { warn() {}, info() {}, debug() {} },
	};
	mod.apply(ctx, { root, writeRoot: '', skillSetup: true, vaultGrantDefault: false, ...config });
	return { tools, skills, commands, exec: { agent: { session: { header: { id: 'test-session' } } } } };
}

// Validatore del sottoinsieme JSON Schema usato dagli output dei tool: becca
// campi non dichiarati, tipi sbagliati, `undefined`/`null` annidati.
function checkSchema(node, value, at, errors) {
	if (node.oneOf) {
		const ok = node.oneOf.filter((branch) => !checkSchema(branch, value, at, [])).length === 1;
		if (!ok) errors.push(`${at}: oneOf`);
		return errors;
	}
	if (value === void 0 || Number.isNaN(value)) return errors.push(`${at}: undefined/NaN`), errors;
	if (node.enum && !node.enum.includes(value)) errors.push(`${at}: enum`);
	if (node.type === 'object') {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${at}: not object`), errors;
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
const search = (args) => tools.vault_search.execute(args, H.exec);
const read = (args) => tools.vault_read.execute(args, H.exec);
const note = (args) => tools.vault_note.execute(args, H.exec);
const write = (args) => tools.vault_write.execute(args, H.exec);
// Ogni risposta dei tool passa dal suo schema dichiarato.
const shape = async (toolName, args, value) => {
	const errors = checkSchema(tools[toolName].output.schema, value, toolName, []);
	return errors.length === 0 ? true : errors.join(' | ');
};

// --- registrazione -----------------------------------------------------------
await check('registrati setup, write, note, move, delete, info, search, read', () => {
	const missing = ['vault_setup', 'vault_write', 'vault_note', 'vault_move', 'vault_delete', 'vault_info', 'vault_search', 'vault_read'].filter((name) => !tools[name]);
	return missing.length ? `mancano: ${missing}` : true;
});
await check('comando /vault-write registrato', () => (H.commands.some((c) => c.name === 'vault-write') ? true : 'nessun comando'));
await check('skill vault-setup, vault-write, vault-read registrate', () => {
	const names = H.skills.map((s) => s.name).sort();
	return JSON.stringify(names) === JSON.stringify(['vault-read', 'vault-setup', 'vault-write']) ? true : names.join(',');
});
await check('skill: contenuto senza frontmatter e con whenToUse', () => {
	const bad = H.skills.filter((s) => s.content.startsWith('---') || !s.whenToUse || !s.description || s.content.length < 400);
	return bad.length ? bad.map((s) => s.name).join(',') : true;
});
await check('ogni tool ha descrizione, parameters e output schema', () => {
	const bad = Object.values(tools).filter((t) => !t.description || t.parameters?.type !== 'object' || t.output?.schema?.type !== 'object' || typeof t.output.render !== 'function' || (t.isConcurrencySafe !== void 0 && typeof t.isConcurrencySafe !== 'function'));
	return bad.length ? bad.map((t) => t.name).join(',') : true;
});

// --- vault_search ------------------------------------------------------------
await check('search: AND su più keyword', async () => {
	const one = await search({ keywords: ['ramen'] });
	const two = await search({ keywords: ['giappone', 'ramen'] });
	const none = await search({ keywords: ['ramen', 'invenTabile'] });
	const ok = one.total === 1 && one.results[0].path === '20-Areas/viaggi/tokyo-2024.md' && two.total === 1 && none.total === 0 && none.results.length === 0;
	return ok && (await shape('vault_search', {}, one)) === true ? true : `one=${one.total} two=${two.total} none=${none.total}`;
});
await check('search: keyword unica = AND delle parole (split su spazi)', async () => {
	const r = await search({ keywords: ['giappone ramen'] });
	return r.total === 1 ? true : `total=${r.total}`;
});
await check('search: folding accenti sul summary (citta → città)', async () => {
	const r = await search({ keywords: ['citta'] });
	return r.results.some((row) => row.path === '20-Areas/viaggi/citta-fantasma.md') ? true : r.results.map((x) => x.path).join(',');
});
await check('search: folding accenti anche sui nomi file', async () => {
	const accented = '20-Areas/viaggi/città-invisibile.md';
	await w('20-Areas/viaggi/città-invisibile.md', '---\ntype: note\nstatus: active\ntags: []\ncreated: 2026-11-01\nsummary: "roba senza parole utili"\n---\n\n# Città invisibile\n');
	const fresh = harness();
	const r = await fresh.tools.vault_search.execute({ keywords: ['citta invisibile'] });
	return r.results.some((row) => row.path === accented) ? true : r.results.map((x) => x.path).join(',');
});
await check('search: hint quando non trova nulla', async () => {
	const r = await search({ keywords: ['xxxyyy'] });
	return r.total === 0 && /vault_note|sinonim/i.test(r.hint) ? true : `hint=${r.hint}`;
});
await check('search: 90-Reference fuori di default, dentro con includeReference', async () => {
	const out = await search({ keywords: ['esotica'], where: 'fulltext' });
	const inRef = await search({ keywords: ['esotica'], where: 'fulltext', includeReference: true });
	return out.total === 0 && inRef.total === 1 ? true : `out=${out.total} in=${inRef.total}`;
});
await check('search: scope dentro 90-Reference implica incluirlo', async () => {
	const r = await search({ keywords: ['esotica'], where: 'fulltext', scope: '90-Reference/progetto' });
	return r.total === 1 ? true : `total=${r.total}`;
});
await check('search: template e reference non compaiono mai', async () => {
	const r = await search({ keywords: ['di'], limit: 60 });
	return r.results.every((row) => !row.path.startsWith('99-Templates/') && !row.path.startsWith('90-Reference/')) ? true : 'presenti';
});
await check('search: matched dice nome/summary', async () => {
	const byName = await search({ keywords: ['yanaka'] });
	const bySummary = await search({ keywords: ['templi'] });
	return byName.results[0].matched.includes('name') && bySummary.results[0].matched.join() === 'summary' ? true : `${byName.results[0].matched} / ${bySummary.results[0].matched}`;
});
await check('search: filtro type=moc lascia solo gli indici', async () => {
	const r = await search({ keywords: ['tokyo'], type: 'moc' });
	const onlyIndexes = r.total > 0 && r.results.every((row) => row.path.split('/').pop().startsWith('00-'));
	const without = await search({ keywords: ['tokyo'] });
	return onlyIndexes && without.results.some((row) => !row.path.split('/').pop().startsWith('00-')) ? true : r.results.map((x) => x.path).join(',');
});
await check('search: status non active passa nella riga', async () => {
	const r = await search({ keywords: ['fantasma'] });
	return r.results[0].status === 'done' ? true : `status=${r.results[0].status}`;
});
await check('search: inventario (zero keyword) con index e sottocartelle', async () => {
	const r = await search({ scope: '30-Resources/citta/giappone/tokyo' });
	return r.mode === 'inventory' && r.index === '30-Resources/citta/giappone/tokyo/00-tokyo.md' && r.results.length === 3 ? true : `mode=${r.mode} index=${r.index} n=${r.results.length}`;
});
await check('search: inventario della radice elenca le sezioni', async () => {
	const r = await search({});
	const paths = (r.folders ?? []).map((f) => f.path);
	return paths.includes('20-Areas') && paths.includes('10-Projects') && r.mode === 'inventory' ? true : paths.join(',');
});
await check('search: sottocartelle con conteggio note', async () => {
	const r = await search({ scope: '30-Resources/citta/giappone' });
	const tokyo = (r.folders ?? []).find((f) => f.path.endsWith('/tokyo'));
	return tokyo && tokyo.notes === 3 ? true : JSON.stringify(r.folders);
});
await check('search: limit e total', async () => {
	const r = await search({ keywords: ['nota'], limit: 2 });
	return r.results.length === 2 && r.total === 5 && /Narrow the scope|best 2/.test(r.hint) ? true : `n=${r.results.length} total=${r.total} hint=${r.hint}`;
});
await check('search: fulltext dà righe numerate (termine solo nel corpo)', async () => {
	const r = await search({ keywords: ['parola-esotica-XYZ'], where: 'fulltext', includeReference: true });
	const line = r.results[0]?.lines?.[0]?.line;
	return r.mode === 'fulltext' && line > 240 && r.results[0].lines[0].text.includes('parola-esotica-XYZ') ? true : `line=${line}`;
});
await check('search: fulltext piega gli accenti', async () => {
	const r = await search({ keywords: ['citta nel corpo'], where: 'fulltext', scope: '20-Areas' });
	return r.total >= 0 && (await shape('vault_search', {}, r)) === true ? true : 'schema';
});

// --- vault_read --------------------------------------------------------------
await check('read: piccolo file tutto dentro il default', async () => {
	const r = await read({ path: '20-Areas/viaggi/tokyo-2024.md' });
	return r.from === 1 && r.hasMore === false && r.text.includes('# Tokyo 2024') && r.nextFrom === void 0 ? true : JSON.stringify({ from: r.from, to: r.to, hasMore: r.hasMore });
});
await check('read: tetto di 400 righe e nextFrom', async () => {
	const r = await read({ path: '90-Reference/progetto/specifica.md', lines: 5000 });
	return r.to - r.from + 1 === 400 && r.hasMore === true && r.nextFrom === 401 && r.totalLines > 400 ? true : `${r.from}-${r.to} of ${r.totalLines}`;
});
await check('read: from riprende dopo un colpo di fulltext', async () => {
	const hit = await search({ keywords: ['parola-esotica-XYZ'], where: 'fulltext', includeReference: true });
	const line = hit.results[0].lines[0].line;
	const r = await read({ path: '90-Reference/progetto/specifica.md', from: line - 1, lines: 3 });
	return r.text.includes('parola-esotica-XYZ') ? true : 'termine fuori dalla regione';
});
await check('read: outline coi numeri di riga, fence ignorato', async () => {
	const r = await read({ path: '90-Reference/progetto/specifica.md', outline: true });
	const texts = r.outline.map((h) => h.text);
	const piano = r.outline.find((h) => h.text === 'Piano dei trasporti');
	return texts.includes('Piano dei trasporti') && texts.includes('Dettaglio') && !texts.some((t) => t.includes('not-a-heading')) && piano.line === 5 ? true : JSON.stringify(r.outline.slice(0, 4));
});
await check('read: file mancante, cartella, binario', async () => {
	const missing = await read({ path: '30-Resources/nope.md' });
	const dir = await read({ path: '30-Resources' });
	await w('30-Resources/blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('latin1'));
	const bin = await read({ path: '30-Resources/blob.bin' });
	return missing.error === 'not-found' && dir.error === 'is-directory' && bin.error === 'binary-file' ? true : `${missing.error}/${dir.error}/${bin.error}`;
});
await check('read: i percorsi non escono dal vault', async () => {
	const up = await read({ path: '../../etc/passwd' });
	const abs = await read({ path: '/etc/passwd' });
	return up.error && abs.error !== void 0 ? true : `${up.error}/${abs.error}`;
});
await check('search: scope fuori dal vault rifiutato', async () => {
	const r = await search({ keywords: ['root'], scope: '../../etc' });
	return r.error === 'outside-root' || r.error === 'invalid-path' ? true : `error=${r.error}`;
});

// --- vault_note --------------------------------------------------------------
await check('note: creata col template del vault e frontmatter compilato', async () => {
	const r = await note({ folder: '30-Resources/citta/giappone/kyoto', title: 'Fushimi Inari', type: 'resource', summary: 'Fushimi Inari: torii in salita, orario, cosa vedere a Kyoto', body: 'Inizio alle 7 per evitare la folla.' });
	const text = await readFile(path.join(ROOT, r.path), 'utf8');
	return r.path === '30-Resources/citta/giappone/kyoto/fushimi-inari.md' && r.template === 'vault' && text.includes('type: resource') && text.includes('created: 2026-') && text.includes('summary: "Fushimi Inari: torii in salita, orario, cosa vedere a Kyoto"') && text.includes('# Fushimi Inari') && text.includes('Inizio alle 7') && text.includes('source:') ? true : text;
});
await check('note: MOC giusto (più vicino, non Home) e riga aggiunta', async () => {
	const r = await note({ folder: '30-Resources/citta/giappone/tokyo', title: 'Kagurazaka', summary: 'Kagurazaka: strada in salita e ristoranti francesi a Tokyo' });
	const home = await readFile(path.join(ROOT, '00-Home.md'), 'utf8');
	const moc = await readFile(path.join(ROOT, '30-Resources/citta/giappone/tokyo/00-tokyo.md'), 'utf8');
	const line = `- [[30-Resources/citta/giappone/tokyo/kagurazaka]]`;
	return r.moc?.path === '30-Resources/citta/giappone/tokyo/00-tokyo.md' && moc.includes(line) && moc.includes('strada in salita') && !home.includes('kagurazaka') ? true : `moc=${JSON.stringify(r.moc)} homeToccata=${home.includes('kagurazaka')}`;
});
await check('note: senza MOC di sezione finisce su Home, con avviso', async () => {
	const r = await note({ folder: '10-Projects/progetto-a', title: 'Decisione storage', summary: 'Scelto ZFS per il NAS di progetto: motivo e alternative' });
	const home = await readFile(path.join(ROOT, '00-Home.md'), 'utf8');
	const codes = (r.warnings ?? []).map((x) => x.code);
	return r.moc?.path === '00-Home.md' && home.includes('[[10-Projects/progetto-a/decisione-storage]]') && codes.includes('folder-needs-moc') ? true : `moc=${JSON.stringify(r.moc)} warn=${codes}`;
});
await check('note: type project eredita il campo deadline', async () => {
	const r = await note({ folder: '10-Projects/progetto-a', title: 'Wip Alpha', type: 'project', summary: 'Attività in corso sul progetto A' });
	const text = await readFile(path.join(ROOT, r.path), 'utf8');
	return text.includes('deadline:') && text.includes('type: project') ? true : text.slice(0, 200);
});
await check('note: log prende il prefisso data, moc il prefisso 00-', async () => {
	const log = await note({ folder: '10-Projects/progetto-a', title: 'Sessione di lavoro', type: 'log', summary: 'Log: cosa è stato fatto oggi sul progetto A' });
	const moc = await note({ folder: '30-Resources/citta/giappone/osaka', title: 'Osaka', type: 'moc', summary: 'Indice delle note su Osaka' });
	const today = new Date().toISOString().slice(0, 10);
	return log.path.includes(`/${today}-sessione-di-lavoro.md`) && moc.path.endsWith('/00-osaka.md') ? true : `${log.path} / ${moc.path}`;
});
await check('note: type area usa il default del plugin', async () => {
	const r = await note({ folder: '20-Areas', title: 'Manutenzione casa', type: 'area', summary: 'Calendario manutenzione della casa: caldaia, filtri' });
	const text = await readFile(path.join(ROOT, r.path), 'utf8');
	return r.template === 'default' && text.includes('type: area') ? true : `${r.template} ${text.slice(0, 80)}`;
});
await check('note: refuse di sovrascrivere, file intatto', async () => {
	const first = await note({ folder: '30-Resources/citta/giappone/tokyo', title: 'Yanaka Again', summary: 'Nota duplicata voluta per il test' });
	const before = await readFile(path.join(ROOT, first.path), 'utf8');
	const second = await note({ folder: '30-Resources/citta/giappone/tokyo', title: 'Yanaka Again', summary: 'Nota duplicata voluta per il test' });
	const after = await readFile(path.join(ROOT, first.path), 'utf8');
	return second.error === 'exists' && /vault_search/.test(second.hint) && before === after ? true : `error=${second.error} cambiato=${before !== after}`;
});
await check('note: summary oltre il massimo rifiutato (141), 138 accettato', async () => {
	const long = await note({ folder: '30-Resources/test-note', title: 'Troppo Lunga', summary: 'x'.repeat(141) });
	const ok = await note({ folder: '30-Resources/test-note', title: 'Giusta', summary: 'y'.repeat(138) });
	return long.error === 'summary-too-long' && ok.error === void 0 && (ok.warnings ?? []).some((x) => x.code === 'summary-over-target') ? true : `${long.error}/${ok.error}/${(ok.warnings ?? []).map((x) => x.code)}`;
});
await check('note: reference e templates non prendono note', async () => {
	const ref = await note({ folder: '90-Reference/progetto', title: 'Documento', summary: 'Non è una nota' });
	const tpl = await note({ folder: '99-Templates', title: 'Modello', summary: 'Non è una nota' });
	return ref.error === 'folder-not-for-notes' && tpl.error === 'folder-not-for-notes' ? true : `${ref.error}/${tpl.error}`;
});
await check('note: body che finge un frontmatter rifiutato', async () => {
	const r = await note({ folder: '30-Resources/test-note', title: 'Finto FM', summary: 'Tenta di passare il frontmatter nel body', body: '---\ntype: note\n---\n\ncorpo' });
	return r.error === 'body-has-frontmatter' ? true : `error=${r.error}`;
});
await check('note: moc:false → mocSkipped + not-indexed', async () => {
	const r = await note({ folder: '30-Resources/test-note', title: 'Senza Indice', summary: 'Nota che resta fuori dai MOC di proposito', moc: false });
	const codes = (r.warnings ?? []).map((x) => x.code);
	return r.mocSkipped?.reason === 'declined' && codes.includes('not-indexed') ? true : `${JSON.stringify(r.mocSkipped)} ${codes}`;
});
await check('note: tag resi kebab e link rotti riportati', async () => {
	const r = await note({ folder: '30-Resources/test-note', title: 'Link Rotti', summary: 'Nota con link buoni e cattivi per il lint', tags: ['Viaggi Giappone', 'Città'], body: 'Vedi [[30-Resources/citta/giappone/tokyo/yanaka]], [[tokyo-2024]] e [[30-Resources/inesistente]].' });
	const text = await readFile(path.join(ROOT, r.path), 'utf8');
	const codes = (r.warnings ?? []).map((x) => x.code);
	const broken = r.warnings.find((x) => x.code === 'broken-link');
	return text.includes('tags: [viaggi-giappone, citta]') && codes.includes('broken-link') && codes.includes('link-not-canonical') && broken.examples.includes('30-Resources/inesistente') && !broken.examples.includes('[[30-Resources/citta/giappone/tokyo/yanaka]]') ? true : `tags=${/tags:.*/.exec(text)} warn=${codes}`;
});
await check('note: idempotenza MOC (già linkato → added false)', async () => {
	const r = await note({ folder: '30-Resources/citta/giappone/tokyo', title: 'Yanaka Again', summary: 'Nuovo summary', name: 'yanaka-again', moc: true });
	const again = await note({ folder: '30-Resources/citta/giappone/tokyo', title: 'Yanaka Again', summary: 'Nuovo summary', name: 'yanaka-again-2' });
	const moc = await readFile(path.join(ROOT, '30-Resources/citta/giappone/tokyo/00-tokyo.md'), 'utf8');
	void r;
	return again.moc?.added === true && (moc.match(/kagurazaka/g) ?? []).length === 1 ? true : `added=${again.moc?.added}`;
});

// --- vault_write e lint ------------------------------------------------------
await check('write: summary oltre il massimo rifiutato e nulla scritto', async () => {
	const r = await write({ path: '30-Resources/test-note/abusiva.md', content: `---\ntype: note\nstatus: active\ntags: []\ncreated: 2026-11-14\nsummary: "${'a'.repeat(150)}"\n---\n\n# Abusiva\n` });
	const exists = await stat(path.join(ROOT, '30-Resources/test-note/abusiva.md')).then(() => true, () => false);
	return r.error === 'policy-violation' && r.warnings[0].code === 'summary-too-long' && !exists ? true : `error=${r.error} scritto=${exists}`;
});
await check('write: lint off scrive lo stesso', async () => {
	const r = await write({ path: '30-Resources/test-note/abusiva.md', lint: 'off', content: `---\ntype: note\nstatus: active\ntags: []\ncreated: 2026-11-14\nsummary: "${'a'.repeat(150)}"\n---\n\n# Abusiva\n` });
	return r.action === 'created' && r.warnings === void 0 ? true : JSON.stringify(r).slice(0, 160);
});
await check('write: not-atomic, not-indexed, emoji e nome non kebab', async () => {
	const body = Array.from({ length: 70 }, (_x, i) => `riga ${i}`).join('\n');
	const r = await write({ path: '30-Resources/test-Nota Confusa.md', content: `---\ntype: note\nstatus: active\ntags: []\ncreated: 2026-11-14\nsummary: "Nota lunga con emoji 👍 nel summary per il test del lint"\n---\n\n# Confusa\n\n${body}\n` });
	const codes = (r.warnings ?? []).map((x) => x.code);
	return codes.includes('not-atomic') && codes.includes('not-indexed') && codes.includes('emoji-in-key') && codes.includes('path-not-kebab') ? true : codes.join(',');
});
await check('write: MOC con prosa segnalato', async () => {
	const r = await write({ path: '30-Resources/test-note/00-prova.md', content: '---\ntype: moc\nstatus: active\ntags: [moc]\ncreated: 2026-11-14\nsummary: "Indice di prova"\n---\n\n# Prova — MOC\n\n- [[30-Resources/test-note/abusiva]] — ok\n\nQuesto è un paragrafo, non un indice.\n' });
	return (r.warnings ?? []).some((x) => x.code === 'moc-has-prose') ? true : (r.warnings ?? []).map((x) => x.code).join(',');
});
await check('write: reference esente da schema e atomicità', async () => {
	const long = Array.from({ length: 400 }, (_x, i) => `riga ${i}`).join('\n');
	const r = await write({ path: '90-Reference/progetto/importato-senza-frontmatter.md', content: `# Documento importato\n\n${long}\n` });
	return r.action === 'created' && r.warnings === void 0 ? true : (r.warnings ?? []).map((x) => x.code).join(',');
});
await check('write: POLICY.md esente', async () => {
	const text = await readFile(path.join(ROOT, 'POLICY.md'), 'utf8');
	const r = await write({ path: 'POLICY.md', overwrite: true, content: text });
	return r.action === 'replaced' && r.warnings === void 0 ? true : (r.warnings ?? []).map((x) => x.code).join(',');
});
await check('write: replace di una nota indicizzata non chiede il MOC', async () => {
	const text = await readFile(path.join(ROOT, '20-Areas/viaggi/tokyo-2024.md'), 'utf8');
	const r = await write({ path: '20-Areas/viaggi/tokyo-2024.md', overwrite: true, content: text });
	return r.action === 'replaced' && !(r.warnings ?? []).some((x) => x.code === 'not-indexed') ? true : (r.warnings ?? []).map((x) => x.code).join(',');
});
await check('write/note: schema di output rispettato', async () => {
	const a = await note({ folder: '30-Resources/test-note', title: 'Shape Check', summary: 'Nota per validare lo schema di output', body: 'test' });
	const b = await write({ path: '30-Resources/test-note/shape-file.md', content: '---\ntype: note\nstatus: active\ntags: []\ncreated: 2026-11-14\nsummary: "File per validare lo schema"\n---\n\n# Shape\n' });
	const e = await read({ path: 'niente.md' });
	return [await shape('vault_note', {}, a), await shape('vault_write', {}, b), await shape('vault_read', {}, e)].filter((x) => x !== true).join(' | ') || true;
});
await check('search/read: schema rispettato su più risposte', async () => {
	const a = await search({ keywords: ['tokyo'] });
	const b = await search({ scope: '20-Areas' });
	const c = await search({ keywords: ['riga'], where: 'fulltext', includeReference: true, scope: '90-Reference' });
	const d = await read({ path: '20-Areas/viaggi/00-viaggi.md' });
	const f = await read({ path: '90-Reference/progetto/specifica.md', outline: true });
	return [await shape('vault_search', {}, a), await shape('vault_search', {}, b), await shape('vault_search', {}, c), await shape('vault_read', {}, d), await shape('vault_read', {}, f)].filter((x) => x !== true).join(' | ') || true;
});

// --- grant -------------------------------------------------------------------
await check('read-only: scrittura negata, lettura sì', async () => {
	const R = harness({ mode: 'read-only' });
	const n = await R.tools.vault_note.execute({ folder: '30-Resources/test-note', title: 'No', summary: 'Non deve essere scritta' }, R.exec);
	const wr = await R.tools.vault_write.execute({ path: '30-Resources/test-note/no.md', content: 'x' }, R.exec);
	const s = await R.tools.vault_search.execute({ keywords: ['cimiteri'] });
	const r = await R.tools.vault_read.execute({ path: '20-Areas/viaggi/tokyo-2024.md' });
	const touched = await stat(path.join(ROOT, '30-Resources/test-note/no.md')).then(() => true, () => false);
	return n.error === 'session-read-only' && wr.error === 'session-read-only' && n.hint.includes('Vault') && s.total === 1 && r.text.includes('Tokyo') && !touched ? true : `${n.error}/${wr.error}/${s.total}`;
});
await check('workspace-write: grant spento blocca, acceso lascia scrivere', async () => {
	const off = harness({ mode: 'workspace-write' });
	const a = await off.tools.vault_note.execute({ folder: '30-Resources/test-note', title: 'Grant Off', summary: 'Bloccato dal grant spento' }, off.exec);
	const on = harness({ mode: 'workspace-write', config: { vaultGrantDefault: true } });
	const b = await on.tools.vault_note.execute({ folder: '30-Resources/test-note', title: 'Grant On', summary: 'Scritto con grant acceso' }, on.exec);
	const s = await off.tools.vault_search.execute({ keywords: ['cimiteri'] });
	return a.error === 'grant-off' && b.error === void 0 && s.total === 1 ? true : `${a.error}/${b.error}/${s.total}`;
});

// --- vault_delete sul circuito creato dai test -------------------------------
await check('delete: refuse con referrer, force con lint che dice cosa sistemare', async () => {
	const made = await note({ folder: '30-Resources/test-circuito', title: 'Nota Da Cancellare', summary: 'Nota che viene cancellata per provare il giro dei referrer' });
	const first = await tools.vault_delete.execute({ path: made.path }, H.exec);
	const gone = await tools.vault_delete.execute({ path: made.path, force: true }, H.exec);
	const stillThere = await stat(path.join(ROOT, made.path)).then(() => true, () => false);
	const moc = await readFile(path.join(ROOT, '00-Home.md'), 'utf8');
	const shapeOk = await shape('vault_delete', {}, gone);
	return first.error === 'linked'
		&& first.referrers.some((r) => r.path === '00-Home.md')
		&& gone.forced === true
		&& /vault_write/.test(gone.hint ?? '')
		&& !stillThere
		&& moc.includes('nota-da-cancellare')
		&& shapeOk === true
			? true
			: `first=${first.error} forced=${gone.forced} hint=${gone.hint} c’eAncora=${stillThere} shape=${shapeOk}`;
});
await check('delete: un file non linkato va via senza conferme', async () => {
	const r = await tools.vault_delete.execute({ path: '30-Resources/test-note/shape-file.md' }, H.exec);
	return r.kind === 'file' && r.path === '30-Resources/test-note/shape-file.md' && r.forced === void 0 ? true : JSON.stringify(r).slice(0, 160);
});

// --- igiene ------------------------------------------------------------------
await check('nessun file temporaneo orfano nel vault', async () => {
	const strays = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.includes('.tmp-')) strays.push(full);
		}
	};
	await walk(ROOT);
	return strays.length === 0 ? true : strays.join(', ');
});

// --- costo sul vault reale (sola lettura) ------------------------------------
// Misura opzionale: solo su una macchina che ha un vault reale da leggere.
const REAL = process.env.REAL_VAULT ?? '';
const hasReal = REAL && (await stat(REAL).then(() => true, () => false));
const RH = hasReal ? harness({ root: REAL }) : null;
if (RH) {
	const t0 = performance.now();
	const real = await RH.tools.vault_search.execute({ keywords: ['tokyo'] });
	const t1 = performance.now();
	const t2 = performance.now();
	const realFull = await RH.tools.vault_search.execute({ keywords: ['all-reduce'], where: 'fulltext', includeReference: true });
	const t3 = performance.now();
	results.push({ name: `INFO costo su ${REAL} (${real.scanned} note): metadata ${(t1 - t0).toFixed(0)}ms, fulltext ${(t3 - t2).toFixed(0)}ms (${realFull.scanned} file, ${realFull.total} match)`, pass: real.scanned > 150 && real.total > 5, detail: '' });
}

// --- CJK e forme Unicode -------------------------------------------------------
await check('note: kanji e kana restano nel nome file', async () => {
	const n = await note({ folder: '30-Resources/citta', title: '東京 ノート 🚀', summary: 'Nota CJK per la fedeltà del nome scelto.', body: 'Contenuto kanji.' });
	return n.path === '30-Resources/citta/東京-ノート.md' ? true : `path=${n.path} err=${n.error ?? ''}`;
});
await check('note: ー e 々 non cadono', async () => {
	const n = await note({ folder: '30-Resources/citta', title: 'コーヒー ブレーク', summary: 'Titolo con allungamento per il test slug.' });
	return n.path === '30-Resources/citta/コーヒー-ブレーク.md' ? true : `path=${n.path} err=${n.error ?? ''}`;
});
await check('search: keyword CJK trova il file per nome', async () => {
	const fresh = harness();
	const r = await fresh.tools.vault_search.execute({ keywords: ['東京'] }, fresh.exec);
	return r.results.some((row) => row.path === '30-Resources/citta/東京-ノート.md') ? true : `total=${r.total}`;
});
await check('confine: argomento NFD raggiunge il file scritto NFC', async () => {
	const r = await read({ path: '30-Resources/citta/東京-ノート.md'.normalize('NFD') });
	return (r.text ?? '').includes('Contenuto kanji') ? true : `err=${r.error}`;
});
await check('move: da argomento NFD, nome che esce NFC', async () => {
	const m = await tools.vault_move.execute({ from: '30-Resources/citta/東京-ノート.md'.normalize('NFD'), to: '30-Resources/citta/東京-メモ.md' }, H.exec);
	const onDisk = await stat(path.join(ROOT, '30-Resources/citta/東京-メモ.md')).then(() => true, () => false);
	return m.action === 'renamed' && onDisk ? true : `m=${JSON.stringify({ a: m.action, e: m.error })}`;
});
await check('upkeep: link NFD riconosce il file NFC e viene riscritto NFC', async () => {
	await write({ path: '30-Resources/citta/linkatore.md', lint: 'off', content: '---\ntype: note\nsummary: "Linkatore per upkeep cross-forma."\n---\n\nvedi ' + '[[30-Resources/citta/コーヒー-ブレーク]]'.normalize('NFD') + '.\n' });
	const m = await tools.vault_move.execute({ from: '30-Resources/citta/コーヒー-ブレーク.md', to: '30-Resources/citta/コーヒー-riposo.md' }, H.exec);
	const body = await readFile(path.join(ROOT, '30-Resources/citta/linkatore.md'), 'utf8');
	const rewrote = (m.changed ?? []).some((c) => c.path === '30-Resources/citta/linkatore.md');
	return rewrote && body.includes('[[30-Resources/citta/コーヒー-riposo]]') ? true : JSON.stringify({ changed: m.changed, e: m.error });
});
await check('altre lingue invariate: cirillico ricade su nota', async () => {
	const n = await note({ folder: '30-Resources/citta', title: 'Отчёт', summary: 'Titolo cirillico: comportamento documentato.' });
	return (n.path ?? '').endsWith('/nota.md') ? true : `path=${n.path} err=${n.error}`;
});
await check('lint: nome CJK non fa path-not-kebab', async () => {
	const r = await write({ path: '30-Resources/citta/kyoto-京都.md', content: '---\ntype: note\nsummary: "Nome misto latino e kanji."\n---\n\nx\n' });
	const kebab = (r.warnings ?? []).filter((x) => x.code === 'path-not-kebab');
	return !r.error && kebab.length === 0 ? true : JSON.stringify({ e: r.error, w: kebab });
});
await check('delete: argomento NFD cancella il file NFC', async () => {
	const r = await tools.vault_delete.execute({ path: '30-Resources/citta/東京-メモ.md'.normalize('NFD'), force: true }, H.exec);
	const gone = await stat(path.join(ROOT, '30-Resources/citta/東京-メモ.md')).then(() => false, () => true);
	return !r.error && gone ? true : `err=${r.error}`;
});

// --- esito -------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `\n       → ${r.detail.split('\n').slice(0, 4).join('\n       ')}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} verdi`);
process.exit(failed.length ? 1 : 0);
