// Test del link engine del vault-tab: estrae le funzioni VERE da index.js e le
// esegue su un vault temporaneo. Nessuna copia manuale della logica.
import { readdir, readFile, writeFile, rm, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'index.js');
const text = await readFile(SRC, 'utf8');

function slice(startMark, endMark) {
	const a = text.indexOf(startMark);
	const b = text.indexOf(endMark, a);
	if (a < 0 || b < 0) throw new Error('marker not found: ' + (a < 0 ? startMark : endMark));
	return text.slice(a, b);
}

const engineSrc = slice('/**\n * One vault link', '\n/**\n * Resolve `rel` under `root`');
const foldSrc = slice('/** Collapse per-line link hits', '\nfunction moveTool');

const build = new Function(
	'readdir',
	'readFile',
	'writeFile',
	'path',
	'MAX_WRITE_BYTES',
	'LINK_SCAN_CAP',
	'LINK_REPORT_CAP',
	'rename',
	'rm',
	`${engineSrc}\n${foldSrc}\nreturn { LINK_PATTERN, linkPath, refersTo, proseLines, inFolders, collectMarkdown, relPath, scanLinks, applyLinkRewrite, foldHits, upkeepFields, LINK_SCAN_CAP, LINK_REPORT_CAP, IMMUTABLE_LINK_DIRS, PROTECTED_DELETE_DIRS };`,
);
const E = build(readdir, readFile, writeFile, path, 1 << 20, 4000, 40, rename, rm);

// --- vault temporaneo -------------------------------------------------------
const root = process.env.VAULT_FIXTURE ? path.join(process.env.VAULT_FIXTURE, 'dsh-vault-tab-links') : path.join(os.tmpdir(), 'dsh-vault-tab-links');
await rm(root, { recursive: true, force: true });
const w = async (rel, content) => {
	const full = path.join(root, rel);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, content, 'utf8');
};
await w(
	'10-Projects/moc.md',
	['# MOC', '- [[10-Projects/parigi]] — capitale', '- [[10-Projects/parigi|Parigi vecchia]] — alias', '', '```', '- [[10-Projects/parigi]] — dentro un fence: esempio', '```'].join('\n'),
);
await w('10-Projects/parigi.md', '# Parigi\nVedi [[10-Projects/citta-france|moc figlie]].\n');
await w('10-Projects/citta-france.md', '# Figlie\n- [[10-Projects/parigi]]\n- [[10-Projects/parigi#storia]]\n- ![[10-Projects/parigi]]\n- [[10-Projects/parigi.md]]\n- [[<path/from/root>]] — placeholder\n- [[10-Projects/parigi/]] — trailing\n');
await w('90-Reference/libro.md', 'Da riferimento: [[10-Projects/parigi]]\n');
await w('30-Resources/altro.md', 'Nessun collegamento qui.\n');
// cartella con auto-link interni (caso delete)
await w('40-Archive/projX/index.md', '- [[40-Archive/projX/nota-interna]]\n');
await w('40-Archive/projX/nota-interna.md', '# interna\n');
await w('30-Resources/esterna.md', 'Guarda [[40-Archive/projX/nota-interna]]\n');

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

// 1) scan di un file: link: 4 reali (parigi, anchor, embed, .md) + 1 fence + 1 placeholder
const scanFile = await E.scanLinks(root, '10-Projects/parigi', false);
check('scan: hits reali = 7 (fence e placeholder esclusi)', scanFile.hits === 7, `hits=${scanFile.hits} scanned=${scanFile.scanned}`);
check('scan: il fence non compare', !scanFile.referrers.some((r) => r.text.includes('fence')), JSON.stringify(scanFile.referrers.map((r) => r.text)));

// 2) BUG fences: rewrite vs scan
const rw = await E.applyLinkRewrite(root, '10-Projects/parigi', '40-Archive/parigi-vecchia', false);
const moc = await readFile(path.join(root, '10-Projects/moc.md'), 'utf8');
const fencedStill = moc.includes('- [[10-Projects/parigi]] — dentro un fence: esempio');
check('BUG-1: il rewrite lascia intatto il fence', fencedStill, JSON.stringify(moc.split('\n').filter((l) => l.includes('[['))));
check('rewrite: changed lista moc', rw.changed.some((c) => c.path === '10-Projects/moc.md'), JSON.stringify(rw.changed));
check('rewrite: untouchable su 90-Reference', rw.untouchable.some((u) => u.path === '90-Reference/libro.md'), JSON.stringify(rw.untouchable));

// 3) anchor/alias/embed preservati, .md normalizzato
const figlie = await readFile(path.join(root, '10-Projects/citta-france.md'), 'utf8');
check('alias preservato', moc.includes('[[40-Archive/parigi-vecchia|Parigi vecchia]]'));
check('anchor preservato', figlie.includes('[[40-Archive/parigi-vecchia#storia]]'));
check('embed aggiornato', figlie.includes('![[40-Archive/parigi-vecchia]]'));
check('.md normalizzato', figlie.includes('[[40-Archive/parigi-vecchia]]') && !figlie.includes('.md]]'));
check('placeholder intatto', figlie.includes('[[<path/from/root>]]'));

// 4) delete di una cartella: gli auto-link INTERNI non devono bloccare
const scanX = await E.scanLinks(root, '40-Archive/projX', true);
const selfHits = scanX.referrers.filter((r) => r.path.startsWith('40-Archive/projX/'));
check('scan folder: referrer esterni separati (esterna.md presente)', scanX.referrers.some((r) => r.path === '30-Resources/esterna.md'), JSON.stringify(scanX.referrers.map((r) => r.path)));
console.log('scanX hits=', scanX.hits, 'referrers=', JSON.stringify(scanX.referrers.map((r) => r.path + ':' + r.line)));

// 5) delete con skip: gli auto-link dentro il bersaglio non contano
const scanDel = await E.scanLinks(root, '40-Archive/projX', true, '40-Archive/projX');
check('delete skip: nessun referrer interno', !scanDel.referrers.some((r) => r.path.startsWith('40-Archive/projX')), JSON.stringify(scanDel.referrers.map((r) => r.path)));
check('delete skip: il link esterno resta', scanDel.referrers.some((r) => r.path === '30-Resources/esterna.md'));

// 6) riscrittura non tocca quello che non c'entra
const altro = await readFile(path.join(root, '30-Resources/altro.md'), 'utf8');
check('file senza link intatto', altro === 'Nessun collegamento qui.\n');

console.log('');
for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.pass ? '' : '\n      ' + r.detail));
const fails = results.filter((r) => !r.pass).length;
console.log('\n' + results.length - 0 + ' checks, ' + fails + ' falliti');
process.exitCode = 0;
