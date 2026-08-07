// Serves build assets that a later deploy removed, from R2.
//
// THE PROBLEM
// -----------
// Assets are content-hashed (Base.<hash>.css), which is what makes the
// adapter's `immutable, max-age=31536000` on /_astro/* safe. But a Worker
// deploy replaces the static-asset manifest wholesale: an asset whose
// content changed ships under a NEW hash and the old name stops being
// served. Rendered HTML, meanwhile, lives in R2 and the edge cache and is
// untouched by the deploy - so every page cached before that deploy goes on
// requesting the old name and gets a 404.
//
// One stylesheet is on every page, so a single design change strips the CSS
// from the whole cached site until each page has been re-rendered. On a
// large archive that means a full warmup per deploy. Observed live.
//
// THE FIX
// -------
// Keep the hashes, and keep every asset ever deployed reachable. Each deploy
// uploads its own /_astro/ output to R2 under the `assets` prefix
// (scripts/archive-assets.mjs, run before `wrangler deploy`), and this module
// serves from that archive when the live manifest no longer has the file.
// Cached HTML keeps resolving against the exact build it was rendered with,
// so HTML and CSS never come from different builds.
//
// This is the retention model Rails' assets:clean and Django's
// ManifestStaticFilesStorage use, adapted to a platform that has no notion of
// keeping previous builds around.
//
// WHY THIS RUNS AT ALL
// --------------------
// Cloudflare's ASSETS handler answers first and never reaches the Worker for
// a file the current build still has - so this costs nothing on the hot path.
// A MISS is what falls through to the Worker script, which is where the
// middleware calls us. Verified against production: a request for a
// nonexistent /_astro/ path is answered by Astro's own 404 page, proving the
// Worker sees it.
//
// Storage lives in the same bucket as rendered pages but under a separate
// key prefix. Nothing enumerates or bulk-deletes that bucket - the receiver
// only ever deletes explicit `pages<path>` keys - so page purges, per-URL
// invalidation and full warmups all leave the archive intact.

// Mirrors the `pages` prefix the page cache uses (see lib/cache-key.ts and
// the receiver's r2-delete.ts). Key = `assets` + pathname, so
// /_astro/Base.abc123.css -> assets/_astro/Base.abc123.css
const KEY_PREFIX = 'assets';

// Only paths under here are archived and served from the archive. Astro emits
// every hashed build artifact under /_astro/ (build.assets default).
export const ASSET_PATH_PREFIX = '/_astro/';

export function assetPathToKey(pathname: string): string {
	return `${KEY_PREFIX}${pathname}`;
}

export function isArchivableAssetPath(pathname: string): boolean {
	// Reject traversal and nested oddities outright: the archive is a flat
	// mirror of one build directory, and a key is derived straight from the
	// pathname, so anything that isn't a plain /_astro/<file> is not ours.
	return (
		pathname.startsWith(ASSET_PATH_PREFIX) &&
		!pathname.includes('..') &&
		pathname.indexOf('/', ASSET_PATH_PREFIX.length) === -1
	);
}

/**
 * Look the path up in the archive.
 *
 * Returns null when the bucket is unbound (local dev, or a Worker whose
 * bindings the wizard has not attached yet) or the object is absent - the
 * caller then continues to normal routing, which ends in Astro's 404. That
 * is the pre-archive behaviour, so a missing archive degrades to exactly
 * what happened before rather than breaking the request.
 */
export async function serveArchivedAsset(
	pathname: string,
	bucket: R2Bucket | undefined,
): Promise<Response | null> {
	if (!bucket || !isArchivableAssetPath(pathname)) return null;

	let object: R2ObjectBody | null = null;
	try {
		object = await bucket.get(assetPathToKey(pathname));
	} catch {
		// A bucket error must not turn a cosmetic missing-stylesheet into a
		// failed request. Fall through to routing.
		return null;
	}
	if (!object) return null;

	const headers = new Headers();
	// Restores Content-Type (and any other http metadata) captured at upload
	// time, so we don't have to infer a MIME type from the extension here.
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	// Safe precisely because the name is content-hashed: this exact URL can
	// never denote different bytes, whatever build asked for it.
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	// Distinguishes an archive hit from a live-manifest hit when debugging a
	// page that renders unstyled.
	headers.set('x-staticq-asset', 'R2-ARCHIVE');

	return new Response(object.body, { headers });
}
