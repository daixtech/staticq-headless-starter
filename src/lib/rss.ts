import {
	getAuthorName,
	getFeaturedImageUrl,
	getHomeArchive,
	getPrimaryCategory,
	getSiteConfig,
	type WPPost,
} from './wp';
import {
	SITE_DESCRIPTION,
	SITE_TITLE,
	SITE_URL,
	absoluteUrl,
} from './site';

// Canonical self URL for the feed. Both /feed/ (the WP convention) and
// /rss.xml (the legacy alias kept for backward compat) emit this as
// atom:link rel="self" so RSS readers learn the preferred URL.
const FEED_SELF_PATH = '/feed/';

// Cache-Control window for both feed routes. Long enough that polling
// readers don't hammer the origin; short enough that new posts surface
// within a reasonable window even if the WP-side purge pipeline doesn't
// invalidate the feed explicitly.
export const FEED_CACHE_MAX_AGE = 600;

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function cdata(s: string): string {
	return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function buildItem(post: WPPost): string {
	const link = absoluteUrl(`/${post.slug}/`);
	const author = getAuthorName(post);
	const category = getPrimaryCategory(post);
	// Featured image — preferred sizes in order. Fall back through each
	// registered size so single-image attachments without medium_large
	// still get a thumbnail.
	const thumbnailUrl =
		getFeaturedImageUrl(post, 'medium_large')
		?? getFeaturedImageUrl(post, 'large')
		?? getFeaturedImageUrl(post, 'full');
	const thumbnail = thumbnailUrl
		? `\n\t\t\t<media:thumbnail url="${escapeXml(thumbnailUrl)}" />`
		: '';
	const creator = author
		? `\n\t\t\t<dc:creator>${cdata(author)}</dc:creator>`
		: '';
	const cat = category
		? `\n\t\t\t<category>${cdata(category.name)}</category>`
		: '';
	return `
		<item>
			<title>${cdata(post.title.rendered)}</title>
			<link>${escapeXml(link)}</link>
			<guid isPermaLink="true">${escapeXml(link)}</guid>
			<pubDate>${new Date(post.date).toUTCString()}</pubDate>${creator}${cat}
			<description>${cdata(post.excerpt.rendered)}</description>${thumbnail}
		</item>`;
}

// Builds the RSS 2.0 XML for the site-wide feed. Pulls the live archive
// page (10..19 newest posts) via the bundle endpoint when available;
// falls back to the per-call WP REST path automatically inside
// getHomeArchive on null.
//
// Why excerpt-only (no content:encoded): the bundle endpoint deliberately
// skips post content because rendering it via apply_filters('the_content')
// is by far the most expensive part of a default WP REST response. A
// content-full feed would either need a separate slower endpoint or a
// per-call _embed walk — both regressing the cold-render time. Readers
// that want full text can visit the article link directly. If a content
// feed becomes a hard requirement, the right fix is a content-enabled
// flag on the WP-side bundle endpoint, not a slower Astro route.
export async function buildRssFeed(): Promise<string> {
	const [archive, siteConfig] = await Promise.all([
		getHomeArchive(null),
		getSiteConfig(),
	]);

	const posts = archive.posts;
	const channelTitle = siteConfig?.brand.name ?? SITE_TITLE;
	const channelDescription = siteConfig?.brand.description ?? SITE_DESCRIPTION;
	const channelLink = SITE_URL;
	const selfLink = absoluteUrl(FEED_SELF_PATH);

	// lastBuildDate tracks the newest post's modified-or-published time so
	// conditional GETs (If-Modified-Since) and caching layers can short-
	// circuit when no posts have changed.
	const lastBuildDate = posts[0]
		? new Date(posts[0].modified || posts[0].date).toUTCString()
		: new Date().toUTCString();

	const items = posts.map(buildItem).join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:atom="http://www.w3.org/2005/Atom"
	xmlns:media="http://search.yahoo.com/mrss/">
	<channel>
		<title>${cdata(channelTitle)}</title>
		<link>${escapeXml(channelLink)}</link>
		<atom:link href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />
		<description>${cdata(channelDescription)}</description>
		<language>en-us</language>
		<lastBuildDate>${lastBuildDate}</lastBuildDate>
		<generator>StaticQ / Astro</generator>
		<ttl>${Math.floor(FEED_CACHE_MAX_AGE / 60)}</ttl>${items}
	</channel>
</rss>`;
}
