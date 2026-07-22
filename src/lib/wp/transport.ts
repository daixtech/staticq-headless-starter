import { assertBaseUrl, WP_FETCH_COOKIE } from './env';

// Cloudflare Bot Fight Mode and WordFence both block requests with
// empty/Workers-default UAs and bot-pattern UAs. Browser UA passes both.
// Switch to a project-identifying UA once the origin firewall is loosened.
const WP_USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Shared request headers for every WP call — the browser-shaped User-Agent,
// a JSON Accept, and the optional shared-secret cookie that lets Worker
// traffic through the WP-side WAF. Centralized here so the ~8 fetch sites
// (wpFetchRaw + each staticq/v1 bundle endpoint + seo-head) stay in sync.
export function wpBundleHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		'User-Agent': WP_USER_AGENT,
		Accept: 'application/json',
	};
	if (WP_FETCH_COOKIE) headers.Cookie = WP_FETCH_COOKIE;
	return headers;
}

// In-flight deduplication: when a single SSR request (or a build-time call)
// fires the same URL concurrently, the second caller awaits the first instead
// of issuing a duplicate fetch. The entry is removed in the finally block so
// resolved responses never linger — that would be a per-isolate cache with no
// invalidation, and would make Mode A purges invisible to the SSR layer.
const inflight = new Map<string, Promise<{ data: unknown; totalPages: number }>>();

interface WpFetchResult<T> {
	data: T;
	totalPages: number;
	total: number;
}

export async function wpFetchRaw<T>(path: string): Promise<WpFetchResult<T>> {
	const base = assertBaseUrl();
	const url = `${base}/wp-json/wp/v2/${path}`;
	const existing = inflight.get(url) as Promise<WpFetchResult<T>> | undefined;
	if (existing) return existing;
	const p = (async () => {
		try {
			const res = await fetch(url, { headers: wpBundleHeaders() });
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				const snippet = body.replace(/\s+/g, ' ').slice(0, 400);
				throw new Error(`WP request failed: ${res.status} ${res.statusText} (${url}) :: ${snippet}`);
			}
			const totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1') || 1;
			const total = Number(res.headers.get('x-wp-total') ?? '0') || 0;
			const data = (await res.json()) as T;
			return { data, totalPages, total };
		} finally {
			inflight.delete(url);
		}
	})();
	inflight.set(url, p);
	return p;
}

export async function wpFetch<T>(path: string): Promise<T> {
	return (await wpFetchRaw<T>(path)).data;
}

// Runs `fn` over `items` with at most `limit` concurrent in-flight calls.
// Used to throttle bulk paginated WP fetches so a 36-page archive doesn't
// fire 36 concurrent _embed=1 requests at the origin.
async function pMapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const idx = cursor++;
			results[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
}

// Fetches every page of a list endpoint using the X-WP-TotalPages header from
// page 1, with a concurrency cap so we don't slam the origin. If a page fetch
// fails we log and treat it as empty rather than poisoning the whole build —
// missing 50 of 3500 posts is far better than a cliff. Pass a path WITHOUT a
// `page=` param.
export async function wpFetchAllPaged<T>(
	pathWithoutPage: string,
	concurrency = 4,
): Promise<T[]> {
	if (/[?&]page=/.test(pathWithoutPage)) {
		throw new Error(`wpFetchAllPaged: pass a path without page=, got ${pathWithoutPage}`);
	}
	const sep = pathWithoutPage.includes('?') ? '&' : '?';
	const first = await wpFetchRaw<T[]>(pathWithoutPage);
	if (first.totalPages <= 1) return first.data;
	const restPages = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 2);
	const restResults = await pMapLimit(restPages, concurrency, async (n) => {
		try {
			return await wpFetch<T[]>(`${pathWithoutPage}${sep}page=${n}`);
		} catch (err) {
			console.warn(`[wp] page ${n} of ${pathWithoutPage} failed, skipping:`, err instanceof Error ? err.message : err);
			return [] as T[];
		}
	});
	return first.data.concat(...restResults);
}
