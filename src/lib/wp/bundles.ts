import { joinInflight } from './shared-inflight';
import { WP_BASE_URL, withDecodedName } from './env';
import { wpBundleHeaders } from './transport';
import type {
	ArchiveBundle,
	ArchiveBundleArgs,
	ArchiveLayout,
	AuthorBundle,
	HomepageBundle,
	SingleBundle,
	SiteConfig,
	SitemapBundle,
	WPAuthor,
	WPPost,
} from './types';

// ---------------------------------------------------------------------------
// Author archive bundle (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// One-shot fetch of an author's archive page + author info + SEO
// head in a single call. Returns null when the slug doesn't resolve,
// when the endpoint isn't available, or on any network failure.
export async function getAuthorBundle(
	slug: string,
	page: number | null,
): Promise<AuthorBundle | null> {
	try {
		if (!WP_BASE_URL || !slug) return null;
		const params = new URLSearchParams();
		params.set('author_slug', slug);
		if (page !== null) params.set('page', String(page));
		const url = `${WP_BASE_URL}/wp-json/staticq/v1/archive?${params.toString()}`;
		const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as {
			posts: WPPost[];
			layout: ArchiveLayout;
			author?: WPAuthor | null;
			seo_head?: string | null;
			rank_math_head?: string | null;
		};
		if (
			!data
			|| typeof data !== 'object'
			|| !Array.isArray(data.posts)
			|| !data.layout
			|| !data.author
			|| typeof data.author.id !== 'number'
		) {
			return null;
		}
		return {
			author: withDecodedName(data.author),
			posts: data.posts,
			layout: data.layout,
			seoHead: data.seo_head ?? data.rank_math_head ?? null,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Site-wide config (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// Per-isolate cache + in-flight dedup. The 60s TTL is a balance between
// reflecting editor changes quickly and not hammering the WP origin on
// every SSR miss. If editors need instant propagation, the WP plugin
// can extend its purge pipeline to invalidate all URLs on config change.
const SITE_CONFIG_TTL_MS = 60_000;
let siteConfigCache: { value: SiteConfig | null; expires: number } | null = null;
let siteConfigInflight: Promise<SiteConfig | null> | null = null;

// Returns the parsed site-config object or `null` when the endpoint
// doesn't exist (404), returns a non-200, returns invalid JSON, or the
// origin is unreachable. Callers should treat `null` as "endpoint not
// available — use env/hardcoded fallbacks." Never throws.
export async function getSiteConfig(): Promise<SiteConfig | null> {
	const now = Date.now();
	if (siteConfigCache && siteConfigCache.expires > now) {
		return siteConfigCache.value;
	}
	// See lib/wp/shared-inflight.ts: joining a promise owned by another
	// request can hang this one forever if that request was cancelled.
	if (siteConfigInflight) return joinInflight(siteConfigInflight, fetchSiteConfig);

	siteConfigInflight = fetchSiteConfig();

	const value = await siteConfigInflight;
	siteConfigCache = { value, expires: Date.now() + SITE_CONFIG_TTL_MS };
	siteConfigInflight = null;
	return value;
}

function fetchSiteConfig(): Promise<SiteConfig | null> {
	return (async () => {
		try {
			if (!WP_BASE_URL) return null;
			const url = `${WP_BASE_URL}/wp-json/staticq/v1/site-config`;
			const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
			if (!res.ok) return null;
			const data = (await res.json()) as SiteConfig;
			// Minimal shape check — if the brand subobject is missing,
			// treat the response as unusable rather than silently masking
			// the fallback.
			if (!data || typeof data !== 'object' || !data.brand?.name) {
				return null;
			}
			return data;
		} catch {
			return null;
		} finally {
			// Promise resolution path also runs the cache write below via the
			// .then() in the outer function; here we just clear the inflight
			// slot so the next request after expiry can fetch again.
		}
	})();
}

// ---------------------------------------------------------------------------
// Homepage bundle (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// NO in-memory cache here. Module-level state persists across requests within
// a Worker isolate, so a per-isolate TTL cache serves a STALE homepage — and
// silently short-circuits before the fetch, defeating its cache:'no-store'.
// Freshness and perf come from the page-level edge+R2 cache, which the
// receiver Worker invalidates per URL on every edit.

// One-shot fetch of the homepage payload (live posts + layout) from the WP
// custom endpoint. Returns `null` when the endpoint is missing (404),
// returns a non-200, returns invalid JSON, or the origin is unreachable.
// Callers should fall back to `getHomeArchive` on null. Never throws.
//
// Why this exists: default WP REST + _embed=1 fans out into ~100 internal
// REST calls and ~500 DB queries per archive render. Bundling the homepage's
// data into one custom endpoint cuts those numbers by ~50×. See the WP-side
// implementation at staticq-headless/src/Rest/Endpoints.php for the batched
// query plan.
export async function getHomepageBundle(): Promise<HomepageBundle | null> {
	try {
		if (!WP_BASE_URL) return null;
		// Cache-buster. Some WP hosts run an origin cache (Varnish / Nginx
		// FastCGI) that caches bare REST URLs for anonymous requests. Every
		// other bundle endpoint carries a query string (category_id, slug,
		// page) and dodges it by accident; /homepage takes no params, so it's
		// the one request that gets served stale to the (anonymous) Worker. A
		// unique param per render keeps it fresh. The durable fix is to exclude
		// /wp-json from that origin cache, after which this is belt-and-braces.
		const url = `${WP_BASE_URL}/wp-json/staticq/v1/homepage?_cb=${Date.now()}`;
		const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as HomepageBundle;
		// Minimal shape check — treat malformed responses as missing so the
		// caller's fallback path runs (rather than rendering an empty homepage
		// on a partial response).
		if (
			!data
			|| typeof data !== 'object'
			|| !data.home_archive
			|| !Array.isArray(data.home_archive.posts)
			|| !data.home_archive.layout
		) {
			return null;
		}
		return data;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Single post/page bundle (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// One-shot fetch of a post (or page) + its SEO head fragment from
// the /staticq/v1/single endpoint. Returns null when the slug doesn't
// match (HTTP 404), when the endpoint is missing on the WP install,
// when the response is malformed, or on any network failure — callers
// fall back to the per-call getPostBySlug + getPageBySlug + Rank Math
// path in that case. Never throws.
//
// Why this exists: default WP REST `?slug=X&_embed=1` follows the
// post's `wp:attachment` link, which fans out into a full media REST
// controller pass for every attached image. For gallery posts with
// 50-150 attachments that's 30-50s of filter/serialization work the
// frontend never used. This endpoint skips the fan-out entirely —
// featured media / author / terms are hydrated via batched SQL, the
// content body keeps its inline <img> tags (already with srcsets),
// and Rank Math's head fragment is bundled so the post route makes
// ONE HTTP call instead of two.
export async function getSingleBundle(slug: string): Promise<SingleBundle | null> {
	try {
		if (!WP_BASE_URL || !slug) return null;
		const url = `${WP_BASE_URL}/wp-json/staticq/v1/single?slug=${encodeURIComponent(slug)}`;
		const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as SingleBundle;
		if (
			!data
			|| typeof data !== 'object'
			|| (data.type !== 'post' && data.type !== 'page')
			|| !data.post
			|| typeof data.post.id !== 'number'
		) {
			return null;
		}
		// rank_math_head may legitimately be null (endpoint disabled on WP
		// side) — preserve the null rather than treating as a failure.
		return data;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Sitemap bundle (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// One-shot data bundle for the site-wide sitemap. Returns null on any
// failure (endpoint missing, non-200, malformed JSON, unreachable origin)
// so callers can fall back to the slower per-collection helpers. Never
// throws.
export async function getSitemapBundle(): Promise<SitemapBundle | null> {
	try {
		if (!WP_BASE_URL) return null;
		const url = `${WP_BASE_URL}/wp-json/staticq/v1/sitemap`;
		const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as SitemapBundle;
		if (
			!data
			|| typeof data !== 'object'
			|| !Array.isArray(data.posts)
			|| !Array.isArray(data.pages)
			|| !Array.isArray(data.categories)
			|| !Array.isArray(data.tags)
		) {
			return null;
		}
		return data;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Archive bundle (custom WP endpoint, optional).
// ---------------------------------------------------------------------------

// One-shot fetch of a slot-stable archive page (home / category / tag,
// live or sealed) from the WP `/staticq/v1/archive` endpoint. Returns
// `null` when the endpoint is missing (404), returns a non-200, returns
// invalid JSON, or the origin is unreachable — callers fall back to the
// default WP REST path in that case. Never throws.
//
// Why this exists: same motivation as `getHomepageBundle` — default WP
// REST + _embed=1 fans out into ~100 internal REST calls per archive
// render, ~500 DB queries. This endpoint replaces all of that with one
// HTTP + ~7 batched DB queries. Wired into `getHomeArchive`,
// `getCategoryArchive`, and `getTagArchive` so every sealed-page URL
// benefits transparently.
export async function getArchiveBundle(
	args: ArchiveBundleArgs,
): Promise<ArchiveBundle | null> {
	try {
		if (!WP_BASE_URL) return null;
		const params = new URLSearchParams();
		if (args.page !== null) params.set('page', String(args.page));
		if (args.categoryId) params.set('category_id', String(args.categoryId));
		if (args.tagId) params.set('tag_id', String(args.tagId));
		if (args.includeDescendants) params.set('include_descendants', '1');
		// Display-time exclusions (e.g. hero posts rendered above the grid).
		// The endpoint filters AFTER slot selection and returns the
		// unfiltered layout, so pagination stays in step with the WP
		// invalidation engine - never recompute layout from a filtered list.
		if (args.excludeIds && args.excludeIds.length > 0) {
			params.set('exclude', args.excludeIds.join(','));
		}
		// Hero slots, resolved server-side in ONE category-first query.
		// Do NOT fetch these per slot from wp/v2 (`categories=X&tags=Y`):
		// that shape lets MySQL start from the tag side, so a popular tag
		// makes every leaf category pay for scanning it. Measured on a
		// 10k-post site with a 575-post tag: 29s COLD per slot, 1.3s warm.
		// See docs note in lib/wp/hero.ts.
		if (args.heroTagIds && args.heroTagIds.length > 0) {
			params.set('hero_tags', args.heroTagIds.join(','));
		}
		const qs = params.toString();
		const url = `${WP_BASE_URL}/wp-json/staticq/v1/archive${qs ? `?${qs}` : ''}`;
		const res = await fetch(url, { headers: wpBundleHeaders(), cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as {
			posts: WPPost[];
			layout: ArchiveLayout;
			seo_head?: string | null;
			rank_math_head?: string | null;
			term_context?: {
				self: WPCategory;
				ancestors: WPCategory[];
				children: WPCategory[];
			} | null;
			hero_posts?: Record<string, WPPost> | null;
		};
		// Minimal shape check — treat malformed responses as missing so the
		// caller's fallback runs (rather than rendering an empty archive).
		if (
			!data
			|| typeof data !== 'object'
			|| !Array.isArray(data.posts)
			|| !data.layout
			|| typeof data.layout.totalPosts !== 'number'
		) {
			return null;
		}
		// term_context saves fetching the FULL category list just to walk
		// a breadcrumb chain or decide leaf-ness. Flattened to the shape
		// callers already expect from getCategories().
		const tc = data.term_context;
		const termContext = tc?.self
			? [tc.self, ...(tc.ancestors ?? []), ...(tc.children ?? [])]
			: null;
		const heroPosts = data.hero_posts
			? Object.fromEntries(
				Object.entries(data.hero_posts).map(([k, v]) => [Number(k), v]),
			) as Record<number, WPPost>
			: null;

		return {
			posts: data.posts,
			layout: data.layout,
			seoHead: data.seo_head ?? data.rank_math_head ?? null,
			termContext,
			heroPosts,
		};
	} catch {
		return null;
	}
}
