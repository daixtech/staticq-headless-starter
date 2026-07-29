# Agent guide - StaticQ headless Astro frontend

You are working in a **StaticQ Headless** frontend: an Astro site, deployed
as a Cloudflare Worker, that renders content it fetches from a WordPress
site's REST API. WordPress stays the single source of truth for content;
this repo owns only templates, routes, and data fetching. The human you're
helping may not know Astro, Cloudflare, or this architecture - when you
propose changes, also tell them how to **verify** the result using the
WordPress admin tools listed at the bottom, not by reading code.

Read this whole file before adding or changing routes, data fetching,
caching, or the deploy pipeline. The system has a strict caching contract;
code that ignores it fails **silently** (pages go stale - no errors).

## System topology

```
WordPress + StaticQ Headless plugin        (content, config, cache events)
   │ REST: /wp-json/wp/v2/* and /wp-json/staticq/v1/*
   ▼
THIS REPO → GitHub Actions → Astro frontend Worker   (renders pages)
                                  │ writes/reads
                                  ▼
                    Two cache layers: CF edge cache + R2 bucket ("PAGES")
                                  ▲ deletes/purges/re-renders
   WP plugin ──signed events──▶ Receiver Worker      (cache refresher)
```

Two Cloudflare Workers, different jobs, same account:

- **Astro frontend Worker** (this repo; deployed by `.github/workflows/deploy.yml`
  on push to `main`): serves every page. On each request the middleware tries
  the CF **edge cache**, then the **R2** bucket, then renders (SSR) and
  writes the result back to both.
- **Receiver Worker** (deployed and owned by the WP plugin - not in this
  repo): receives signed "these URLs changed" events from WordPress and
  refreshes the caches. Two modes: **invalidate** (delete the R2 object,
  then purge the edge - in that order, to avoid a stale-R2 backfill race)
  and **refresh** (same, then immediately re-fetch the URL through the
  frontend so the caches refill without a visitor paying the SSR cost).

**Consequence that drives everything below:** a rendered page is cached
until an event, a manual refresh, or a warmup replaces it (edge s-maxage is
1 year; R2 is durable). Content edits refresh their own URLs automatically.
Anything else - new pages, template changes - needs explicit refresh wiring
or it goes stale forever.

## The caching contract - files you must not casually change

- `src/middleware.ts` - the edge→R2→SSR read path and both write-backs.
  Invariants it enforces (do not break, do not work around):
  - Only **HTTP 200 `text/html`** responses are cached. Non-200s and
    non-HTML pass through uncached.
  - The cache key is the URL **with the query string stripped**. Cached
    pages must never vary on query params (that's why `/search/` and `?s=`
    bypass caching entirely).
  - Paths ending in `.html` are rejected (duplicate-content guard).
  - A response with `Cache-Control: s-maxage=N` becomes a **TTL block**:
    edge-cached for N seconds, never written to R2. This is the sanctioned
    escape hatch for clock-based freshness (see recipes).
  - `*.workers.dev` (preview) and staging never read or write the caches.
- `src/lib/cache-key.ts` - `pathToKey()` must stay byte-identical to the
  receiver Worker's copy; they address the same R2 objects.
- `src/lib/wp/pagination.ts` - **slot-stable pagination**. `SEAL_SIZE`,
  `LIVE_MIN`, `LIVE_MAX` and `computeArchiveLayout()` mirror math inside
  the WordPress plugin's cache-invalidation engine. Changing them here
  desynchronizes which archive pages WP thinks an edit affects. Never
  change the constants, the ordering, or page-size logic. Archive pages:
  the live page (`/category/x/`) holds the newest 10–19 posts; sealed
  pages (`/page/N/`) hold exactly 10 posts each in fixed chronological
  slots that never shift once written.
- `.github/workflows/deploy.yml` + `scripts/inject-live-bindings.mjs` -
  the deploy re-reads the live Worker's bindings and deploys with
  `--keep-vars`, because the WP plugin owns bindings/vars/secrets and
  pushes them via the CF API. Never hardcode bindings, vars, or secrets in
  wrangler config in this repo; never remove the inject step or
  `--keep-vars`.

## URL families (the shapes both sides agree on)

The WP plugin's cache-invalidation engine emits exactly these URL shapes;
this repo must serve real HTML at exactly these URLs. Both sides are
configured from the plugin's **URL families** settings.

| Family | URL shape | Route file |
|---|---|---|
| Post/page permalink | `/<slug>/` | `src/pages/[slug].astro` |
| Homepage live | `/` | `src/pages/index.astro` |
| Homepage sealed | `/page/<n>/` | `src/pages/page/` |
| Category live | `/category/<path>/` (nested paths allowed) | `src/pages/category/` |
| Category sealed | `/category/<path>/page/<n>/` | `src/pages/category/` |
| Tag live / sealed | `/tag/<slug>/`, `/tag/<slug>/page/<n>/` | `src/pages/tag/` |
| Author live / sealed | `/author/<slug>/`, `…/page/<n>/` | `src/pages/author/` |
| Search (never cached) | `/search/` | `src/pages/search.astro` |

Reserved paths - never create routes for these; the middleware's
passthrough proxy forwards them to WordPress: `/wp-admin/`, `/wp-json/`,
`/wp-content/`, `/wp-includes/`, `/wp-login.php`, `/.well-known/`, feeds
(`…/feed/`), and sitemap XML files. Custom public taxonomies repeat the
category pattern at `/<taxonomy>/<slug>/…`.

## Data layer (`src/lib/wp/`)

Barrel: `src/lib/wp.ts`. One concern per module - keep it that way when
adding fetchers:

- `env.ts` - `WP_BASE_URL`, `WP_FETCH_COOKIE` (WAF bypass cookie).
- `transport.ts` - fetch headers, in-flight dedup, paging.
- `rest.ts` - standard `/wp-json/wp/v2/*` reads.
- `bundles.ts` - one-shot `/wp-json/staticq/v1/*` bundle endpoints served
  by the plugin (prefer these; they exist to avoid N+1 REST calls):
  `site-config` (brand/logo/nav/indexable), `homepage`, `single?slug=`,
  `archive?…` (slot-stable pages), `sitemap`, author bundle.
- `pagination.ts` - see contract above. `archive.ts` - slot-stable
  fetchers + search. `seo.ts` - SEO-plugin `<head>` fragments.
  `images.ts`, `display.ts`, `hero.ts` - presentation helpers.

Config reaches the code three ways (the "bridge"): local dev reads `.env`;
CI builds read GitHub Variables; the live Worker reads **runtime bindings
pushed by the plugin, which take precedence** - so settings changed in WP
admin apply without a rebuild. Always read config via `lib/runtime-env.ts`
/ `lib/site.ts` patterns, never `process.env` directly.

## The refresh system (what keeps pages fresh)

1. An editorial event in WP (publish/update/unpublish) → the plugin's
   **URL-impact engine** computes the exact affected URLs (permalink, home
   + affected sealed pages, each term archive, author, feed, sitemap) →
   signed POST to the receiver → caches replaced. Automatic; no work here.
2. **WP-side hooks** extend that mapping. This is PHP living in WordPress -
   offer the user a snippet for **their own mu-plugin**
   (`wp-content/mu-plugins/`), never code in this repo and **never an edit
   to the StaticQ plugin's own files** (plugin updates replace those
   wholesale; the plugin stays stock - only this repo and the user's own
   WP-side files are customized):
   - `sqheadless/object_urls` - add/remove URLs for one affected object.
   - `sqheadless/affected_objects` - add custom associations.
   - `sqheadless/static_archive_urls` - add site-static URLs (custom pages)
     to **warmup enumeration** (warmup-only; not refreshed on edits).
   - `sqheadless/impact_urls` - wholesale final override.
3. **Manual tools** (WP admin → StaticQ Headless → Settings → Cache tab):
   Refresh simulator (dry-run: which URLs would an edit refresh), Single
   URL refresh (purge + re-render one URL now), Warmup (enumerate every
   URL and re-render the whole site in paced batches - the right rollout
   after template changes; the URL list is downloadable as CSV/JSON).

## Content belongs in WordPress, not in templates

This is a headless WordPress site: WP is the single source of truth for
content, and templates are generic renderers. The classic long-term
failure mode of WP sites is content baked into code - every hardcoded
headline, curated list, banner, or link turns a future content edit into
a developer task (edit template → deploy → refresh caches) instead of a
WP-admin edit that publishes and refreshes itself. In this system it's
doubly wrong: WP-backed content flows through per-URL cache invalidation
automatically; hardcoded content only updates via deploy + manual refresh.

When a request includes literal content (text, links, lists of posts,
images, anything that will plausibly change), route it:

| The content is… | Put it in… | Rendered via… |
|---|---|---|
| Editorial copy, page sections | a WP page or post (blocks) | the existing single/page route |
| A curated or automatic list of posts | a category or tag assignment | taxonomy queries (`lib/wp`) |
| Brand text, navigation, footer links | site-config (WP options / `staticq_site_config` filter) | `getSiteConfig()` |
| A UI label tied to code behavior ("Read more", aria text) | the template | hardcoding is correct here |

Default behavior: when a request would bake changeable content into a
template, implement the WP-backed version - or at minimum offer it and
state the tradeoff in one sentence: *"hardcoded = you need me + a deploy +
a cache refresh every time this changes; WP-backed = you edit it in WP
admin and it refreshes itself."* Users usually don't know they're making
this choice; surfacing it is part of your job.

## Recipes

**Add a content-driven page (e.g. `/deals/` listing a category):**
1. Create the route under `src/pages/`, fetching via existing `lib/wp`
   helpers (or a new single-concern module).
2. Decide freshness and say so explicitly:
   - Needs refresh on relevant edits → give the user a PHP snippet using
     `sqheadless/object_urls` (see the plugin's `docs/HOOKS.md` and
     tutorial 08) and tell them to verify with the **Refresh simulator**.
   - Time-based is enough → return `Cache-Control: s-maxage=<seconds>` and
     it becomes an edge-only TTL block. No WP wiring needed.
   - Truly static → have the user add the URL via
     `sqheadless/static_archive_urls` so warmup covers it.
   A page with none of these renders once and is then frozen until a
   manual refresh. Never ship that silently.
3. Never invent a URL shape that collides with the families table or the
   reserved paths.

**Add a data endpoint:** prefer an existing `staticq/v1` bundle. If WP
needs to expose something new, give the user PHP for **their own
mu-plugin** - never an edit to the StaticQ plugin - registering a route
under **their own REST namespace** (e.g. `mysite/v1`; `staticq/v1` belongs
to the plugin and future updates could collide). Batched - one request per
page render, not N+1 - plus a typed fetcher module here re-exported from
`lib/wp.ts`.

**Template/style changes:** any page already cached keeps the old HTML
until refreshed. After the deploy goes green, tell the user to verify on
the `*.workers.dev` preview URL (always uncached), then run **Warmup**
(site-wide) or **Single URL refresh** (a few pages) from WP admin.

**Do not:** suggest editing the StaticQ WordPress plugin's files, ever -
all WP-side custom code goes in the user's own mu-plugin, under their own
REST namespace · bake changeable content (copy, curated lists, links,
images) into templates without offering the WP-backed alternative · emit
`Set-Cookie` from pages (the edge copy strips it;
per-user state doesn't belong in cached HTML) · vary cached content on
query strings · cache non-200s · rename/move route files without keeping
the URL family shape · touch `WORKER_ENV` semantics (production = caches
on; staging/preview = caches off).

## Deploys

`git push origin main` **is** the deploy (GitHub Actions → build →
inject live bindings → `wrangler deploy --keep-vars`). There is no other
publish step. The first-ever deploy may find a Worker already bootstrapped
by the plugin (a 503 stub with bindings attached) - that's expected; the
build replaces the stub and the bindings survive.

**Failed deploys are safe**: if any workflow step fails (usually the
build), `wrangler deploy` never runs and the live Worker keeps serving the
last good version - a red run means "nothing changed", never "site down".
Recovery is fix-forward (ask the user for the failing step's log from
GitHub → Actions and diagnose from it) or `git revert` + push to return to
the known-good baseline - prefer the revert when the fix isn't quickly
convincing, rather than iterating "one more fix" commits on a broken
`main`. Never attempt to repair a failed deploy through the Cloudflare
console or by editing build output.

## Verification playbook (give these to the user - no code reading needed)

- **`https://<worker>.workers.dev`** - always renders fresh, both cache
  layers bypassed. The place to confirm a deploy before refreshing caches.
- **`x-staticq-cache` response header** on the live domain: `EDGE-HIT` /
  `R2-HIT` = cached copy, `MISS` = just rendered, `TTL-MISS` = TTL block,
  `BYPASS` = search.
- **Refresh simulator** (WP admin → StaticQ → Settings → Cache): dry-runs
  an edit and lists the exact URLs that would refresh - the way to prove
  freshness wiring works before trusting it.
- **Single URL refresh**: instant purge + re-render of one URL while
  iterating. **Warmup**: paced site-wide re-render with progress, a
  downloadable URL list (CSV/JSON), and a per-URL outcome log.
