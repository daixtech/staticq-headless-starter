import type { APIRoute } from 'astro';
import { IS_STAGING, SITE_INDEXABLE, absoluteUrl } from '../lib/site';

export const GET: APIRoute = async () => {
	// The staging worker is never crawlable, whatever SITE_INDEXABLE says
	// — worker identity outranks the site-level indexing setting.
	const body = (SITE_INDEXABLE && !IS_STAGING)
		? `User-agent: *
Allow: /

Sitemap: ${absoluteUrl('/sitemap.xml')}
`
		: `User-agent: *
Disallow: /
`;
	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=3600',
		},
	});
};
