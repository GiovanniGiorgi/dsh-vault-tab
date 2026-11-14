// CASO CANONICO del piano vault-link-upkeep: link assoluti dalla radice, senza
// alias, case-sensitive. Esegue le funzioni VERE di index.js su un vault finto.
import { readdir, readFile, writeFile, rm, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'index.js');
const text = await readFile(SRC, 'utf8');
const slice = (a0, b0) => { const a = text.indexOf(a0), b = text.indexOf(b0, a); if (a < 0 || b < 0) throw new Error('marker: ' + (a < 0 ? a0 : b0)); return text.slice(a, b); };
const build = new Function('readdir', 'readFile', 'writeFile', 'path', 'MAX_WRITE_BYTES', 'LINK_SCAN_CAP', 'LINK_REPORT_CAP', 'rename', 'rm',
	`${slice('/**\n * One vault link', '\n/**\n * Resolve `rel` under `root`')}\nreturn { scanLinks, applyLinkRewrite, linkPath, refersTo };`);
const E = build(readdir, readFile, writeFile, path, 1 << 20, 4000, 40, rename, rm);

const root = process.env.VAULT_FIXTURE ? path.join(process.env.VAULT_FIXTURE, 'dsh-vault-tab-canonical') : path.join(os.tmpdir(), 'dsh-vault-tab-canonical');
await rm(root, { recursive: true, force: true });
const w = async (rel, c) => { const f = path.join(root, rel); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, c, 'utf8'); };

// Il bersaglio canonico
await w('30-Resources/citta/nagano.md', '# Nagano\nTesto.\n');
// Referrer canonico: link wiki assoluto, frontmatter source, embed immagine
await w('10-Projects/moc.md', ['---', 'source: "[[30-Resources/citta/nagano]]"', '---', '# MOC', '- [[30-Resources/citta/nagano]] — stazione',].join('\n'));
// Cose che NON vanno mai toccate
await w('30-Resources/altro.md', ['Corto: [[nagano]]', 'Markdown assoluto: [N](https://example.org/nagano)', 'Markdown relativo: [G](../Gufo/casa.md)', 'Markdown .md relativo: [A](citta/nagano.md)', 'Case-different: [[30-Resources/citta/Nagano]]'].join('\n'));
// Dentro un fence: esempio, non link
await w('99-Templates/note.md', ['```', '- [[30-Resources/citta/nagano]] — esempio nel template', '```'].join('\n'));
// Immagine: l embed canonico
await w('30-Resources/img/mappa.png', 'PNG');
await w('30-Resources/guida.md', 'Vedi ![[30-Resources/img/mappa.png]]');

const R = []; const check = (n, c, d) => R.push({ n, pass: !!c, d });

// --- MOSSA CANONICA: 30-Resources/citta/nagano -> 40-Archive/citta/nagano ----
const rw = await E.applyLinkRewrite(root, '30-Resources/citta/nagano', '40-Archive/citta/nagano', false);
const moc = await readFile(path.join(root, '10-Projects/moc.md'), 'utf8');
check('moc: link aggiornato', moc.includes('- [[40-Archive/citta/nagano]] — stazione'));
check('frontmatter source: aggiornato (piano §3.2)', moc.includes('source: "[[40-Archive/citta/nagano]]"'));
const altro = await readFile(path.join(root, '30-Resources/altro.md'), 'utf8');
check('short link intatto', altro.includes('[[nagano]]'));
check('markdown http intatto', altro.includes('[N](https://example.org/nagano)'));
check('markdown ../Gufo intatto', altro.includes('[G](../Gufo/casa.md)'));
check('markdown .md relativo intatto', altro.includes('[A](citta/nagano.md)'));
check('case-different NON riscritto (match esatto)', altro.includes('[[30-Resources/citta/Nagano]]'));
check('solo il moc cambiato', rw.changed.length === 1 && rw.changed[0].path === '10-Projects/moc.md', JSON.stringify(rw.changed));
check('fence del template intatto', (await readFile(path.join(root, '99-Templates/note.md'), 'utf8')).includes('- [[30-Resources/citta/nagano]] — esempio'));

// --- MOSSA DI CARTELLA: prefisso ------------------------------------------
const rw2 = await E.applyLinkRewrite(root, '40-Archive/citta', '30-Resources/citta2', true);
check('folder: prefisso aggiornato', rw2.changed.some((c) => c.path === '10-Projects/moc.md') && (await readFile(path.join(root, '10-Projects/moc.md'), 'utf8')).includes('[[30-Resources/citta2/nagano]]'));

// --- DELETE CHECK: il file è linkato -> referrer esterni --------------------
const scan = await E.scanLinks(root, '30-Resources/citta2/nagano', false, '30-Resources/citta2/nagano');
check('delete: 2 referrer nel moc (frontmatter+corpo)', scan.hits === 2 && scan.referrers.every((r) => r.path === '10-Projects/moc.md'), JSON.stringify(scan));

// --- EMBED IMMAGINE: estensione non .md -------------------------------------
const rw3 = await E.applyLinkRewrite(root, '30-Resources/img/mappa.png', '30-Resources/img/mappa-vecchia.png', false);
check('embed immagine aggiornato', (await readFile(path.join(root, '30-Resources/guida.md'), 'utf8')).includes('![[30-Resources/img/mappa-vecchia.png]]'), JSON.stringify(rw3.changed));
check('nessun file .tmp orfano', !(await readdir(root)).some((f) => f.includes('.tmp-')) && !(await readdir(path.join(root, '30-Resources'))).some((f) => f.includes('.tmp-')));

console.log('CASO CANONICO — vault-link-upkeep.md');
for (const r of R) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.n + (r.pass ? '' : '\n      ' + r.d));
const f = R.filter((r) => !r.pass).length; console.log(R.length + ' checks, ' + f + ' falliti');
