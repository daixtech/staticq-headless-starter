import { WP_BASE_URL } from './env';
import { wpBundleHeaders } from './transport';

// ---------------------------------------------------------------------------
// SEO <head> fragment (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// Per-isolate cache of the SEO head HTML keyed by the WP URL we asked
// about. Cached for 60s — matches site-config. A separate map per URL
// because the output is page-specific (per-post meta, per-category
// description, per-tag canonical, etc.).
const SEO_HEAD_TTL_MS = 60_000;
const seoHeadCache = new Map<string, { value: string | null; expires: number }>();
const seoHeadInflight = new Map<string, Promise<string | null>>();

// Substitute the homepage's SEO head when the per-URL response is thin
// enough to break SEO. Rank Math's getHead returns only title + robots +
// a default og:image for slot-stable pagination URLs (`/page/N/`) — no
// canonical, no description, no og:title/url, and a JSON-LD WebPage node
// with empty `url` and `@id="#webpage"`. The WP live frontend papers over
// this by serving the homepage's full head for `/page/N/` (with
// canonical=/), and we mirror that here.
//
// Detection heuristic: a head fragment without a `<link rel="canonical">`
// is considered thin. Any normal SEO-plugin response includes one. Keeps
// the policy "trust the SEO plugin for anything it has an opinion on"
// intact — we only substitute when it left the canonical empty, which is
// its own signal that it has no opinion.
export async function getHomeFallbackHeadIfThin(
	seoHead: string | null | undefined,
): Promise<string | null> {
	if (typeof seoHead === 'string' && /<link\s+rel=["']canonical["']/i.test(seoHead)) {
		return seoHead;
	}
	if (!WP_BASE_URL) return seoHead ?? null;
	const fallback = await getSeoHead(`${WP_BASE_URL}/`);
	return fallback ?? seoHead ?? null;
}

// Fetches the active SEO plugin's pre-rendered `<head>` HTML for a URL on
// the WP origin. Returns the raw fragment string (title, meta description,
// robots, canonical, OG/Twitter, article:*, and the schema JSON-LD) or
// `null` when nothing is available. Never throws.
//
// Primary source is the plugin's own plugin-agnostic endpoint
// `/wp-json/staticq/v1/seo-head?url=…`, which resolves via Rank Math or
// Yoast server-side. For older plugin builds that predate that route we
// fall back once to Rank Math's `/wp-json/rankmath/v1/getHead`.
export async function getSeoHead(url: string): Promise<string | null> {
	const now = Date.now();
	const cached = seoHeadCache.get(url);
	if (cached && cached.expires > now) {
		return cached.value;
	}
	const existing = seoHeadInflight.get(url);
	if (existing) return existing;

	const promise = (async (): Promise<string | null> => {
		if (!WP_BASE_URL) return null;
		const headers = wpBundleHeaders();

		// Neutral plugin endpoint (Rank Math + Yoast). null result means
		// "resolved, but no head"; a thrown/404 means "route missing".
		try {
			const endpoint = `${WP_BASE_URL}/wp-json/staticq/v1/seo-head?url=${encodeURIComponent(url)}`;
			const res = await fetch(endpoint, { headers, cache: 'no-store' });
			if (res.ok) {
				const data = (await res.json()) as { seo_head?: string | null };
				return typeof data?.seo_head === 'string' && data.seo_head.length > 0
					? data.seo_head
					: null;
			}
			// Non-404 error from a present route → don't second-guess it.
			if (res.status !== 404) return null;
		} catch {
			// fall through to the legacy Rank Math endpoint
		}

		// Legacy fallback: Rank Math's own getHead route.
		try {
			const endpoint = `${WP_BASE_URL}/wp-json/rankmath/v1/getHead?url=${encodeURIComponent(url)}`;
			const res = await fetch(endpoint, { headers, cache: 'no-store' });
			if (!res.ok) return null;
			const data = (await res.json()) as { success?: boolean; head?: string };
			if (!data?.success || typeof data?.head !== 'string' || data.head.length === 0) {
				return null;
			}
			return data.head;
		} catch {
			return null;
		}
	})();

	seoHeadInflight.set(url, promise);
	try {
		const value = await promise;
		seoHeadCache.set(url, { value, expires: Date.now() + SEO_HEAD_TTL_MS });
		return value;
	} finally {
		seoHeadInflight.delete(url);
	}
}

// Deprecated alias — use getSeoHead. Kept so any external importer that
// still references the old name keeps compiling for one release.
export const getRankMathHead = getSeoHead;
