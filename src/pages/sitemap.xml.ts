import type { APIRoute } from 'astro';
import { SITEMAP_CACHE_MAX_AGE, buildSitemapXml } from '../lib/sitemap';

export const GET: APIRoute = async () => {
	const xml = await buildSitemapXml();
	return new Response(xml, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': `public, max-age=${SITEMAP_CACHE_MAX_AGE}`,
		},
	});
};
