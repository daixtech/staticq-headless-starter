import { joinInflight } from './wp/shared-inflight';
/**
 * WordPress Site Icon resolution for the first-party favicon routes
 * (/favicon.ico, /apple-touch-icon.png).
 *
 * The icon set in WP admin (Settings → General → Site Icon, or
 * Customizer → Site Identity) is exposed by WordPress core on the REST
 * index — GET /wp-json/ → `site_icon_url` (WP 5.9+) — so this needs no
 * plugin support and works against any reasonably current WordPress.
 *
 * Design: the HTML head always points at the stable first-party paths;
 * these routes proxy whatever icon WP currently has. That keeps the
 * icon out of the cached page HTML entirely — changing the Site Icon
 * in WP propagates via the routes' own edge-cache TTL (one day, see
 * EDGE_TTL_SECONDS) without purging a single page.
 */
import { WP_BASE_URL } from './wp/env';
import { wpBundleHeaders } from './wp/transport';
import { IS_STAGING } from './worker-env';

// How long the proxied icon lives in the CF edge cache. This is the
// worst-case delay between changing the Site Icon in WP and visitors
// seeing the new one — no purge needed.
const EDGE_TTL_SECONDS = 86400;

// Per-isolate memo of the resolved icon URL. The routes are edge-cached
// for a day, so this only smooths request bursts on a cold isolate; a
// short TTL keeps a WP-side icon change from being masked for long.
const RESOLVE_TTL_MS = 5 * 60_000;
let cached: { url: string | null; expires: number } | null = null;
let inflight: Promise<string | null> | null = null;

/**
 * The current Site Icon URL from the WP REST index, or null when no
 * icon is configured (or WP is unreachable — callers fall back either
 * way, so the two cases don't need distinguishing).
 */
export async function getSiteIconUrl(): Promise<string | null> {
	const now = Date.now();
	if (cached && cached.expires > now) return cached.url;
	// See lib/wp/shared-inflight.ts - shared promises can outlive their owner.
	if (inflight) return joinInflight(inflight, fetchIconUrl);

	inflight = fetchIconUrl();

	const url = await inflight;
	cached = { url, expires: Date.now() + RESOLVE_TTL_MS };
	inflight = null;
	return url;
}

function fetchIconUrl(): Promise<string | null> {
	return (async () => {
		try {
			if (!WP_BASE_URL) return null;
			const res = await fetch(`${WP_BASE_URL}/wp-json/`, {
				headers: wpBundleHeaders(),
				cache: 'no-store',
			});
			if (!res.ok) return null;
			const data = (await res.json()) as { site_icon_url?: unknown };
			return typeof data.site_icon_url === 'string' && data.site_icon_url !== ''
				? data.site_icon_url
				: null;
		} catch {
			return null;
		}
	})();
}

/**
 * Shared handler for the favicon routes: fetch the WP Site Icon and
 * serve it with an edge-cacheable TTL, or hand off to the route's own
 * fallback when no icon is set / WP is unreachable.
 *
 * The edge-cache write uses the query-stripped request URL as key —
 * the SAME key the middleware's cache.match uses — so subsequent
 * requests are answered as EDGE-HITs without re-entering the route.
 * The stored s-maxage bounds the entry's lifetime (the middleware's
 * TTL-block pattern; R2 is deliberately not involved because it has
 * no native expiry).
 */
export async function serveSiteIcon(
	request: Request,
	cfContext: ExecutionContext | undefined,
	fallback: () => Response,
): Promise<Response> {
	const iconUrl = await getSiteIconUrl();
	if (!iconUrl) return fallback();

	let upstream: Response;
	try {
		upstream = await fetch(iconUrl, { headers: wpBundleHeaders() });
	} catch {
		return fallback();
	}
	if (!upstream.ok) return fallback();

	const body = await upstream.arrayBuffer();
	const response = new Response(body, {
		headers: {
			'Content-Type': upstream.headers.get('Content-Type') ?? 'image/png',
			'Cache-Control': `public, max-age=3600, s-maxage=${EDGE_TTL_SECONDS}`,
		},
	});

	// Staging worker and the workers.dev preview host never write cache —
	// same invariant the middleware enforces for pages.
	const url = new URL(request.url);
	if (IS_STAGING || url.hostname.endsWith('.workers.dev')) {
		return response;
	}

	try {
		const cacheUrl = new URL(url);
		cacheUrl.search = '';
		const cache = (caches as unknown as { default: Cache }).default;
		const put = cache.put(new Request(cacheUrl.toString(), { method: 'GET' }), response.clone());
		if (cfContext) {
			cfContext.waitUntil(put);
		} else {
			await put;
		}
	} catch {
		// astro dev / non-Workers runtime: no caches.default — serve uncached.
	}

	return response;
}
