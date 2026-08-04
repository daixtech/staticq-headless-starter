import { envStr as runtimeEnvStr, envBool } from './runtime-env';

// Reads an env var (runtime-first via cloudflare:workers, falling back
// to build-time `import.meta.env`), trimming whitespace and treating
// both unset *and* empty string as missing. CI workflows often pass
// through empty `vars.*` values when the repo variable isn't set in
// GitHub Settings — without this guard we'd ship `<title>` suffixes /
// og:site_name / JSON-LD names as "" to production.
function siteStr(key: string, fallback: string): string {
	const raw = runtimeEnvStr(key, '').trim();
	return raw === '' ? fallback : raw;
}

export const SITE_URL = siteStr('SITE_URL', 'http://localhost:4321').replace(/\/$/, '');
export const SITE_TITLE = siteStr('SITE_TITLE', 'My Site');
export const SITE_DESCRIPTION = siteStr(
	'SITE_DESCRIPTION',
	'A headless WordPress site.',
);

// Brand name used in JSON-LD (`Organization.name`) and Open Graph. Defaults
// to SITE_TITLE — usually identical, but the env hook lets you keep a
// shorter <title> brand suffix while still emitting the long-form name in
// structured data.
export const SITE_NAME = siteStr('SITE_NAME', SITE_TITLE);

// Absolute or root-relative path to the site logo. Used in Organization
// JSON-LD. Should be a transparent PNG ideally 600x60 or similar 1:n ratio
// per Google's structured-data guidelines.
export const SITE_LOGO_URL = siteStr('SITE_LOGO_URL', '/logo.svg');

// Fallback Open Graph image, used when a post has no featured media.
// 1200x630 is the canonical Open Graph aspect.
export const SITE_OG_IMAGE_DEFAULT = siteStr('SITE_OG_IMAGE_DEFAULT', '/og-default.svg');

// Optional Twitter handle for `twitter:site`. Leave empty to skip emitting.
export const SITE_TWITTER_HANDLE = siteStr('SITE_TWITTER_HANDLE', '');

// Primary-nav entries shown in the header sub-row. Order is preserved.
// An entry either has an `href` (regular link) OR `children` (becomes a
// dropdown on the top bar and a labeled group section in the side panel).
// `href` is a root-relative path — it can point at a category archive,
// a WP page, or any other internal route. The header doesn't validate
// the target exists, so the configured URLs must resolve on deploy.
export interface PrimaryNavLink {
	href: string;
	label: string;
}

export interface PrimaryNavGroup {
	label: string;
	children: PrimaryNavLink[];
}

export type PrimaryNavEntry = PrimaryNavLink | PrimaryNavGroup;

export function isPrimaryNavGroup(entry: PrimaryNavEntry): entry is PrimaryNavGroup {
	return 'children' in entry && Array.isArray(entry.children);
}

// Primary navigation — EDIT THIS for your site. Each entry is either a
// link ({ href, label }) or a dropdown group ({ label, children: [...] }).
// `href` is a root-relative path pointing at a category archive
// (`/category/<slug>/`), a WP page (`/<slug>/`), or any internal route.
// The header doesn't validate the target, so configured URLs must resolve
// on deploy. Link to a category's CANONICAL parent-chain path (what
// WordPress emits as the term `link`) to avoid a 301 round-trip per click.
//
// Starts empty so a fresh install ships a clean header; add your own.
export const PRIMARY_NAV: PrimaryNavEntry[] = [
	// { href: '/category/news/', label: 'News' },
	// {
	// 	label: 'More',
	// 	children: [
	// 		{ href: '/about/', label: 'About' },
	// 	],
	// },
];

// Defaults to false so unconfigured deploys (e.g. preview URLs) stay out of
// search results until indexing is explicitly opted into.
export const SITE_INDEXABLE = envBool('SITE_INDEXABLE', false);

// Worker identity: 'production' | 'staging'. Pushed as a runtime var by
// the WP plugin's "Push to Astro Worker" (the staging worker gets
// 'staging'); the staging deploy workflow also sets it via `--var` as a
// bootstrap fallback. Identity — NOT SITE_INDEXABLE — decides structural
// behavior: the staging worker skips both cache layers (see
// middleware.ts) and always refuses indexing, regardless of the indexing
// setting. SITE_INDEXABLE only governs whether the PRODUCTION worker is
// indexable. Absent → treated as production, so a bare worker still
// caches; SITE_INDEXABLE's false default keeps an unconfigured worker
// out of search results anyway.
export const WORKER_ENV = siteStr('WORKER_ENV', 'production');
// Re-exported from the single swappable flag module: false as shipped, and
// worker-env.ts is the one file to edit for a non-caching preview deploy.
// Consumers keep importing IS_STAGING from '../lib/site' unchanged.
export { IS_STAGING } from './worker-env';

export function absoluteUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	const trimmed = path.startsWith('/') ? path : `/${path}`;
	return `${SITE_URL}${trimmed}`;
}
