// Reverse-proxy passthrough for the headless Worker.
//
// When the Worker runs on a *route* (example.com/*) in front of the
// WordPress origin, the requests WordPress must handle itself — admin,
// login, REST, cron, wp-content, feeds, sitemaps, and every write — are
// forwarded to origin with fetch(request). Cloudflare sends a subrequest
// to the Worker's own route to the origin instead of re-invoking the
// Worker, so this is a transparent pass-through. Anything NOT matched here
// is rendered by Astro.
//
// The defaults below MUST stay a superset of the known-safe WordPress
// surface. Operators can extend them with the SQHEADLESS-managed
// BYPASS_PATHS var (newline- or comma-separated) when a plugin exposes an
// unusual path we've never seen.

import { envStr } from './runtime-env';

// Path prefixes: pathname starts with one of these → origin.
// /wp-content is here, but the more-specific media Worker route
// (/wp-content/uploads/*) intercepts uploads first, so in practice this
// only forwards /wp-content/plugins, /themes, /mu-plugins to origin.
const DEFAULT_PREFIXES = [
	'/wp-admin/',
	'/wp-includes/',
	'/wp-content/',
	'/wp-json/',
	'/.well-known/',
];

// Exact files → origin.
const DEFAULT_EXACT = [
	'/wp-login.php',
	'/wp-cron.php',
	'/xmlrpc.php',
	'/wp-comments-post.php',
	'/wp-signup.php',
	'/wp-activate.php',
	'/wp-trackback.php',
	'/wp-links-opml.php',
];

// Feeds (/feed/, /category/x/feed/, …): no template to render, served and
// cached from origin.
const DEFAULT_SUFFIXES = ['/feed/', '/feed'];

// Core (/wp-sitemap*.xml) and SEO-plugin (/sitemap_index.xml, *-sitemap.xml)
// sitemaps → origin.
// Sitemaps THIS WORKER renders itself, from its own route files. They must
// never be forwarded: the passthrough check runs before routing, so a match
// here means the route file is dead code and the visitor gets whatever the
// origin says — which for these paths is a 301 or a 404, and the 301 is what
// surfaces as a 522.
//
// Keep this in sync with src/pages/*sitemap*.xml.ts. Anything sitemap-shaped
// that this Worker does NOT implement (/wp-sitemap*.xml from core,
// /sitemap_index.xml from an SEO plugin) still belongs to the origin.
const OWN_SITEMAPS = new Set(['/sitemap.xml']);

const SITEMAP_RE = /^\/wp-sitemap.*\.xml$|^\/sitemap(_index)?\.xml$|-sitemap\.xml$/i;

// Query params that always denote content WordPress must resolve. NOTE: `s`
// (search) is intentionally absent — in headless, Astro owns /search/, so
// search is NOT bypassed. `p`/`page_id` are here so WP issues the canonical
// redirect from an id-based permalink to the pretty slug Astro then serves.
const DEFAULT_QUERY_PARAMS = [
	'preview',
	'preview_id',
	'preview_nonce',
	'p',
	'page_id',
	'attachment_id',
	'replytocom',
	'unapproved',
];

function parseExtra(raw: string): string[] {
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * True when the request must be handled by the WordPress origin rather than
 * rendered by Astro.
 */
export function shouldPassThrough(request: Request, url: URL): boolean {
	// Every write and non-GET/HEAD verb goes to origin.
	const method = request.method;
	if (method !== 'GET' && method !== 'HEAD') return true;

	const path = url.pathname;

	for (const p of DEFAULT_PREFIXES) if (path.startsWith(p)) return true;
	for (const p of DEFAULT_EXACT) if (path === p) return true;
	for (const s of DEFAULT_SUFFIXES) if (path.endsWith(s)) return true;
	if (SITEMAP_RE.test(path) && !OWN_SITEMAPS.has(path)) return true;
	for (const q of DEFAULT_QUERY_PARAMS) if (url.searchParams.has(q)) return true;

	// Operator-supplied extras appended to the built-in list. An entry
	// ending in `/` is a prefix; anything else is an exact path.
	for (const e of parseExtra(envStr('BYPASS_PATHS', ''))) {
		if (e.endsWith('/')) {
			if (path.startsWith(e)) return true;
		} else if (path === e) {
			return true;
		}
	}

	return false;
}

/**
 * Forward the request to the WordPress origin. Cloudflare routes a
 * same-route subrequest to origin (not back into this Worker), so this is a
 * transparent proxy. The origin response is passed through unchanged, so
 * WordPress's own cache-control wins: cacheable assets/feeds/sitemaps stay
 * cacheable at the edge, while admin/REST/preview responses carry their own
 * no-store from WordPress.
 */
export async function passThroughToOrigin(request: Request): Promise<Response> {
	const response = await fetch(request);
	const headers = new Headers(response.headers);
	headers.set('x-staticq-proxy', 'origin');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
