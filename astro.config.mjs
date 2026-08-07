// @ts-check
import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Server-rendered on Cloudflare Pages Functions. Pages render on demand from
// WP and the rendered HTML is cached at the edge with a long TTL —
// invalidation is driven by the WP plugin's per-URL purge hook (Mode A).
// No build-time path enumeration, so a 7K-route archive builds in seconds.
//
// Bindings policy
// ---------------
// Bindings (R2, KV, Workers AI, Images, etc.) are owned by the WP
// plugin's setup wizard, which attaches them to the live Worker via the
// Cloudflare API and exposes them as editable settings in the WP admin
// UI. Their values are NOT committed in this repo and NOT stored in
// GitHub secrets.
//
// To keep them across deploys, `scripts/inject-live-bindings.mjs` runs
// in CI between `astro build` and `wrangler deploy`: it fetches the
// live Worker's current binding list from CF and writes it into the
// generated dist/server/wrangler.json, so the deploy re-applies the
// same set rather than wiping it. Plaintext vars and secrets are kept
// via `wrangler deploy --keep-vars`.
//
// Two adapter options stay set to keep the adapter from auto-injecting
// bindings we don't want:
//   - `imageService: 'compile'` makes the adapter skip the IMAGES binding
//     (images are compile-time only; we don't use Astro's <Image>).
//   - `session.driver: sessionDrivers.lruCache()` satisfies the adapter's
//     `if (!session?.driver)` check so it doesn't auto-inject SESSION KV.
//     We never call Astro.session anywhere; LRU is an in-memory no-op.
//
// Middleware reads `env.PAGES` defensively — when the binding is absent
// (e.g. local dev without an R2 backend), the cache layer falls back to
// caches.default only and logs a one-time warning.
export default defineConfig({
	output: 'server',
	adapter: cloudflare({
		platformProxy: { enabled: true },
		imageService: 'compile',
	}),
	session: {
		driver: sessionDrivers.lruCache(),
	},
	// Stable stylesheet filenames - no content hash. See the note below.
	vite: {
		build: {
			rollupOptions: {
				output: {
					assetFileNames: '_astro/[name][extname]',
				},
			},
		},
	},
});

// WHY ASSETS ARE NOT CONTENT-HASHED
// ---------------------------------
// Rendered HTML lives in R2 and the edge cache for a long time, and a Worker
// deploy does not touch it. What a deploy DOES replace, wholesale, is the
// static-asset manifest: a file whose content changed is uploaded under a new
// hashed name and the OLD name stops being served. Cached pages go on
// referencing the old name and get a 404 for it.
//
// With a per-page stylesheet that only breaks that page. Base.css is on every
// page, so a single design tweak strips the CSS from the entire cached site
// until every page has been re-rendered - which on a large archive means a
// full warmup run per deploy. The deploy reports success and the assets are
// correct; only visitors on cached pages see it. Observed live on a cutover.
//
// Stable names decouple the two: cached HTML keeps resolving, and simply
// picks up the current CSS. Cache-busting moves from the filename to
// revalidation, which is already in place - /_astro/* is served with a short
// max-age plus an ETag, so a changed file is refetched within minutes rather
// than being pinned by an immutable year-long TTL.
//
// TWO THINGS TO KNOW BEFORE CHANGING THIS
//
// 1. Basenames must stay unique. Without a hash, two source stylesheets with
//    the same basename collide, and Rollup disambiguates with a numeric
//    suffix that can move between builds - reintroducing the same bug with a
//    harder-to-spot cause.
//
// 2. This covers CSS (and fonts/images); JS chunks keep their hashes, set by
//    chunkFileNames/entryFileNames. That is deliberate. Stale HTML pulling a
//    newer JS chunk can hit a changed module graph, which fails at runtime -
//    worse than the missing-file case. This starter ships no client JS, so
//    the exposure is nil today. If you add hydrated islands, a deploy that
//    changes their chunks will break them on already-cached pages, and the
//    fix there is to purge and re-warm on deploy, not to unhash the JS.
