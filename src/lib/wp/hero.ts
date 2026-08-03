import { wpFetch } from './transport';
import type { HeroSlot, HeroTagSlot, WPCategory, WPPost } from './types';

// ===========================================================================
//  Leaf category hero strip — config + helpers
// ===========================================================================
//
// On leaf categories under specific root categories (opted in via
// HERO_ROOT_SLUGS below), an optional hero strip renders above the main
// post grid. Each slot maps a display label to a "purpose" tag; the
// most recent post in `category:THIS ∩ tag:PURPOSE` fills the slot.
// Empty slots are hidden silently.
//
// The hero strip only appears on page 1. Hero posts are excluded from
// the main grid (and from every paginated page after).
//
// HOW THE SLOTS ARE FILLED - read before changing this:
// Ask the archive bundle (`hero_tags` -> `hero_posts`). Do NOT fetch a
// slot at a time from wp/v2 with `categories=X&tags=Y`. That query shape
// lets MySQL start from the TAG side, so every leaf category pays for
// scanning the whole tag: measured on a 10k-post site, a 575-post tag
// cost 29 SECONDS COLD per slot (1.3s warm) and turned 1s category
// pages into 20-44s ones. Warmups render cold URLs by definition, so
// cold is the number that matters. The endpoint instead starts from the
// category - bounded by ITS size, not the tag's popularity.

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
 * True when the category can show a hero strip: a leaf whose root is
 * opted into HERO_ROOT_SLUGS. Exported so a route can check eligibility
 * without triggering the fallback fetch above.
 */
export function isHeroEligible(
	category: WPCategory,
	allCats: WPCategory[],
): boolean {
	const root = rootOf(category, allCats);
	if (!root || !HERO_ROOT_SLUGS.has(root.slug)) return false;
	return isLeafCategory(category, allCats);
}

/**
 * Walk a category up its parent chain to find the root (parent === 0).
 * Uses the supplied category list (term_context is enough) to avoid
 * extra REST calls.
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
 * COMPATIBILITY FALLBACK - prefer the bundle's `hero_posts`.
 *
 * Fills the slots with one wp/v2 request each. Only for installs whose
 * WP plugin predates `hero_tags`; see the cost warning at the top of
 * this file before reaching for it deliberately. Returns [] when the
 * category isn't under a hero-eligible root.
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
