import {
	WP_BASE_URL,
	computeArchiveLayout,
	getAllPostsSummary,
	getCategories,
	getPages,
	getSitemapBundle,
	getTags,
	getTotalPostCount,
	type SitemapBundleImage,
	type SitemapBundlePage,
	type SitemapBundlePost,
	type SitemapBundleTaxonomyEntry,
} from './wp';
import { SITE_NAME, SITE_TITLE, SITE_URL, absoluteUrl } from './site';
import { envStr } from './runtime-env';

// Shared shared-secret cookie used to bypass the WP-side Cloudflare WAF
// challenges. Local to this module — same pattern as wp.ts. Empty when
// unset, which is fine for installs that don't gate WP.
const WP_FETCH_COOKIE = envStr('WP_FETCH_COOKIE');

// `Cache-Control: max-age` (seconds) for the generated /sitemap.xml. One
// hour balances freshness against origin load — the per-URL purge
// pipeline handles urgent content changes, so the sitemap can lag a bit.
export const SITEMAP_CACHE_MAX_AGE = 3600;

function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlDecode(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

interface UrlEntry {
	loc: string;
	lastmod?: string;
	changefreq?: 'daily' | 'weekly' | 'monthly';
	priority?: string;
	image?: SitemapBundleImage | null;
}

function urlNode({ loc, lastmod, changefreq, priority, image }: UrlEntry): string {
	const inner = [
		`\t\t<loc>${escapeXml(loc)}</loc>`,
		lastmod ? `\t\t<lastmod>${lastmod}</lastmod>` : null,
		changefreq ? `\t\t<changefreq>${changefreq}</changefreq>` : null,
		priority ? `\t\t<priority>${priority}</priority>` : null,
		image && image.url
			? `\t\t<image:image>\n\t\t\t<image:loc>${escapeXml(image.url)}</image:loc>${
					image.alt ? `\n\t\t\t<image:title>${escapeXml(image.alt)}</image:title>` : ''
			  }\n\t\t</image:image>`
			: null,
	]
		.filter(Boolean)
		.join('\n');
	return `\t<url>\n${inner}\n\t</url>`;
}

// ---------------------------------------------------------------------------
// SEO-plugin sitemap consumer (proxy + sanitize pattern).
// ---------------------------------------------------------------------------
//
// Both Rank Math and Yoast expose XML sitemaps at the same conventional
// entry point on the WP origin — `/sitemap_index.xml` — which links out to
// per-type sub-sitemaps (post-sitemapN.xml + category-sitemapN.xml +
// page-sitemap.xml, etc.). We fetch them, parse the <url> entries, rewrite
// each <loc> from the WP host to the headless host, and re-emit one
// consolidated <urlset>. Net effect: the SEO plugin owns the editorial URL
// selection (with all its admin-configured filters); Astro owns
// emission. When no SEO-plugin sitemap is reachable we fall back to our
// own /sqheadless/v1/sitemap bundle (see below).
//
// Sanitization comes for free — we never copy raw bytes through. Any
// leading whitespace, wrong content-type, BOM, or stray PHP output in
// the upstream response is invisible to the output. We extract
// structured data and re-emit it cleanly.
//
// Image <image:loc> URLs are NOT rewritten — those point at attachment
// files that physically live on the WP origin (or its CDN). Only the
// page-URL <loc> gets the headless host.

interface SeoSitemapUrlEntry {
	loc: string;
	lastmod?: string;
	imageLoc?: string;
	imageTitle?: string;
}

async function fetchWpXml(url: string): Promise<string | null> {
	try {
		const headers: Record<string, string> = {
			'User-Agent':
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Accept: 'application/xml, text/xml, text/html',
		};
		if (WP_FETCH_COOKIE) headers.Cookie = WP_FETCH_COOKIE;
		const res = await fetch(url, { headers });
		if (!res.ok) return null;
		const text = await res.text();
		// Strip leading whitespace / BOM. Sub-sitemaps usually arrive
		// clean but the index has been known to ship with WP's stray
		// pre-output debris on this install.
		const cleaned = text.replace(/^[\s﻿]+/, '');
		return cleaned.length > 0 ? cleaned : null;
	} catch {
		return null;
	}
}

function extractLocs(xml: string): string[] {
	const out: string[] = [];
	const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const url = xmlDecode(m[1].trim());
		if (url) out.push(url);
	}
	return out;
}

function parseUrlBlocks(xml: string): SeoSitemapUrlEntry[] {
	const out: SeoSitemapUrlEntry[] = [];
	const blockRe = /<url>([\s\S]*?)<\/url>/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(xml)) !== null) {
		const block = m[1];
		const locM = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/);
		if (!locM) continue;
		const lastmodM = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/);
		const imgLocM = block.match(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/);
		const imgTitleM = block.match(/<image:title>\s*([^<]+?)\s*<\/image:title>/);
		out.push({
			loc: xmlDecode(locM[1].trim()),
			lastmod: lastmodM ? xmlDecode(lastmodM[1].trim()) : undefined,
			imageLoc: imgLocM ? xmlDecode(imgLocM[1].trim()) : undefined,
			imageTitle: imgTitleM ? xmlDecode(imgTitleM[1].trim()) : undefined,
		});
	}
	return out;
}

// Strip the WP base (with or without protocol) from a URL and replace
// with SITE_URL. Leaves URLs already on SITE_URL or on different hosts
// (e.g. static.example.com for images) untouched.
function rewriteHost(url: string): string {
	if (!WP_BASE_URL) return url;
	const wpClean = WP_BASE_URL.replace(/\/$/, '');
	const siteClean = SITE_URL.replace(/\/$/, '');
	if (url.startsWith(wpClean)) {
		return siteClean + url.slice(wpClean.length);
	}
	// Some installs emit the host without protocol — handle that too.
	const wpHost = wpClean.replace(/^https?:\/\//, '');
	const siteHost = siteClean.replace(/^https?:\/\//, '');
	const m = url.match(/^(https?:)\/\/([^/]+)(\/.*)?$/);
	if (m && m[2] === wpHost) {
		return `https://${siteHost}${m[3] ?? ''}`;
	}
	return url;
}

// Try to discover sub-sitemap URLs from the index. Returns [] if the
// index is missing, malformed, or empty.
async function discoverSubSitemapsFromIndex(): Promise<string[]> {
	if (!WP_BASE_URL) return [];
	const xml = await fetchWpXml(`${WP_BASE_URL}/sitemap_index.xml`);
	if (!xml) return [];
	if (!/<sitemapindex\b/.test(xml)) return [];
	return extractLocs(xml);
}

// Hard-coded enumeration of conventional sub-sitemap names (the shape
// Rank Math and Yoast both use). Used as a fallback when the index isn't
// usable (e.g. broken by stray pre-output whitespace on some installs).
// Names that don't exist for the active plugin simply 404 and are
// dropped, so this is harmless when the index already worked. Probes
// every candidate in parallel and keeps only those that respond 200 with
// non-empty XML.
async function discoverSubSitemapsByEnumeration(): Promise<{ url: string; xml: string }[]> {
	if (!WP_BASE_URL) return [];
	const candidates: string[] = [];
	for (let i = 1; i <= 30; i++) {
		candidates.push(`${WP_BASE_URL}/post-sitemap${i}.xml`);
	}
	for (let i = 1; i <= 10; i++) {
		candidates.push(`${WP_BASE_URL}/category-sitemap${i}.xml`);
	}
	candidates.push(`${WP_BASE_URL}/page-sitemap.xml`);

	const results = await Promise.allSettled(
		candidates.map(async (url) => {
			const xml = await fetchWpXml(url);
			if (!xml) return null;
			if (!/<urlset\b/.test(xml)) return null;
			return { url, xml };
		}),
	);
	return results
		.filter(
			(r): r is PromiseFulfilledResult<{ url: string; xml: string }> =>
				r.status === 'fulfilled' && r.value !== null,
		)
		.map((r) => r.value);
}

// Top-level: returns the flat list of URL entries the active SEO plugin
// (Rank Math / Yoast) emits across all its sub-sitemaps. Tries the
// `/sitemap_index.xml` index first (one HTTP call when it works); if the
// index is missing or broken we fall through to enumerating conventional
// sub-sitemap names. Either path produces the same set.
async function fetchSeoSitemap(): Promise<SeoSitemapUrlEntry[]> {
	if (!WP_BASE_URL) return [];

	let subSitemaps: { url: string; xml: string }[] = [];

	const indexUrls = await discoverSubSitemapsFromIndex();
	if (indexUrls.length > 0) {
		const results = await Promise.allSettled(
			indexUrls.map(async (url) => {
				const xml = await fetchWpXml(url);
				return xml ? { url, xml } : null;
			}),
		);
		subSitemaps = results
			.filter(
				(r): r is PromiseFulfilledResult<{ url: string; xml: string }> =>
					r.status === 'fulfilled' && r.value !== null,
			)
			.map((r) => r.value);
	}

	if (subSitemaps.length === 0) {
		subSitemaps = await discoverSubSitemapsByEnumeration();
	}

	const entries: SeoSitemapUrlEntry[] = [];
	for (const { xml } of subSitemaps) {
		for (const entry of parseUrlBlocks(xml)) {
			entries.push({ ...entry, loc: rewriteHost(entry.loc) });
		}
	}
	return entries;
}

function seoSitemapUrlNode(entry: SeoSitemapUrlEntry): string {
	// Match the SEO plugin's own output shape — no changefreq/priority
	// (both deprecated by Google and ignored anyway), keep <lastmod> and
	// <image:image>. Image-loc stays on the WP/CDN host since the
	// binaries live there.
	const inner = [
		`\t\t<loc>${escapeXml(entry.loc)}</loc>`,
		entry.lastmod ? `\t\t<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : null,
		entry.imageLoc
			? `\t\t<image:image>\n\t\t\t<image:loc>${escapeXml(entry.imageLoc)}</image:loc>${
					entry.imageTitle ? `\n\t\t\t<image:title>${escapeXml(entry.imageTitle)}</image:title>` : ''
			  }\n\t\t</image:image>`
			: null,
	]
		.filter(Boolean)
		.join('\n');
	return `\t<url>\n${inner}\n\t</url>`;
}

// ---------------------------------------------------------------------------
// Fallback path — our custom /sqheadless/v1/sitemap bundle.
// ---------------------------------------------------------------------------
//
// Used when the SEO-plugin sitemap proxy returns zero entries (no
// supported SEO plugin, all sub-sitemaps unreachable, etc.). Emits
// posts + pages + categories + tags + sealed pagination URLs from our
// own data path.

interface NormalizedSitemapData {
	posts: SitemapBundlePost[];
	pages: SitemapBundlePage[];
	categories: SitemapBundleTaxonomyEntry[];
	tags: SitemapBundleTaxonomyEntry[];
	totalPostCount: number;
}

async function fetchCustomBundleData(): Promise<NormalizedSitemapData> {
	const bundle = await getSitemapBundle();
	if (bundle) {
		return {
			posts: bundle.posts,
			pages: bundle.pages,
			categories: bundle.categories,
			tags: bundle.tags,
			totalPostCount: bundle.total_post_count,
		};
	}

	const [summaries, categories, tags, pages, totalPosts] = await Promise.all([
		getAllPostsSummary(),
		getCategories(),
		getTags(),
		getPages().catch(() => []),
		getTotalPostCount().catch(() => 0),
	]);

	return {
		posts: summaries.map((s) => ({
			id: 0,
			slug: s.slug,
			date: s.date,
			modified: s.modified,
			image: null,
		})),
		pages: pages.map((p) => ({
			id: p.id,
			slug: p.slug,
			date: p.date,
			modified: p.modified,
		})),
		categories: categories
			.filter((c) => c.count > 0)
			.map((c) => ({ slug: c.slug, count: c.count })),
		tags: tags
			.filter((t) => t.count > 0)
			.map((t) => ({ slug: t.slug, count: t.count })),
		totalPostCount: totalPosts,
	};
}

function buildFallbackSitemapXml(data: NormalizedSitemapData): string {
	const urls: UrlEntry[] = [
		{ loc: absoluteUrl('/'), changefreq: 'daily', priority: '1.0' },
	];

	const homeLayout = computeArchiveLayout(data.totalPostCount);
	for (let n = 1; n <= homeLayout.sealedPagesCount; n++) {
		urls.push({
			loc: absoluteUrl(`/page/${n}/`),
			changefreq: 'monthly',
			priority: '0.4',
		});
	}

	for (const post of data.posts) {
		urls.push({
			loc: absoluteUrl(`/${post.slug}/`),
			lastmod: new Date(post.modified || post.date).toISOString(),
			changefreq: 'weekly',
			priority: '0.8',
			image: post.image,
		});
	}

	for (const cat of data.categories) {
		const layout = computeArchiveLayout(cat.count);
		urls.push({
			loc: absoluteUrl(`/category/${cat.slug}/`),
			changefreq: 'weekly',
			priority: '0.6',
		});
		for (let n = 1; n <= layout.sealedPagesCount; n++) {
			urls.push({
				loc: absoluteUrl(`/category/${cat.slug}/page/${n}/`),
				changefreq: 'monthly',
				priority: '0.3',
			});
		}
	}

	for (const tag of data.tags) {
		const layout = computeArchiveLayout(tag.count);
		urls.push({
			loc: absoluteUrl(`/tag/${tag.slug}/`),
			changefreq: 'weekly',
			priority: '0.5',
		});
		for (let n = 1; n <= layout.sealedPagesCount; n++) {
			urls.push({
				loc: absoluteUrl(`/tag/${tag.slug}/page/${n}/`),
				changefreq: 'monthly',
				priority: '0.3',
			});
		}
	}

	for (const page of data.pages) {
		urls.push({
			loc: absoluteUrl(`/${page.slug}/`),
			lastmod: new Date(page.modified || page.date).toISOString(),
			changefreq: 'monthly',
			priority: '0.7',
		});
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
	xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
	xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(urlNode).join('\n')}
</urlset>`;
}

// ---------------------------------------------------------------------------
// Top-level builder.
// ---------------------------------------------------------------------------

// Prefer the SEO plugin's editorial selection (with all admin-configured
// filters baked in) when available; fall through to the custom bundle
// path when not. Sanitization happens automatically because the proxy
// path parses and re-emits — never copies raw bytes through, so any
// upstream whitespace/BOM/wrong-content-type issues are invisible to
// the output.
export async function buildSitemapXml(): Promise<string> {
	const seoEntries = await fetchSeoSitemap();
	if (seoEntries.length > 0) {
		return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
	xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
	xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${seoEntries.map(seoSitemapUrlNode).join('\n')}
</urlset>`;
	}

	const data = await fetchCustomBundleData();
	return buildFallbackSitemapXml(data);
}

