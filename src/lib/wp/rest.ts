import { joinInflight } from './shared-inflight';
import { applyCategoryCap, applyPostCap, applyTagCap, withDecodedName } from './env';
import { wpFetch, wpFetchAllPaged, wpFetchRaw } from './transport';
import type {
	PostCustomFields,
	WPCategory,
	WPPage,
	WPPageSlim,
	WPPost,
	WPPostSummary,
	WPTag,
} from './types';

export async function getPostBySlug(slug: string): Promise<WPPost | null> {
	const posts = await wpFetch<WPPost[]>(`posts?slug=${encodeURIComponent(slug)}&_embed=1`);
	return posts[0] ?? null;
}

// Lean fetch — slug + dates only. Use for sitemap or other places where the
// full post body is wasted bandwidth.
export async function getAllPostsSummary(): Promise<WPPostSummary[]> {
	const posts = await wpFetchAllPaged<WPPostSummary>('posts?per_page=100&_fields=slug,date,modified');
	return applyPostCap(posts);
}

// Total published-post count, read directly from the X-WP-Total response
// header. Cheap call (1 row, _fields=id). Still used by the sealed
// homepage archive page (/page/[n]/) to render a "<total> articles total"
// label; the regular archive helpers no longer call this — they pull
// `total` from their own posts response instead.
export async function getTotalPostCount(): Promise<number> {
	const res = await wpFetchRaw<WPPost[]>('posts?per_page=1&_fields=id');
	return res.total;
}

/** Return the direct children of a category, sorted by name. */
export function getDirectChildren(
	parentId: number,
	allCats: WPCategory[],
): WPCategory[] {
	return allCats
		.filter((c) => c.parent === parentId)
		.sort((a, b) => a.name.localeCompare(b.name));
}

// Per-isolate cache for the categories list. Categories rarely change, and
// the paged walk to fetch them is the biggest single contributor to cold-
// render time on the homepage (a large site can have hundreds of categories,
// 2–4 pages even with concurrency=4). Cache for 5 minutes per isolate +
// dedupe concurrent calls so a single render that touches Base.astro and
// any other categories consumer fires the network once.
const CATEGORIES_TTL_MS = 5 * 60 * 1000;
let categoriesCache: { value: WPCategory[]; expires: number } | null = null;
let categoriesInflight: Promise<WPCategory[]> | null = null;

export async function getCategories(): Promise<WPCategory[]> {
	const now = Date.now();
	if (categoriesCache && categoriesCache.expires > now) {
		return categoriesCache.value;
	}
	const fetchFresh = () =>
		wpFetchAllPaged<WPCategory>('categories?per_page=100&hide_empty=false')
			.then((cats) => applyCategoryCap(cats).map(withDecodedName));

	// Never block indefinitely on another request's promise - it may belong to
	// a cancelled request and never settle. See lib/wp/shared-inflight.ts.
	if (categoriesInflight) return joinInflight(categoriesInflight, fetchFresh);

	categoriesInflight = fetchFresh();

	try {
		const value = await categoriesInflight;
		categoriesCache = { value, expires: Date.now() + CATEGORIES_TTL_MS };
		return value;
	} finally {
		categoriesInflight = null;
	}
}

export async function getCategoryBySlug(slug: string): Promise<WPCategory | null> {
	const cats = await wpFetch<WPCategory[]>(`categories?slug=${encodeURIComponent(slug)}`);
	return cats[0] ? withDecodedName(cats[0]) : null;
}

export async function getPages(): Promise<WPPage[]> {
	return wpFetchAllPaged<WPPage>('pages?per_page=100&_embed=1&orderby=menu_order&order=asc');
}

// Slug→page lookup. Drops `_embed=1` deliberately: none of the page-route
// callers ([slug].astro WP-page branch, [...rest].astro) use the
// _embedded.author / _embedded.wp:featuredmedia / _embedded.wp:term
// fan-out, and including _embed=1 (a) ~2× the WP-side render time on
// every page, (b) triggers a multi-minute hang on pages whose embed
// chain includes wpDataTables shortcodes (see
// WPDATATABLES-SLOW-RENDER.md). Removing it is a pure win.
// Slim `_fields` filter that asks WP REST only for the keys the page
// routes actually consume. Heavy pages can ship a large ACF blob +
// class_list + meta in the default response that pushes the payload past
// WP's render budget — the request times out and the page fails to
// render. Filtering to just the fields we need cuts response size
// substantially and keeps the fetch well under the timeout.
const PAGE_FIELDS = 'id,slug,date,modified,link,parent,menu_order,title,content,excerpt';

export async function getPageBySlug(slug: string): Promise<WPPage | null> {
	const pages = await wpFetch<WPPage[]>(
		`pages?slug=${encodeURIComponent(slug)}&_fields=${PAGE_FIELDS}`,
	);
	return pages[0] ?? null;
}

// Fetch the custom REST fields the /staticq/v1/single bundle endpoint
// doesn't expose (it strips register_rest_field additions). One small
// REST call per post when bundle is the data source; no-op when the
// caller already has them from the standard REST path.
//
// Currently returns `primary_category` (for breadcrumb chain
// construction) and `subtitle` (for card + hero subtitle line).
// Both addressed in Endpoints::register().
export async function getPostCustomFields(id: number): Promise<PostCustomFields> {
	const empty: PostCustomFields = { primary_category: null, subtitle: '' };
	if (!Number.isFinite(id) || id <= 0) return empty;
	try {
		// Request both the neutral fields and their deprecated aliases so
		// this works against WP installs that only emit the old names.
		const data = await wpFetch<{
			primary_category?: number | null;
			rank_math_primary_category?: number | null;
			subtitle?: string;
			zeen_subtitle?: string;
		}>(`posts/${id}?_fields=primary_category,rank_math_primary_category,subtitle,zeen_subtitle`);
		const primary = data?.primary_category ?? data?.rank_math_primary_category;
		const subtitle = data?.subtitle ?? data?.zeen_subtitle;
		return {
			primary_category:
				typeof primary === 'number' && primary > 0 ? primary : null,
			subtitle: typeof subtitle === 'string' ? subtitle : '',
		};
	} catch {
		return empty;
	}
}

const PAGES_SLIM_TTL_MS = 5 * 60 * 1000;
let pagesSlimCache: { value: WPPageSlim[]; expires: number } | null = null;
let pagesSlimInflight: Promise<WPPageSlim[]> | null = null;

export async function getPagesSlim(): Promise<WPPageSlim[]> {
	const now = Date.now();
	if (pagesSlimCache && pagesSlimCache.expires > now) {
		return pagesSlimCache.value;
	}
	const fetchFreshPages = () => wpFetchAllPaged<WPPageSlim>(
		'pages?per_page=100&_fields=id,slug,parent,link,title&orderby=menu_order&order=asc',
	);

	// See lib/wp/shared-inflight.ts - a shared promise can outlive the
	// request that owns it and never settle.
	if (pagesSlimInflight) return joinInflight(pagesSlimInflight, fetchFreshPages);

	pagesSlimInflight = fetchFreshPages();

	try {
		const value = await pagesSlimInflight;
		pagesSlimCache = { value, expires: Date.now() + PAGES_SLIM_TTL_MS };
		return value;
	} finally {
		pagesSlimInflight = null;
	}
}

export async function getTags(): Promise<WPTag[]> {
	const tags = await wpFetchAllPaged<WPTag>('tags?per_page=100&hide_empty=false');
	return applyTagCap(tags).map(withDecodedName);
}

export async function getTagBySlug(slug: string): Promise<WPTag | null> {
	const tags = await wpFetch<WPTag[]>(`tags?slug=${encodeURIComponent(slug)}`);
	return tags[0] ? withDecodedName(tags[0]) : null;
}
