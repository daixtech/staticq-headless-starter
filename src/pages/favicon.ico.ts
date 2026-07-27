import type { APIRoute } from 'astro';
import { serveSiteIcon } from '../lib/site-icon';

/**
 * First-party favicon backed by the WordPress Site Icon (Settings →
 * General). Dynamic route rather than a static file so the operator
 * changes the icon in WP admin and the frontend follows — no rebuild,
 * no redeploy, no page purge (see lib/site-icon.ts for the caching
 * contract). Also answers the blind /favicon.ico probe browsers and
 * crawlers make regardless of what the HTML declares.
 */
export const GET: APIRoute = async ({ request, locals }) => {
	const cfContext = (locals as { cfContext?: ExecutionContext }).cfContext;
	return serveSiteIcon(request, cfContext, () =>
		// No Site Icon configured in WP → the bundled static SVG. A 302
		// (not 301) so the redirect isn't sticky in browser caches once
		// an icon IS set; short-cached for the same reason.
		new Response(null, {
			status: 302,
			headers: {
				Location: '/favicon.svg',
				'Cache-Control': 'public, max-age=300',
			},
		}),
	);
};
