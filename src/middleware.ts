import { defineMiddleware } from 'astro:middleware';
import { env as workersEnv } from 'cloudflare:workers';
import { pathToKey } from './lib/cache-key';
import { envStr } from './lib/runtime-env';
import { IS_STAGING } from './lib/worker-env';
import { shouldPassThrough, passThroughToOrigin } from './lib/wp-passthrough';

// 1 year — content is invalidated by explicit purges from the receiver
// (Mode A), not by TTL expiry. s-maxage applies at the CF edge; max-age=0
// keeps browsers honest so they revalidate via the edge.
const LONG_EDGE_CACHE = 'public, max-age=0, s-maxage=31536000, must-revalidate';

// Worker identity decides cache behavior: a production Worker uses the edge
// + R2 layers; a Worker flagged IS_STAGING skips them and renders fresh on
// every request. IS_STAGING comes from ./lib/worker-env — false as shipped;
// see that file to enable it for a second, non-caching deploy.
const STAGING_NO_CACHE = 'no-store, must-revalidate';

// Optional shared-secret cookie that gates access to the whole frontend.
// Format `name=value` (e.g. `mysite=secret123`). Empty = no gate, public.
// Same shape as WP_FETCH_COOKIE but a separate var so the WP-fetch cookie
// and the visitor gate can rotate independently.
const SITE_GATE_COOKIE = envStr('SITE_GATE_COOKIE');

interface BoundEnv {
	PAGES?: R2Bucket;
	// CF Pages ASSETS binding. Auto-injected by the Astro Cloudflare
	// adapter so the Worker can read from the static-assets bucket
	// without going over HTTP. Used by the snapshot-mode CSS inliner
	// to avoid same-zone subrequest loops on `/_astro/*` paths.
	ASSETS?: { fetch(req: Request): Promise<Response> };
}

// Surfaces a missing R2 PAGES binding the first time the middleware tries
// to write to it. Most common cause: a `wrangler deploy` just stripped
// the bindings (bare-bindings policy) and the WP plugin's setup wizard
// hasn't re-attached them yet. Without this warning the failure mode is
// silent — edge cache fills normally, R2 stays empty, debugging takes a
// while. Reset per isolate so the warning shows again on each cold start
// after a bad deploy without spamming during steady-state misses.
let warnedMissingPagesBinding = false;

// Two-layer cache. R2 is the source of truth (durable, survives LRU eviction);
// caches.default sits in front of it as a per-colo warm-path accelerator. Read
// order: edge → R2 → SSR. On SSR, write to both.
//
// Why both? R2 reads are ~80–150ms, edge cache reads are ~5ms in the same
// colo. Without the edge layer every cold colo pays the R2 round-trip.
// Without R2 the edge layer is non-durable (LRU evicts under pressure) and
// the previous implementation had no durability story.
//
// Set-Cookie handling: Cloudflare's edge cache refuses any Set-Cookie response.
// Zaraz on the example.com zone injects cfz_*/cfzs_* cookies into every
// SSR response, so we strip Set-Cookie from the copy we put into the edge
// cache (the visitor still gets the cookies in the original response).
export const onRequest = defineMiddleware(async (ctx, next) => {
	const request = ctx.request;
	const url = new URL(request.url);

	// Profiling mode. Send `x-staticq-prof: 1` and the response reports
	// where its own time went, as Server-Timing plus a compact
	// x-staticq-prof header naming the slowest origin calls.
	//
	// Why this exists: when a page is slow, the cost is almost never in
	// your template - it is in how many times the render asks WordPress
	// for something, and a cold Worker isolate pays every one of those
	// fresh. From outside you see one slow response and nothing else, so
	// tuning becomes guesswork. This turns it into a single curl:
	//
	//   curl -H "x-staticq-prof: 1" https://your-site/some-post/ -D -
	//
	// Read it as: `frontmatter` is the page's own await chain, `stream`
	// is component and layout work (Astro streams, so their awaits run
	// after the frontmatter resolves), and `calls` is the number of
	// origin requests. A high call count is the usual culprit - see the
	// cost traps in AGENTS.md.
	//
	// Safe to leave deployed: it only activates on an explicit request
	// header, so no visitor and no warmup can trigger it. It bypasses
	// BOTH cache layers, because a profiled request must render fresh to
	// mean anything, and must not write what it rendered into R2 (keys
	// are path-only, so it would overwrite the real object).
	if (request.headers.get('x-staticq-prof') === '1') {
		const started = Date.now();
		const calls: Array<{ label: string; ms: number }> = [];
		const originalFetch = globalThis.fetch;
		// Attribution is reliable for one profiled request at a time (the
		// isolate's fetch is global). Fine for a curl; don't read these
		// numbers while a warmup is running.
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const t = Date.now();
			try {
				return await originalFetch(input as RequestInfo, init);
			} finally {
				const raw = typeof input === 'string'
					? input
					: input instanceof URL ? input.href : (input as Request).url;
				let label = raw;
				try {
					const u = new URL(raw);
					label = u.pathname.replace('/wp-json/', '')
						+ (u.searchParams.get('slug') ? `?slug=${u.searchParams.get('slug')}` : '')
						+ (u.searchParams.get('category_id') ? `?cat=${u.searchParams.get('category_id')}` : '');
				} catch {
					/* keep the raw URL */
				}
				calls.push({ label: label.slice(0, 60), ms: Date.now() - t });
			}
		}) as typeof fetch;

		let response: Response;
		let frontmatterMs = 0;
		let html = '';
		try {
			response = await next();
			// next() resolves when the frontmatter is done, NOT when the
			// page has rendered: Astro streams, so component and layout
			// awaits run while the body is consumed. Measuring only here
			// would report a 4s frontmatter for a 57s render.
			frontmatterMs = Date.now() - started;
			html = await response.text();
		} finally {
			globalThis.fetch = originalFetch;
		}

		const total = Date.now() - started;
		const fetchMs = calls.reduce((a, c) => a + c.ms, 0);
		const slowest = [...calls].sort((a, b) => b.ms - a.ms).slice(0, 8);
		const out = new Response(html, response);
		out.headers.set(
			'Server-Timing',
			[
				`frontmatter;dur=${frontmatterMs}`,
				`stream;desc="template + layout";dur=${Math.max(0, total - frontmatterMs)}`,
				`total;dur=${total}`,
				`origin;desc="${calls.length} calls";dur=${fetchMs}`,
			].join(', '),
		);
		out.headers.set(
			'x-staticq-prof',
			`total=${total}ms frontmatter=${frontmatterMs}ms stream=${total - frontmatterMs}ms `
			+ `calls=${calls.length} originSum=${fetchMs}ms | `
			+ slowest.map((c) => `${c.label}=${c.ms}ms`).join(' | '),
		);
		out.headers.set('Cache-Control', 'no-store');
		out.headers.set('x-staticq-cache', 'PROF-NO-CACHE');
		return out;
	}

	// Preview host: the workers.dev URL used to review the site before going
	// live. It runs on the PRODUCTION worker (same script), so IS_STAGING is
	// false — but we must NOT read or write the edge/R2 cache for it. Preview
	// renders would poison the real domain's cache (both layers key on path
	// only, not host), and workers.dev can't be selectively purged (only a
	// full-zone purge would clear it). So treat it like staging: fresh SSR
	// every request, no cache read, no cache write, nothing to purge.
	const isPreviewHost = url.hostname.endsWith('.workers.dev');

	// Reverse-proxy passthrough. When this Worker runs on a route in front of
	// the WordPress origin, the paths WordPress must own (admin, login, REST,
	// cron, wp-content, feeds, sitemaps) and every write are forwarded to
	// origin; Astro renders everything else. Runs before the visitor gate and
	// the cache lookups so admin/login are always reachable and dynamic WP
	// responses never get cached.
	if (shouldPassThrough(request, url)) {
		return passThroughToOrigin(request);
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return next();
	}

	// Visitor gate. Runs before the cache lookup so an authorized hit can't
	// be served to an unauthorized request — cache.match keys on URL only and
	// would otherwise leak the cached HTML. The 403 is no-store so it's never
	// cached itself. Static assets (favicon, /_astro/*) bypass middleware
	// entirely (Cloudflare's ASSETS handler runs first), so the gate covers
	// pages but doesn't break loading of CSS/JS.
	if (SITE_GATE_COOKIE) {
		const cookieHeader = request.headers.get('cookie') ?? '';
		if (!cookieHeader.includes(SITE_GATE_COOKIE)) {
			return new Response('Forbidden', {
				status: 403,
				headers: {
					'Content-Type': 'text/plain;charset=utf-8',
					'Cache-Control': 'no-store',
					'x-staticq-gate': 'denied',
				},
			});
		}
	}

	const execCtx = (ctx.locals as { cfContext?: ExecutionContext }).cfContext;
	const pages = (workersEnv as BoundEnv).PAGES;

	// Reject any path ending in .html (case-insensitive). Astro's server-mode
	// router treats /foo and /foo.html as the same route, so without this
	// guard every post page is reachable under two URLs — bad for SEO
	// (duplicate content), bad for the cache (double R2 + edge entries per
	// post), and an attack surface for cache-busting via .html spam.
	// Runs before the cache lookup so .html variants never get stored.
	if (url.pathname.toLowerCase().endsWith('.html')) {
		return next('/404');
	}

	// No-cache early-exit. Two cases act as if no cache layers exist — a
	// Worker flagged IS_STAGING and any request on the workers.dev
	// PREVIEW host: every request renders fresh from SSR, with cache-control:
	// no-store so no intermediary caches it either. Skips the cache.match / R2
	// lookups AND the cache.put / R2 writeback entirely, so preview/staging
	// never read from or write to either layer (and there is nothing to purge
	// afterward). Placed BEFORE the cache lookups. The production worker on its
	// real domain never takes this branch, whatever SITE_INDEXABLE says —
	// indexability and caching are independent.
	// Local dev joins this branch too: wrangler's platform proxy persists
	// caches.default to .wrangler/state on disk, so without this bypass a
	// stale page (e.g. one rendered before .env was configured) survives
	// dev-server restarts and env changes.
	const isDev = import.meta.env.DEV;
	if (IS_STAGING || isPreviewHost || isDev) {
		const response = await next();
		if (response.status !== 200) return response;
		const contentType = response.headers.get('Content-Type') ?? '';
		if (!contentType.startsWith('text/html')) return response;

		const baseHeaders = new Headers(response.headers);
		baseHeaders.set('Cache-Control', STAGING_NO_CACHE);
		baseHeaders.set('x-staticq-cache', `${isDev ? 'DEV' : IS_STAGING ? 'STAGING' : 'PREVIEW'}-NO-CACHE`);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: baseHeaders,
		});
	}

	// Search results: bypass both cache layers and stream straight from
	// SSR. The cache key strips the query string (see below), so caching
	// a single `?s=foo` response would poison every subsequent `?s=bar`
	// query with the foo results. Cheaper to re-render per request than
	// to plumb the query string through the cache key for a low-traffic
	// route that's expensive to invalidate. Covers `/search/`,
	// `/search/anything/`, and the root-level `/?s=...` form before its
	// 301 redirect to `/search/` fires.
	if (url.pathname === '/search/' || url.pathname === '/search' ||
		url.pathname.startsWith('/search/') || url.searchParams.has('s')) {
		const response = await next();
		response.headers.set('Cache-Control', 'no-store');
		response.headers.set('x-staticq-cache', 'BYPASS');
		return response;
	}

	const cacheUrl = new URL(url);
	cacheUrl.search = '';
	const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
	const cache = (caches as unknown as { default: Cache }).default;
	const r2Key = pathToKey(url.pathname);

	const edgeHit = await cache.match(cacheKey);
	if (edgeHit) {
		const hit = new Response(edgeHit.body, edgeHit);
		hit.headers.set('x-staticq-cache', 'EDGE-HIT');
		return hit;
	}

	if (pages) {
		const r2Object = await pages.get(r2Key);
		if (r2Object) {
			const contentType = r2Object.httpMetadata?.contentType ?? 'text/html;charset=utf-8';
			const headers = new Headers({
				'Content-Type': contentType,
				'Cache-Control': LONG_EDGE_CACHE,
				'x-staticq-cache': 'R2-HIT',
			});
			const response = new Response(r2Object.body, { status: 200, headers });
			// Backfill the edge cache so subsequent hits in this colo skip R2.
			if (execCtx) {
				execCtx.waitUntil(cache.put(cacheKey, response.clone()));
			}
			return response;
		}
	}

	const response = await next();
	if (response.status !== 200) return response;
	const contentType = response.headers.get('Content-Type') ?? '';
	if (!contentType.startsWith('text/html')) return response;

	// Buffer the body once, then serve everything (visitor + edge + R2)
	// from the same string. The previous clone-then-text() pattern raced
	// against the client consuming the original response — for streamed
	// (Transfer-Encoding: chunked) responses with larger bodies, the R2
	// clone's text() would intermittently resolve to an empty body or
	// reject silently, and Promise.allSettled would swallow the failure
	// so the visitor still got their HTML but R2 stayed empty. Buffering
	// up-front kills the race entirely.
	const buffered = await response.text();

	// TTL-block detection (dynamic blocks, a.k.a. "Ajax blocks"). If
	// the Astro template set `Cache-Control: s-maxage=<n>` on its
	// response, treat this URL as a time-expiring block — store ONLY in
	// the edge cache with the page's own TTL, skip R2 entirely. The
	// contract: page declares its own freshness budget, middleware
	// honors it. Used for "latest"-style blocks that should refresh on
	// a clock rather than via WP invalidation.
	//
	// Why edge-only: R2 has no native TTL; modeling per-object expiry
	// there means writing eviction logic and read-time staleness
	// checks. caches.default expires entries automatically when their
	// stored Cache-Control's s-maxage elapses, which is exactly the
	// behavior these blocks want.
	//
	// Why not also write to R2 with a long TTL: defeats the purpose.
	// R2 hits would serve stale content past the edge TTL window.
	const ttlMatch = (response.headers.get('Cache-Control') ?? '').match(/s-maxage\s*=\s*(\d+)/);
	const blockTtl = ttlMatch ? parseInt(ttlMatch[1], 10) : 0;

	const baseHeaders = new Headers(response.headers);
	if (!baseHeaders.has('Cache-Control')) {
		baseHeaders.set('Cache-Control', LONG_EDGE_CACHE);
	}
	baseHeaders.set('x-staticq-cache', blockTtl > 0 ? 'TTL-MISS' : 'MISS');
	if (blockTtl > 0) {
		baseHeaders.set('x-staticq-ttl', String(blockTtl));
	}

	const finalResponse = new Response(buffered, {
		status: response.status,
		statusText: response.statusText,
		headers: baseHeaders,
	});

	if (execCtx) {
		// Edge copy strips Set-Cookie since Cloudflare's edge cache refuses
		// any response carrying it (Zaraz injects cfz_*/cfzs_*). The visitor
		// keeps the cookies on `finalResponse`; only the cached copy loses
		// them. R2 doesn't care either way.
		const edgeHeaders = new Headers(baseHeaders);
		edgeHeaders.delete('Set-Cookie');
		const edgeCopy = new Response(buffered, {
			status: response.status,
			statusText: response.statusText,
			headers: edgeHeaders,
		});

		execCtx.waitUntil(
			(async () => {
				const tasks: Promise<unknown>[] = [];
				tasks.push(
					cache.put(cacheKey, edgeCopy).catch((err) => {
						// Per-task catch so one failure doesn't kill the other
						// write, AND so the failure actually surfaces in Worker
						// logs (Promise.allSettled would have hidden it).
						console.error(
							'[staticq] edge cache put failed',
							r2Key,
							err instanceof Error ? err.message : err,
						);
					}),
				);
				// TTL blocks skip R2 entirely — see the comment block at the
				// blockTtl detection above. Edge cache handles their lifetime.
				if (blockTtl === 0 && pages) {
					tasks.push(
						pages.put(r2Key, buffered, {
							httpMetadata: { contentType },
							customMetadata: { cachedAt: new Date().toISOString() },
							// expirationTtl is set on the bucket level via lifecycle
							// rules in production. The receiver's purge-on-edit is
							// the primary invalidation path.
						}).catch((err) => {
							console.error(
								'[staticq] R2 put failed',
								r2Key,
								err instanceof Error ? err.message : err,
							);
						}),
					);
				} else if (blockTtl === 0 && !pages && !warnedMissingPagesBinding) {
					warnedMissingPagesBinding = true;
					console.warn(
						'[staticq] R2 PAGES binding missing — re-run the WP plugin setup wizard to re-attach it. Edge cache still working, R2 writes are no-ops until bound.',
					);
				}
				await Promise.all(tasks);
			})(),
		);
	}

	return finalResponse;
});
