// Barrel for the WordPress data layer. The implementation lives in the
// single-concern modules under ./wp/*; this file preserves the historic
// `import { … } from '../lib/wp'` surface so route/component consumers don't
// need to change their imports. Add new public symbols to the relevant
// module and re-export them here.
//
//   wp/types.ts       — every shared REST + bundle data shape (types only)
//   wp/env.ts         — WP_BASE_URL / fetch-cookie / caps / name decoding
//   wp/transport.ts   — the fetch layer (headers, in-flight dedup, paging)
//   wp/pagination.ts  — slot-stable layout math (LOAD-BEARING, see doc/)
//   wp/rest.ts        — standard wp/v2 reads (posts, categories, tags, pages)
//   wp/hero.ts        — optional leaf-category hero strip (config-driven)
//   wp/archive.ts     — slot-stable archive fetchers + search
//   wp/bundles.ts     — staticq/v1/* one-shot bundle endpoints
//   wp/seo.ts         — SEO plugin <head> fragment fetch
//   wp/images.ts      — featured / responsive image helpers
//   wp/display.ts     — author name, primary category, date, reading time

// All shared data shapes.
export type * from './wp/types';

// Config / environment.
export { WP_BASE_URL } from './wp/env';

// Slot-stable pagination.
export { SEAL_SIZE, LIVE_MIN, LIVE_MAX, computeArchiveLayout } from './wp/pagination';

// Standard WP REST reads.
export {
	getPostBySlug,
	getAllPostsSummary,
	getTotalPostCount,
	getDirectChildren,
	getCategories,
	getCategoryBySlug,
	getPages,
	getPageBySlug,
	getPostCustomFields,
	getPagesSlim,
	getTags,
	getTagBySlug,
} from './wp/rest';

// Leaf-category hero strip.
export { HERO_TAG_SLOTS, HERO_ROOT_SLUGS, getCategoryHeroPosts } from './wp/hero';

// Slot-stable archive fetchers + search.
export {
	getCategoryArchive,
	searchPosts,
	getTagArchive,
	getHomeArchive,
} from './wp/archive';

// staticq/v1 bundle endpoints.
export {
	getAuthorBundle,
	getSiteConfig,
	getHomepageBundle,
	getSingleBundle,
	getSitemapBundle,
	getArchiveBundle,
} from './wp/bundles';

// SEO <head> fragment.
export { getHomeFallbackHeadIfThin, getSeoHead, getRankMathHead } from './wp/seo';

// Image helpers.
export { getFeaturedImageUrl, getFeaturedImageAlt, getResponsiveImage } from './wp/images';

// Post display helpers.
export { getAuthorName, getPrimaryCategory, formatDate, readingTimeMinutes } from './wp/display';
