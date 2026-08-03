import { wpFetchRaw } from './transport';
import { computeArchiveLayout, LIVE_MAX, SEAL_SIZE } from './pagination';
import { getArchiveBundle } from './bundles';
import type { ArchiveBundle, WPPost } from './types';

// Fetches a single page's worth of category posts under the slot-stable model.
// Pass `page = null` for the live page (newest, variable size). Pass `page = N`
// for sealed page N (1-indexed, oldest first).
//
// Returns posts already sorted newest-first for display, plus the layout so
// callers can render the right pagination links.
//
// Implementation note: derives `totalPosts` from the X-WP-Total header on
// the posts response itself rather than running a separate count query.
// For the live page we always request LIVE_MAX (the maximum live size) and
// slice to the actual livePageSize after layout math — one round-trip
// instead of two.
export async function getCategoryArchive(
	categoryId: number,
	page: number | null,
	excludeIds: number[] = [],
	heroTagIds: number[] = [],
): Promise<ArchiveBundle> {
	// Always request descendant-inclusive counts for category archives.
	// Matches the plugin URL engine's count_published_in_term semantics so
	// the engine's emitted /page/N/ URLs line up with what we can render.
	// Hierarchical taxonomies are the only ones with descendants — for
	// leaf categories the flag is a no-op (get_term_children returns []).
	// Bundle endpoint version added in plugin commit alongside this one.
	//
	// Hero-post exclusions ride along on the bundle (`exclude`), so the
	// batched path is used even on hero-enabled categories. The endpoint
	// filters AFTER slot selection and returns the unfiltered layout, so
	// pagination stays in step with the WP invalidation engine.
	//
	// The wp/v2 fallback below runs only when the bundle endpoint is
	// absent (older plugin) — its `_embed=1` fan-out costs ~100 internal
	// REST calls per render, so it is a compatibility path, not a
	// routine one. NOTE: it recomputes layout from the FILTERED total,
	// which can drift from the engine's page math; acceptable only
	// because it is a fallback.
	// Hero slots (when the route asks for them) are resolved inside this
	// same call - see lib/wp/hero.ts for why they must not be fetched per
	// slot from wp/v2.
	const bundle = await getArchiveBundle({
		page,
		categoryId,
		includeDescendants: true,
		excludeIds,
		heroTagIds,
	});
	if (bundle) return bundle;


	const excludeParam = excludeIds.length > 0
		? `&exclude=${excludeIds.join(',')}`
		: '';

	if (page === null) {
		const path = `posts?categories=${categoryId}${excludeParam}&per_page=${LIVE_MAX}&page=1&order=desc&orderby=date&_embed=1`;
		const res = await wpFetchRaw<WPPost[]>(path);
		const layout = computeArchiveLayout(res.total);
		const posts = res.data.slice(0, layout.livePageSize);
		return { posts, layout };
	}

	const path = `posts?categories=${categoryId}${excludeParam}&per_page=${SEAL_SIZE}&page=${page}&order=asc&orderby=date&_embed=1`;
	const res = await wpFetchRaw<WPPost[]>(path);
	const layout = computeArchiveLayout(res.total);
	if (page < 1 || page > layout.sealedPagesCount) {
		return { posts: [], layout };
	}
	// Selection is chronological ASC (so URL slot is stable forever); display
	// is newest-first DESC (matches the live page's UX).
	return { posts: res.data.slice().reverse(), layout };
}

// Free-text search across posts. Backs the /search/?s=... page.
// Returns up to `perPage` matches in standard WPPost shape (with
// _embedded media/author so we can render OverlayCards). No
// pagination on the headless side — search is typically a "find
// what I want" UX, not a browse, and the long tail of low-relevance
// hits adds little. Caller passes the user's raw query; this
// function does the URL encoding.
export async function searchPosts(
	query: string,
	perPage = 20,
): Promise<{ posts: WPPost[]; total: number }> {
	const trimmed = query.trim();
	if (!trimmed) return { posts: [], total: 0 };
	const path = `posts?search=${encodeURIComponent(trimmed)}&per_page=${perPage}&_embed=1`;
	try {
		const { data, total } = await wpFetchRaw<WPPost[]>(path);
		return { posts: data, total };
	} catch {
		return { posts: [], total: 0 };
	}
}

// Slot-stable archive fetch for a tag. Mirrors `getCategoryArchive`.
export async function getTagArchive(
	tagId: number,
	page: number | null,
): Promise<ArchiveBundle> {
	const bundle = await getArchiveBundle({ page, tagId });
	if (bundle) return bundle;

	if (page === null) {
		const path = `posts?tags=${tagId}&per_page=${LIVE_MAX}&page=1&order=desc&orderby=date&_embed=1`;
		const res = await wpFetchRaw<WPPost[]>(path);
		const layout = computeArchiveLayout(res.total);
		const posts = res.data.slice(0, layout.livePageSize);
		return { posts, layout };
	}

	const path = `posts?tags=${tagId}&per_page=${SEAL_SIZE}&page=${page}&order=asc&orderby=date&_embed=1`;
	const res = await wpFetchRaw<WPPost[]>(path);
	const layout = computeArchiveLayout(res.total);
	if (page < 1 || page > layout.sealedPagesCount) {
		return { posts: [], layout };
	}
	return { posts: res.data.slice().reverse(), layout };
}

// Slot-stable archive fetch for the homepage (all posts, no taxonomy filter).
export async function getHomeArchive(
	page: number | null,
): Promise<ArchiveBundle> {
	const bundle = await getArchiveBundle({ page });
	if (bundle) return bundle;

	if (page === null) {
		const path = `posts?per_page=${LIVE_MAX}&page=1&order=desc&orderby=date&_embed=1`;
		const res = await wpFetchRaw<WPPost[]>(path);
		const layout = computeArchiveLayout(res.total);
		const posts = res.data.slice(0, layout.livePageSize);
		return { posts, layout };
	}

	const path = `posts?per_page=${SEAL_SIZE}&page=${page}&order=asc&orderby=date&_embed=1`;
	const res = await wpFetchRaw<WPPost[]>(path);
	const layout = computeArchiveLayout(res.total);
	if (page < 1 || page > layout.sealedPagesCount) {
		return { posts: [], layout };
	}
	return { posts: res.data.slice().reverse(), layout };
}
