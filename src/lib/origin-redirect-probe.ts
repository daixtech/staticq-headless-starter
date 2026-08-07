import { WP_BASE_URL, WP_FETCH_COOKIE } from './wp/env';

// ===========================================================================
//  Origin redirect probe
// ===========================================================================
//
// Once this Worker serves the content routes, WordPress's redirect
// machinery never runs for them: the passthrough only hands WP its own
// paths (/wp-admin, /wp-json, feeds, sitemaps), and everything else is
// resolved here against REST. A slug that no longer exists at the
// requested URL becomes a hard 404 - even though WordPress, asked
// directly, would have redirected it.
//
// That covers more than renamed posts:
//   - `_wp_old_slug` postmeta, which wp_old_slug_redirect() 301s
//   - Rank Math Redirections (or any redirect plugin's rules)
//   - legacy pre-WP URLs mapped at the server level
//   - anything a future plugin adds
//
// Rather than reimplement each of those - and re-implement whatever gets
// added next - ask the origin what IT would do with this path and mirror
// the answer. One probe covers every redirect source, present and future.
//
// DESIGN NOTE: whatever origin answers is what visitors get, by
// definition. That includes answers you might not expect: if Rank Math
// is configured to send all 404s to the homepage, dead URLs will land on
// the homepage here too. That is the site's own configuration being
// faithfully mirrored, not something for this module to second-guess -
// diverging would leave the headless frontend quietly disagreeing with
// the WordPress settings that produced it.

/**
 * How long to wait for the origin's answer.
 *
 * This runs on the 404 path, so it is pure added latency for a visitor
 * who is already getting an error page. Bounded low enough that a slow
 * origin can never hang error pages.
 */
const PROBE_TIMEOUT_MS = 4000;

/** Redirect statuses worth mirroring, each preserved as-is. */
const MIRRORED_STATUSES = new Set([301, 302, 307, 308]);

export interface OriginRedirect {
	status: 301 | 302 | 307 | 308;
	/** Path (+ query) on the public site. Never an origin-host URL. */
	location: string;
}

/**
 * What the origin thinks of a path we were about to 404.
 *
 *   redirect — mirror it.
 *   exists   — the origin serves this path. We are about to publish a 404
 *              for a URL that is NOT gone, so answer 503 instead.
 *   gone     — the origin 404s it too. Our 404 is correct.
 *   unknown  — probe failed (timeout, network, unexpected status). No
 *              information, so leave the caller's 404 behavior alone.
 */
export type OriginVerdict =
	| ({ kind: 'redirect' } & OriginRedirect)
	| { kind: 'exists' }
	| { kind: 'gone' }
	| { kind: 'unknown' };

/**
 * Ask the origin what it would do with `pathname`, and return a redirect
 * to mirror, or `null` to proceed with the 404.
 *
 * Thin wrapper over probeOrigin() for callers that only care about
 * redirects. Never throws.
 *
 * @param pathname Requested path, e.g. `/some-old-slug/`.
 * @param search   Original query string including `?`, if any.
 */
export async function probeOriginRedirect(
	pathname: string,
	search = '',
): Promise<OriginRedirect | null> {
	const verdict = await probeOrigin(pathname, search);
	return verdict.kind === 'redirect'
		? { status: verdict.status, location: verdict.location }
		: null;
}

/**
 * The full verdict, including the case that matters most: the origin
 * serves this path even though our own lookup came up empty.
 *
 * WHY THIS EXISTS. A slug lookup that returns an empty (but successful)
 * result is indistinguishable from "deleted" at the call site — nothing
 * threw, so error handling never runs. WordPress does return empty
 * result sets for pages that exist: a warmup hammering the origin can
 * push a slug query past a DB timeout, and the REST response is a
 * perfectly well-formed `200 []`. Observed on a 10k-URL run: 7 published
 * pages served 404 that way, all of them heavy-shortcode pages whose
 * neighbours in the same batch were taking 44-98s.
 *
 * A 404 is the one wrong answer there. Crawlers believe it, caches keep
 * it, and it outlives the load spike that caused it. So before
 * publishing one, ask the origin — it already knows, and this probe was
 * already making the call to look for redirects.
 *
 * Never throws: any failure is reported as `unknown`, which leaves the
 * caller's existing 404 behavior intact.
 */
export async function probeOrigin(
	pathname: string,
	search = '',
): Promise<OriginVerdict> {
	if (!WP_BASE_URL || !pathname) return { kind: 'unknown' };

	try {
		const target = `${WP_BASE_URL}${pathname}${search}`;
		const headers: Record<string, string> = {
			// Same UA + gate cookie the REST client uses, so the WAF rule
			// that admits our origin traffic admits this too.
			'User-Agent':
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		};
		if (WP_FETCH_COOKIE) headers.Cookie = WP_FETCH_COOKIE;

		// HEAD: WordPress runs the same request pipeline as GET (so
		// template_redirect, and with it wp_old_slug_redirect and Rank
		// Math, still fire) but sends no body. `redirect: 'manual'` keeps
		// the redirect instead of following it - we want to mirror the
		// origin's status, not resolve it ourselves.
		const res = await fetch(target, {
			method: 'HEAD',
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

		if (!MIRRORED_STATUSES.has(res.status)) {
			// Not a redirect. The status still tells us whether the URL is
			// real. Note this answer can come from the origin's own edge
			// cache — which is fine and in fact the point: a cached 200
			// proves the URL is a real, published page, whatever state the
			// origin's database is in right now.
			if (res.status >= 200 && res.status < 300) return { kind: 'exists' };
			if (res.status === 404 || res.status === 410) return { kind: 'gone' };
			// 5xx and anything else: the origin is unwell, not authoritative.
			return { kind: 'unknown' };
		}
		const location = res.headers.get('location');
		if (!location) return { kind: 'unknown' };

		// Normalize to a path on the public site. Origin may answer with an
		// absolute URL on its own hostname; that hostname must never reach
		// a visitor. Anything that isn't http(s) is ignored outright.
		let normalized: string;
		try {
			const resolved = new URL(location, target);
			if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
				return { kind: 'unknown' };
			}
			normalized = `${resolved.pathname}${resolved.search}`;
		} catch {
			return { kind: 'unknown' };
		}

		// Self-redirect guard: a Location that resolves back to what was
		// requested (trailing-slash or protocol-only differences) would
		// loop forever. Fall through to the 404 instead.
		//
		// KNOWN LIMIT: this catches A -> A, not A -> B -> A. If the origin
		// redirects to another path that also 404s here and points back,
		// the visitor sees a browser redirect loop. Browsers cap the chain,
		// so it surfaces as an error page rather than anything server-side.
		if (normalized === `${pathname}${search}`) return { kind: 'unknown' };

		return {
			kind: 'redirect',
			status: res.status as OriginRedirect['status'],
			location: normalized,
		};
	} catch {
		// Timeout, abort, DNS, TLS - no information either way.
		return { kind: 'unknown' };
	}
}
