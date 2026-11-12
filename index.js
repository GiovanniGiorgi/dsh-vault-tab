// Host half of @local/dsh-vault-tab: one exact JSON route listing one level of
// the configured root. The root is pinned in the patch row's config; any
// requested path is resolved and must stay under it. File previews do not go
// through this route: the Client opens the built-in Document viewer, whose
// reads follow the Session's own file-read authority.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const inject = ['webServer'];

/**
 * The row's config. `root` is editable from the plugin's card in the Plugins
 * panel (configForms writes it into the profile patch and Loader re-activates
 * this row, so the route re-registers with the new value). An empty root keeps
 * the tab registered but inert; the Client shows a hint instead of a tree.
 */
export const Config = z.object({
	root: z
		.string()
		.default('')
		.description('Absolute path of the folder the Vault tab lists (empty: unset).'),
});

/** Entries reported per level before the list is cut, mirroring the workspace file cap. */
const MAX_ENTRIES = 1000;

function json(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

export function apply(ctx, config) {
	const raw = config && typeof config.root === 'string' ? config.root : '';
	const root = raw ? path.resolve(raw) : '';
	const handler = async (req, res) => {
		if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
		if (!root) return json(res, 200, { root: '', entries: [], truncated: false });
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
}
