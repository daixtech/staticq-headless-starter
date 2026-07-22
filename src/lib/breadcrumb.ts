// Breadcrumb chain construction. Two flavours:
//   - buildCategoryChain(cat, allCats) — for /category/... archive pages.
//     The chain ENDS at the category itself (it's the current page).
//   - buildPostChain(post, allCats) — for /<slug>/ post pages. Resolves
//     the post's primary category (SEO-plugin primary if set, else the
//     first embedded category), then walks its parent chain. The chain
//     ENDS at the primary category (the post title is NOT a breadcrumb
//     item).
//
// The resulting chain feeds BOTH the visible <Breadcrumb> component and
// the BreadcrumbList JSON-LD (emitted by SEOJsonLd on the hand-rolled
// fallback; when an SEO plugin is active its head carries the schema).

import type { WPCategory, WPPost } from './wp';

export interface BreadcrumbItem {
	name: string;
	/** Root-relative path, always with a leading slash and trailing slash. */
	href: string;
}

/**
 * Walk a category up its parent chain (using the cached allCats list)
 * and produce a Home → root → … → leaf breadcrumb. Used directly on
 * category archive pages; used indirectly by buildPostChain.
 *
 * Guards against missing-parent loops by stopping when a parent ID
 * isn't in allCats (cached list cold / pagination gap) — in that case
 * the chain is rendered from whatever ancestors we did resolve. Better
 * a slightly short breadcrumb than a wrong one.
 */
export function buildCategoryChain(
	category: WPCategory,
	allCats: WPCategory[],
): BreadcrumbItem[] {
	const byId = new Map<number, WPCategory>(allCats.map((c) => [c.id, c]));
	const chain: WPCategory[] = [];
	let cur: WPCategory | undefined = category;
	const guard = new Set<number>();
	while (cur && !guard.has(cur.id)) {
		guard.add(cur.id);
		chain.unshift(cur);
		if (!cur.parent || cur.parent === 0) break;
		cur = byId.get(cur.parent);
	}
	const items: BreadcrumbItem[] = [{ name: 'Home', href: '/' }];
	for (let i = 0; i < chain.length; i++) {
		const slugPath = chain.slice(0, i + 1).map((c) => c.slug).join('/');
		items.push({ name: chain[i].name, href: `/category/${slugPath}/` });
	}
	return items;
}

/**
 * Build the breadcrumb chain for a post. Prefers the SEO plugin's primary
 * category (`primary_category` REST field, from Rank Math or Yoast) when
 * set; otherwise falls back to the first embedded category term.
 *
 * Returns at minimum `[{ Home, / }]` when no category can be resolved.
 */
export function buildPostChain(
	post: WPPost,
	allCats: WPCategory[],
): BreadcrumbItem[] {
	const primaryId = post.primary_category ?? post.rank_math_primary_category;
	let category: WPCategory | undefined;

	if (typeof primaryId === 'number' && primaryId > 0) {
		category = allCats.find((c) => c.id === primaryId);
	}

	// Fallback: first embedded category from `_embedded['wp:term']`.
	if (!category) {
		const groups = post._embedded?.['wp:term'];
		if (groups) {
			outer: for (const group of groups) {
				for (const term of group) {
					if (term.taxonomy === 'category') {
						category = allCats.find((c) => c.id === term.id);
						if (!category && term.slug && term.name) {
							// Term isn't in allCats (cache miss). Return a
							// single-level chain straight from the embedded
							// data — degrades gracefully without a parent
							// chain.
							return [
								{ name: 'Home', href: '/' },
								{ name: term.name, href: `/category/${term.slug}/` },
							];
						}
						if (category) break outer;
					}
				}
			}
		}
	}

	if (!category) return [{ name: 'Home', href: '/' }];
	return buildCategoryChain(category, allCats);
}
