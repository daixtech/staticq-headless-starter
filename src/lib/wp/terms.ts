import { wpFetch } from './transport';
import type { WPCategory } from './types';

// ===========================================================================
//  Targeted category lookups
// ===========================================================================
//
// `getCategories()` fetches EVERY category on the site, 100 per request.
// That is fine for a small site and quietly ruinous for a large one: 614
// categories is 7 paginated calls, ~13s cold, paid on every page render
// that only needed a breadcrumb chain or a handful of nav links.
//
// Prefer, in order:
//   1. `term_context` on the archive/single bundle (zero extra calls)
//   2. the helpers below (bounded, targeted calls)
//   3. `getCategories()` (only when you genuinely need all of them)

/** Per-term memo. Cleared when the isolate recycles; safe for term data. */
const termCache = new Map<number, { at: number; cat: WPCategory }>();
const TERM_TTL_MS = 5 * 60 * 1000;

async function fetchTerm(id: number): Promise<WPCategory | null> {
	const hit = termCache.get(id);
	if (hit && Date.now() - hit.at < TERM_TTL_MS) return hit.cat;
	try {
		const cat = await wpFetch<WPCategory>(`categories/${id}`);
		if (!cat?.id) return null;
		termCache.set(id, { at: Date.now(), cat });
		return cat;
	} catch {
		return null;
	}
}

/**
 * A category plus its ancestors and direct children — the same shape the
 * archive bundle's `term_context` returns, for installs whose WP plugin
 * predates it. Walks parents one at a time (chains are short) and fetches
 * children in a single query, instead of pulling the whole taxonomy.
 */
export async function getCategoryContext(
	category: WPCategory,
): Promise<WPCategory[]> {
	const ancestors: WPCategory[] = [];
	let parentId = category.parent ?? 0;
	const guard = new Set<number>([category.id]);
	while (parentId && !guard.has(parentId)) {
		guard.add(parentId);
		const parent = await fetchTerm(parentId);
		if (!parent) break;
		ancestors.push(parent);
		parentId = parent.parent ?? 0;
	}

	let children: WPCategory[] = [];
	try {
		children = await wpFetch<WPCategory[]>(
			`categories?parent=${category.id}&per_page=100&hide_empty=false`,
		);
	} catch {
		children = [];
	}

	return [category, ...ancestors, ...(children ?? [])];
}

/**
 * The N most-used categories, for header/footer navigation. Asks WP to do
 * the sorting and slicing so a site with hundreds of categories transfers
 * only the ones it renders.
 */
export async function getTopCategories(limit = 8): Promise<WPCategory[]> {
	try {
		return await wpFetch<WPCategory[]>(
			`categories?per_page=${limit}&orderby=count&order=desc&hide_empty=true`,
		);
	} catch {
		return [];
	}
}
