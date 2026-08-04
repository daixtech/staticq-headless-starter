// ===========================================================================
//  Telling "this doesn't exist" apart from "WordPress didn't answer"
// ===========================================================================
//
// A route that resolves content by slug has three possible outcomes, and
// collapsing them into two causes real damage:
//
//   found       -> render it
//   absent      -> 404, correctly: the content is gone
//   unavailable -> WordPress timed out / errored. NOT a 404.
//
// The trap is that a rejected lookup and an empty lookup both end up as
// "falsy page" if you write `const page = await getPageBySlug(slug).catch(
// () => null)`, or as a thrown error that the framework renders with the 404
// page. Either way a temporary origin problem is published as "this page does
// not exist" - which crawlers believe, and which a cache layer may store.
//
// This happened here: a 15s fetch timeout fired on pages whose origin render
// legitimately takes 33s (wpDataTables shortcodes), and 33 live URLs that had
// been serving 200 started returning 404.
//
// So: resolve the three cases explicitly, and answer an unavailable upstream
// with 503 - honest, uncacheable, and retried rather than believed.

export type Lookup<T> =
	| { state: 'found'; value: T }
	| { state: 'absent' }
	| { state: 'unavailable'; error: unknown };

/**
 * Run a slug lookup and classify the outcome. `fn` should resolve to the
 * object, or to null/undefined when the origin answered and the content
 * genuinely isn't there.
 */
export async function lookup<T>(fn: () => Promise<T | null | undefined>): Promise<Lookup<T>> {
	try {
		const value = await fn();
		return value ? { state: 'found', value } : { state: 'absent' };
	} catch (error) {
		return { state: 'unavailable', error };
	}
}

/**
 * The response for "WordPress didn't answer". 503 + no-store, so the edge and
 * R2 layers skip it (they only keep 200s) and a retry can succeed.
 *
 * Deliberately not a 404: a 404 tells search engines the URL is dead, and
 * survives in caches long after the origin recovers.
 */
export function upstreamUnavailable(detail?: string): Response {
	return new Response(
		`Upstream temporarily unavailable${detail ? `: ${detail}` : ''}`,
		{
			status: 503,
			headers: {
				'Cache-Control': 'no-store',
				'Retry-After': '60',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		},
	);
}
