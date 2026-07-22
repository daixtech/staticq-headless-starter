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
});
