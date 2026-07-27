import type { APIRoute } from 'astro';
import { serveSiteIcon } from '../lib/site-icon';

/**
 * Apple touch icon backed by the WordPress Site Icon. iOS requests
 * this exact path when a page is added to the home screen (and many
 * crawlers probe it), so serving it first-party keeps the behavior
 * consistent with /favicon.ico. WP's Site Icon is stored large enough
 * (512px source) that iOS scales it down cleanly.
 */
export const GET: APIRoute = async ({ request, locals }) => {
	const cfContext = (locals as { cfContext?: ExecutionContext }).cfContext;
	return serveSiteIcon(request, cfContext, () =>
		// No Site Icon in WP: 404 — iOS falls back to a screenshot tile.
		// The bundled SVG fallback is no use here (iOS won't render SVG
		// touch icons). Short-cached so setting an icon takes effect fast.
		new Response('Not found', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'public, max-age=300',
			},
		}),
	);
};
