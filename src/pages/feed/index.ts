import type { APIRoute } from 'astro';
import { FEED_CACHE_MAX_AGE, buildRssFeed } from '../../lib/rss';

// WordPress-convention RSS feed at /feed/. The XML body lives in
// lib/rss.ts so /rss.xml can serve the same content.
export const GET: APIRoute = async () => {
	const xml = await buildRssFeed();
	return new Response(xml, {
		headers: {
			'Content-Type': 'application/rss+xml; charset=utf-8',
			'Cache-Control': `public, max-age=${FEED_CACHE_MAX_AGE}`,
		},
	});
};
