import { envStr, envNum } from '../runtime-env';
import { decodeEntities } from '../text';

// WordPress returns taxonomy/term names and author display names
// HTML-encoded (e.g. `Pictures &amp; Videos`). We render them as plain
// text (breadcrumbs, nav, kickers), so decode at the data layer — once,
// here — and every consumer gets clean text. Returns a shallow copy so
// shared _embedded objects aren't mutated.
export function withDecodedName<T extends { name: string }>(o: T): T {
	return { ...o, name: decodeEntities(o.name) };
}

// Runtime-first (cloudflare:workers env) with build-time fallback. Lets the
// StaticQ Headless plugin's "Push to Astro Worker" bindings actually drive
// the deployed Worker — no rebuild required when operators change settings.
export const WP_BASE_URL = envStr('WP_BASE_URL');
// Optional shared-secret cookie sent on every WP REST request. The WP-side
// Cloudflare WAF has a Custom Rule that skips bot challenges when this cookie
// is present, so Worker traffic gets through. Format: "name=value".
export const WP_FETCH_COOKIE = envStr('WP_FETCH_COOKIE');

export function assertBaseUrl(): string {
	if (!WP_BASE_URL) {
		throw new Error('WP_BASE_URL is not set. Copy .env.example to .env.');
	}
	return WP_BASE_URL;
}

// Optional safety cap on how many posts to enumerate. Useful for first deploys
// against a large WP archive — set MAX_POSTS=200 to verify the pipeline before
// building the whole site. Empty/0 = no cap.
const MAX_POSTS = envNum('MAX_POSTS', 0);
const MAX_CATEGORIES = envNum('MAX_CATEGORIES', 0);
const MAX_TAGS = envNum('MAX_TAGS', 0);

export function applyPostCap<T>(arr: T[]): T[] {
	return MAX_POSTS > 0 ? arr.slice(0, MAX_POSTS) : arr;
}

export function applyCategoryCap<T>(arr: T[]): T[] {
	return MAX_CATEGORIES > 0 ? arr.slice(0, MAX_CATEGORIES) : arr;
}

export function applyTagCap<T>(arr: T[]): T[] {
	return MAX_TAGS > 0 ? arr.slice(0, MAX_TAGS) : arr;
}
