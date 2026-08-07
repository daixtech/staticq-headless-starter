// Uploads this build's /_astro/ output to R2 so it stays reachable after a
// later deploy removes it.
//
// WHY: a Worker deploy replaces the static-asset manifest wholesale. Assets
// are content-hashed, so anything whose content changed ships under a new
// name and the old name stops being served — while the HTML referencing it
// sits in R2 and the edge cache, untouched by the deploy, and keeps asking
// for the old name. One shared stylesheet is on every page, so a single
// design change strips CSS from the whole cached site until every page is
// re-rendered.
//
// Each build archiving ITSELF is what makes the set cumulative: run this on
// every deploy and every asset ever shipped stays fetchable, so cached HTML
// always resolves against the exact build it was rendered with.
// src/lib/asset-archive.ts serves them on a manifest miss.
//
// ORDERING: run BEFORE `wrangler deploy`. Uploading after would leave a
// window where the new Worker is live, the previous build's assets are gone
// from the manifest, and the archive does not have this build yet.
//
// Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (same pair
// inject-live-bindings.mjs uses; the token needs R2 write). The bucket is
// discovered from the R2 binding in dist/server/wrangler.json rather than
// configured here, so no account-specific value lands in this repo — same
// policy as the bindings script.
//
// Failure is non-fatal by design. A deploy that ships without archiving is
// the old behaviour, and blocking a deploy on the archive step would be a
// worse outcome than the cosmetic breakage it prevents.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const KEY_PREFIX = 'assets';
const ASSETS_DIR = resolve('dist/client/_astro');
const WRANGLER_JSON = resolve('dist/server/wrangler.json');

// The Worker restores Content-Type from R2 http metadata, so it is set here
// at upload time. Anything not listed falls back to octet-stream, which is
// wrong for rendering but still lets the file download — a missing entry
// should degrade, not fail.
const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
};

function bail(message) {
	console.log(`[archive-assets] ${message} — skipping (deploy continues)`);
	process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) bail('CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set');
if (!existsSync(ASSETS_DIR)) bail(`no ${ASSETS_DIR} — was 'astro build' run first?`);
if (!existsSync(WRANGLER_JSON)) bail(`missing ${WRANGLER_JSON}`);

// Same binding the page cache uses. inject-live-bindings.mjs runs first and
// writes the live Worker's bindings here, so this reads the bucket the
// deployed Worker will actually be reading from.
let bucketName;
try {
	const cfg = JSON.parse(readFileSync(WRANGLER_JSON, 'utf8'));
	const binding = (cfg.r2_buckets ?? []).find((b) => b.binding === 'PAGES');
	bucketName = binding?.bucket_name;
} catch (err) {
	bail(`could not read ${WRANGLER_JSON}: ${err.message}`);
}
if (!bucketName) {
	bail('no PAGES R2 binding in wrangler.json (run inject-live-bindings.mjs first, or attach the binding via the WP wizard)');
}

const files = readdirSync(ASSETS_DIR).filter((f) => statSync(join(ASSETS_DIR, f)).isFile());
if (files.length === 0) bail('no files in _astro to archive');

let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const name of files) {
	// Mirrors the request path: /_astro/<name> -> assets/_astro/<name>
	const key = `${KEY_PREFIX}/_astro/${name}`;
	const url = `${CF_API}/accounts/${account}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`;

	// Content-hashed names mean an existing key already holds identical
	// bytes, so re-uploading it every deploy is pure waste. HEAD first and
	// skip — this is what keeps the step cheap as the archive grows.
	try {
		const head = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
		if (head.ok) {
			skipped++;
			continue;
		}
	} catch {
		// Fall through and attempt the upload.
	}

	try {
		const body = readFileSync(join(ASSETS_DIR, name));
		const res = await fetch(url, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
			},
			body,
		});
		if (res.ok) {
			uploaded++;
		} else {
			failed++;
			console.log(`[archive-assets] ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
		}
	} catch (err) {
		failed++;
		console.log(`[archive-assets] ${name}: ${err.message}`);
	}
}

console.log(
	`[archive-assets] bucket ${bucketName}: ${uploaded} uploaded, ${skipped} already present, ${failed} failed`,
);
if (failed > 0) {
	// Loud but not fatal: pages cached against THIS build would lose their
	// assets at the next deploy, which is worth seeing in the log without
	// failing a deploy that is otherwise fine.
	console.log('[archive-assets] WARNING: some assets are not archived; a future deploy may orphan pages cached against this build');
}
