import { wpFetch } from './transport';
import type { HeroSlot, HeroTagSlot, WPCategory, WPPost } from './types';

// ===========================================================================
//  Leaf category hero strip — config + helpers
// ===========================================================================
//
// On leaf categories under specific root categories (opted in via
// HERO_ROOT_SLUGS below), an optional hero strip renders above the main
// post grid. Each slot maps a display label to a "purpose" tag; we query
// `category:THIS ∩ tag:PURPOSE`, pick the most recent matching post, and
// render it as a hero card. Empty slots are hidden silently.
//
// The hero strip only appears on page 1. Hero posts are excluded from
// the main grid (and from every paginated page after).

// EDIT for your site: define the hero-strip slots. Each maps a display
// label to a WordPress tag ID. Empty by default — the hero strip stays
// hidden until you add slots here AND opt a category root into
// HERO_ROOT_SLUGS below. (A slot models a "subject with
// overview/specs/… child posts" content shape; skip it if your site
// isn't organized that way.)
export const HERO_TAG_SLOTS: HeroTagSlot[] = [
	// { tagId: 123, label: 'Overview', key: 'overview' },
];

// EDIT for your site: add the root category slugs whose leaf categories
// should show the hero strip (a leaf here = a specific subject with
// overview/guide/specs/pictures child pages). Empty by default so a fresh
// install shows no hero strip until you opt specific category trees in.
export const HERO_ROOT_SLUGS = new Set<string>([
	// 'reviews',
]);

/**
 * Walk a category up its parent chain to find the root (parent === 0).
 * Uses the cached all-categories list to avoid extra REST calls.
 */
function rootOf(
	category: WPCategory,
	allCats: WPCategory[],
): WPCategory | null {
	if (!category) return null;
	if (!category.parent || category.parent === 0) return category;
	const byId = new Map<number, WPCategory>(allCats.map((c) => [c.id, c]));
	let cur: WPCategory | undefined = category;
	const guard = new Set<number>();
	while (cur && !guard.has(cur.id)) {
		guard.add(cur.id);
		if (!cur.parent || cur.parent === 0) return cur;
		cur = byId.get(cur.parent);
	}
	return null;
}

/** True when `category` has no other category referencing it as parent. */
function isLeafCategory(category: WPCategory, allCats: WPCategory[]): boolean {
	return !allCats.some((c) => c.parent === category.id);
}

/**
 * Return up to N hero posts for a leaf category, one per slot. Slots
 * with no matching post are dropped silently. Runs the per-slot queries
 * in parallel — typically 4 small REST calls (~150ms total). When the
 * category isn't under a hero-eligible root, returns [].
 */
export async function getCategoryHeroPosts(
	category: WPCategory,
	allCats: WPCategory[],
): Promise<HeroSlot[]> {
	const root = rootOf(category, allCats);
	if (!root || !HERO_ROOT_SLUGS.has(root.slug)) return [];
	if (!isLeafCategory(category, allCats)) return [];

	const fetches = HERO_TAG_SLOTS.map(async (slot) => {
		// Most-recent post that has BOTH this category AND the slot's
		// canonical purpose tag. `_embed=1` carries featured-media +
		// author so the hero card renders inline without extra calls.
		const path = `posts?categories=${category.id}&tags=${slot.tagId}`
			+ `&per_page=1&orderby=date&order=desc&_embed=1`;
		try {
			const posts = await wpFetch<WPPost[]>(path);
			if (!posts.length) return null;
			return { key: slot.key, label: slot.label, post: posts[0] };
		} catch {
			return null;
		}
	});
	const results = await Promise.all(fetches);
	return results.filter((r): r is HeroSlot => r !== null);
}
