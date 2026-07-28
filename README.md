# StaticQ Headless: Astro frontend starter

The frontend scaffold for the [StaticQ Headless](https://staticq.io/headless/)
WordPress plugin.

This repository is a **GitHub template**. You normally do not clone it directly.
From **WP Admin → StaticQ Headless → Astro Setup**, the plugin generates your own
copy of it into your GitHub account, then provisions the Cloudflare Worker and R2
bucket and deploys it. The scaffold never gets written to your WordPress server.

It renders your live WordPress content (over the REST API) to a Cloudflare-hosted
Astro site, and the plugin keeps its edge and R2 cache fresh with per-URL
invalidation on every edit.

## Local development

1. Copy `.env.example` to `.env` and set `WP_BASE_URL` to your WordPress origin.
2. `npm install`
3. `npm run dev`, then open http://localhost:4321

The dev server reads your **live** WordPress content, so you can preview changes
before pushing them.

## Deploy

Push to `main`. The bundled GitHub Actions workflow (`.github/workflows/deploy.yml`)
builds the site and deploys it to your Cloudflare Worker.

## Customizing

You can replace the pages and components with your own design and keep using the
same pipeline, as long as your project keeps the caching contract this starter
ships with: the edge/R2 `src/middleware.ts`, the `src/lib/cache-key.ts` module,
and the `src/lib/wp.ts` data client. See the plugin's built-in **Tutorials**
(WP Admin → StaticQ Headless → Tutorials) for the full walkthrough.

## Working with an AI coding agent

This repo ships **[`AGENTS.md`](AGENTS.md)** — a system guide that AI coding
agents (Claude Code, Cursor, and others) read automatically. It explains the
two-Worker topology, the cache layers and refresh system, the URL-family
contract, and which files must not be casually changed, so an agent can make
correct suggestions even when you can't validate the Astro code yourself.
Ask your agent to build what you need, then verify the result with the
WordPress admin tools listed at the end of that file — no code reading
required.
