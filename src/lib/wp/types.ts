// Shared WordPress REST + StaticQ bundle-endpoint data shapes. Pure types —
// no runtime code, so every wp/* module can import from here without pulling
// in fetch logic or creating import cycles.

export interface WPRenderedField {
	rendered: string;
}

export interface WPEmbeddedMedia {
	id: number;
	source_url: string;
	media_details?: {
		sizes?: Record<string, { source_url: string; width: number; height: number }>;
	};
	alt_text?: string;
}

export interface WPEmbeddedAuthor {
	id: number;
	name: string;
	slug: string;
	avatar_urls?: Record<string, string>;
}

export interface WPEmbeddedTerm {
	id: number;
	taxonomy: string;
	slug: string;
	name: string;
	link: string;
}

export interface WPEmbedded {
	'wp:featuredmedia'?: WPEmbeddedMedia[];
	author?: WPEmbeddedAuthor[];
	'wp:term'?: WPEmbeddedTerm[][];
}

export interface WPPost {
	id: number;
	slug: string;
	date: string;
	modified: string;
	link: string;
	title: WPRenderedField;
	content: WPRenderedField;
	excerpt: WPRenderedField;
	categories: number[];
	tags: number[];
	_embedded?: WPEmbedded;
	// Custom REST field added by the staticq-headless plugin's
	// Endpoints::register() — the per-post primary category term ID
	// (from Rank Math or Yoast) for breadcrumb construction. null when
	// not set. See Endpoints.php / src/Seo for context.
	primary_category?: number | null;
	// Deprecated alias of primary_category, kept while older WP installs
	// still emit only the old field name.
	rank_math_primary_category?: number | null;
	// Per-post subtitle (the line below the title). Sourced by the plugin
	// from a filterable postmeta key — see src/Post/Subtitle.php. Renders
	// on archive cards (StackedCard, OverlayCard) and below the H1 in the
	// post hero. Empty string when unset.
	subtitle?: string;
	// Deprecated alias of subtitle, kept while older WP installs still
	// emit only the old field name.
	zeen_subtitle?: string;
}

export interface WPCategory {
	id: number;
	count: number;
	description: string;
	link: string;
	name: string;
	slug: string;
	parent: number;
}

export interface WPPostSummary {
	slug: string;
	date: string;
	modified: string;
}

// Slot-stable pagination layout. See wp/pagination.ts for the math and the
// SEAL_SIZE / LIVE_MIN / LIVE_MAX constants.
export interface ArchiveLayout {
	totalPosts: number;
	sealedPagesCount: number;
	livePageSize: number;
}

export interface HeroTagSlot {
	/** WordPress tag ID whose intersection with the leaf category fills the slot. */
	tagId: number;
	/** Kicker text shown on the hero card. */
	label: string;
	/** Stable identifier for the slot. */
	key: string;
}

export interface HeroSlot {
	key: string;
	label: string;
	post: WPPost;
}

export interface WPTag {
	id: number;
	count: number;
	description: string;
	link: string;
	name: string;
	slug: string;
}

export interface WPPage {
	id: number;
	slug: string;
	date: string;
	modified: string;
	link: string;
	parent: number;
	menu_order: number;
	title: WPRenderedField;
	content: WPRenderedField;
	excerpt: WPRenderedField;
	_embedded?: WPEmbedded;
}

// Fetch the custom REST fields the /staticq/v1/single bundle endpoint
// doesn't expose (it strips register_rest_field additions). Currently
// `primary_category` (for breadcrumb chain construction) and `subtitle`
// (for card + hero subtitle line). Both addressed in Endpoints::register().
export interface PostCustomFields {
	primary_category: number | null;
	subtitle: string;
}

// Slim variant of the all-pages list — only id / slug / parent / link.
// Used by the hierarchical-page catch-all route to walk parent chains
// without paying the _embed and full-content cost of getPages(). For
// a ~100-page site this is a tiny payload and one cached fetch
// per isolate.
export interface WPPageSlim {
	id: number;
	slug: string;
	parent: number;
	link: string;
	// Page title — used by [...rest].astro and [slug].astro to label
	// breadcrumb crumbs without an extra REST round-trip per ancestor.
	title?: { rendered: string };
}

// Author archive types. The plugin's URL engine emits `/author/<slug>/`
// (live) and `/author/<slug>/page/<N>/` (sealed slot-stable pages); both
// resolve via the /staticq/v1/archive bundle endpoint's `author_slug`
// param. Direct wp/v2/users lookup is blocked by AIOSEO (and similar
// security plugins) under the `aios_user_lists_forbidden` code, so the
// plugin side resolves authors via get_user_by() in PHP and returns the
// user info bundled with the archive response.
export interface WPAuthor {
	id: number;
	slug: string;
	name: string;
	description: string;
	link: string;
	avatar_urls?: Record<string, string>;
}

export interface AuthorBundle {
	author: WPAuthor;
	posts: WPPost[];
	layout: ArchiveLayout;
	seoHead?: string | null;
}

export interface SiteConfigImage {
	url: string;
	width: number;
	height: number;
}

export interface SiteConfigNavLink {
	href: string;
	label: string;
}

export interface SiteConfigNavGroup {
	label: string;
	children: SiteConfigNavLink[];
}

export type SiteConfigNavEntry = SiteConfigNavLink | SiteConfigNavGroup;

export interface SiteConfig {
	brand: {
		name: string;
		description: string;
		logo?: SiteConfigImage | null;
		og_default_image?: SiteConfigImage | null;
	};
	social?: {
		twitter?: string | null;
		facebook?: string | null;
		instagram?: string | null;
		youtube?: string | null;
	} | null;
	analytics?: {
		google_analytics_id?: string | null;
		plausible_domain?: string | null;
	} | null;
	indexable?: boolean | null;
	primary_nav?: SiteConfigNavEntry[] | null;
	footer?: {
		tagline?: string | null;
		copyright?: string | null;
		links?: SiteConfigNavLink[] | null;
	} | null;
	// CPT/taxonomy URL bases the plugin instance is computing on its side
	// (see `register_post_type_object()->rewrite['slug']`,
	// `get_option('category_base')`, etc). When present, Astro consumes them
	// here instead of hardcoding the defaults. Optional today — the field
	// arrives when the WP-plugin instance ships the generic url_bases work.
	url_bases?: {
		web_story_archive?: string | null;
	} | null;
}

export interface HomepageBundle {
	home_archive: {
		posts: WPPost[];
		layout: ArchiveLayout;
	};
	// The active SEO plugin's pre-rendered <head> fragment for the home
	// URL, bundled in the same response so the home route doesn't need a
	// second HTTP call. Null when no supported SEO plugin is active or its
	// output isn't reachable. `rank_math_head` is a deprecated alias.
	seo_head?: string | null;
	rank_math_head?: string | null;
}

export interface GalleryAttachmentSize {
	url: string;
	w: number;
	h: number;
}

export interface GalleryAttachment {
	id: number;
	alt: string;
	sizes: Record<string, GalleryAttachmentSize>;
	// Unscaled-upload URL when WP's big_image_size_threshold downscaled
	// the master file. Null when no scaling happened (master IS the
	// original). The download button uses this when available so users
	// get the highest-fidelity file.
	original_url: string | null;
}

export interface SingleBundle {
	type: 'post' | 'page';
	post: WPPost;
	// SEO plugin head fragment (Rank Math / Yoast); `rank_math_head` is a
	// deprecated alias kept for older WP installs.
	seo_head?: string | null;
	rank_math_head?: string | null;
	// Every image attached to the post (post_parent = post.id,
	// post_type = attachment, image/* mime), each with all registered
	// sizes. Emitted for every post/page; the lightbox only activates on
	// anchors whose href matches an attachment URL, so posts without
	// inline image links never trigger it. Empty array when the post has
	// no image attachments.
	gallery_attachments?: GalleryAttachment[];
}

export interface SitemapBundleImage {
	url: string;
	alt: string;
}

export interface SitemapBundlePost {
	id: number;
	slug: string;
	date: string;
	modified: string;
	image: SitemapBundleImage | null;
}

export interface SitemapBundlePage {
	id: number;
	slug: string;
	date: string;
	modified: string;
}

export interface SitemapBundleTaxonomyEntry {
	slug: string;
	count: number;
}

export interface SitemapBundle {
	posts: SitemapBundlePost[];
	pages: SitemapBundlePage[];
	categories: SitemapBundleTaxonomyEntry[];
	tags: SitemapBundleTaxonomyEntry[];
	total_post_count: number;
}

export interface ArchiveBundleArgs {
	page: number | null;
	categoryId?: number;
	tagId?: number;
	// When true and a categoryId is set, include posts from all
	// descendant categories in the archive (matches WP_Query default
	// `cat=X` behavior and the plugin URL engine's count). No effect
	// for tag archives (tags are non-hierarchical). See
	// doc/reversed-pagination.md §13.5 for the counting contract.
	includeDescendants?: boolean;
	/** Post IDs to omit from the rendered list (display-time only). */
	excludeIds?: number[];
}

export interface ArchiveBundle {
	posts: WPPost[];
	layout: ArchiveLayout;
	// The active SEO plugin's pre-rendered <head> fragment for the
	// canonical archive URL (term link + optional `page/N/` suffix),
	// bundled in the same response so archive routes don't need a second
	// HTTP call. Null when no supported SEO plugin is active or its
	// output isn't reachable.
	seoHead?: string | null;
}

export interface ResponsiveImageVariant {
	src: string;
	webp: string;
	width: number;
	height: number;
}

export interface ResponsiveImageData {
	// Default src — the variant matching `preferredSize` if it exists, else
	// the largest registered variant. Used as the <img> element's `src` so
	// browsers that don't pick from srcset still get something reasonable.
	src: string;
	width: number;
	height: number;
	alt: string;
	// All registered variants, sorted by width ascending. Drives the
	// srcset (both JPG and the derived WebP) on the <picture> element.
	variants: ResponsiveImageVariant[];
}
