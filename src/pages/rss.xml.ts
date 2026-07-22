import type { APIRoute } from 'astro';
import { FEED_CACHE_MAX_AGE, buildRssFeed } from '../lib/rss';

// Legacy alias kept for backward compatibility with any RSS readers
// subscribed to the pre-/feed/ URL. Emits the same XML as /feed/ via the
// shared helper; the <atom:link rel="self"> inside that XML points at
// /feed/ so reader clients learn the preferred URL.
export const GET: APIRoute = async () => {
	const xml = await buildRssFeed();
	return new Response(xml, {
		headers: {
			'Content-Type': 'application/rss+xml; charset=utf-8',
			'Cache-Control': `public, max-age=${FEED_CACHE_MAX_AGE}`,
		},
	});
};
