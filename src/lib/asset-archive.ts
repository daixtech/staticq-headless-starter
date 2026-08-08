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

// Runs of two or more dots are rewritten out of the KEY (not the file).
//
// Rollup derives chunk names from source modules, so `[...rest].astro` emits
// `_..<hash>.css`. The file itself is fine and serves normally - the problem
// is that an R2 object key travels in the URL PATH of the REST API, and
// Cloudflare's own WAF reads `..` there as directory traversal. It answered
// 403 with an HTML block page for exactly that one asset while the other five
// uploaded cleanly; the request never reached R2. The endpoint is
// api.cloudflare.com, so no zone-level allowlist can help, and percent-
// encoding the dots is unreliable because traversal rules normally decode
// before matching.
//
// So the key, not the filename, absorbs it. The transform does NOT need to be
// reversible: the Worker never reconstructs a filename from a key, it just
// derives the same key from the request path. `_..BEd-oB74.css` becomes
// `_._BEd-oB74.css` - one dot kept, the rest as underscores, so length and
// readability survive and a real file would have to be named exactly that to
// collide (content hashes make that implausible).
//
// MUST stay byte-identical to the copy in scripts/archive-assets.mjs. The
// uploader derives keys from local filenames and the Worker derives them from
// request paths; if the two ever disagree, every archived asset silently
// misses and the archive looks empty while being full.
const DOT_RUN = /\.{2,}/g;

function sanitizeKeySegment(value: string): string {
	return value.replace(DOT_RUN, (run) => `.${'_'.repeat(run.length - 1)}`);
}

export function assetPathToKey(pathname: string): string {
	return `${KEY_PREFIX}${sanitizeKeySegment(pathname)}`;
}

export function isArchivableAssetPath(pathname: string): boolean {
	if (!pathname.startsWith(ASSET_PATH_PREFIX)) return false;
	const name = pathname.slice(ASSET_PATH_PREFIX.length);

	// One flat filename and nothing else. THIS is what makes traversal
	// impossible - with no separator there is no path to escape from - and
	// it is the only check that needs to do that job. R2 keys are opaque
	// strings; bucket.get() resolves no paths, so dots inside a NAME are
	// inert.
	//
	// Do not "harden" this by also scanning for '..' as a substring. That
	// was the original guard and it was wrong: Astro derives chunk names
	// from route filenames, so `[...rest].astro` emits `_..<hash>.css`.
	// The scan refused to serve exactly that file - the stylesheet for the
	// entire nested-page family, the widest surface on the site - while
	// looking like a sensible security check.
	if (name === '' || name.includes('/')) return false;

	// Belt and braces for the two names that would denote a directory if
	// anything downstream ever did resolve paths. Neither is a filename
	// Astro can emit, so this rejects nothing real.
	return name !== '.' && name !== '..';
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
