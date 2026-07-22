// Fetches the current binding list from the live Worker on Cloudflare
// and injects it into dist/server/wrangler.json so the subsequent
// `wrangler deploy` re-applies the same set instead of wiping it.
//
// Why: the StaticQ Headless WP plugin's setup wizard owns the binding
// lifecycle (R2, KV, Workers AI, Images, etc.) and pushes them to the
// live Worker via the Cloudflare API. This repo stays binding-agnostic —
// no bucket names, namespace IDs, or other account-specific values land
// in source or in GitHub secrets. The adapter-generated wrangler.json has
// NO bindings, so a plain `wrangler deploy` would treat that empty set as
// authoritative and delete the plugin's bindings. This script discovers
// what the live Worker currently has and mirrors it back into the
// wrangler.json before deploy, so the set survives.
//
// Companion to `wrangler deploy --keep-vars`: --keep-vars preserves the
// plain-text vars + secrets (WP_BASE_URL, etc.); THIS preserves the
// structural bindings (R2/KV/AI/...) that --keep-vars does not cover.
//
// Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env, plus
// WORKER_NAME (the actual deployed script name — the deploy overrides the
// adapter's default via `--name`, so we can't rely on wrangler.json's
// `name`). On the first deploy of a brand-new Worker the GET 404s: the
// script no-ops, the deploy ships bare, and the wizard does its one-time
// initial attach. Every subsequent push self-heals.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const target = resolve('dist/server/wrangler.json');

if (!existsSync(target)) {
	console.error(`[inject-bindings] missing ${target} — was 'astro build' run first?`);
	process.exit(1);
}

const cfg = JSON.parse(readFileSync(target, 'utf8'));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
// The deploy runs `wrangler deploy --name <WORKER_NAME>` to override the
// adapter's default script name, so the LIVE Worker is WORKER_NAME (or
// <WORKER_NAME>-staging on the staging pipeline), NOT cfg.name. Fetch
// bindings for the actual deployed name; fall back to cfg.name only if
// the env var is somehow unset.
const scriptName = process.env.WORKER_NAME || cfg.name;

if (!token || !account) {
	console.log('[inject-bindings] CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set — skipping (deploy will ship bare)');
	process.exit(0);
}
if (!scriptName) {
	console.log('[inject-bindings] no WORKER_NAME and no name in wrangler.json — skipping');
	process.exit(0);
}

// `/workers/services/{name}/environments/production/bindings` returns the
// canonical binding list. The script name is the service name on the
// Workers Services API.
const url = `${CF_API}/accounts/${account}/workers/services/${scriptName}/environments/production/bindings`;
let bindings;
try {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (res.status === 404) {
		console.log(`[inject-bindings] worker '${scriptName}' does not exist yet — bootstrap deploy, skipping`);
		process.exit(0);
	}
	if (!res.ok) {
		const body = await res.text();
		console.log(`[inject-bindings] GET ${url} → ${res.status} ${res.statusText} — skipping`);
		console.log(`[inject-bindings] body: ${body.slice(0, 400)}`);
		process.exit(0);
	}
	const json = await res.json();
	if (!json.success) {
		console.log(`[inject-bindings] CF API reported success=false — skipping. errors: ${JSON.stringify(json.errors)}`);
		process.exit(0);
	}
	bindings = json.result;
} catch (e) {
	console.log(`[inject-bindings] fetch failed: ${e.message} — skipping`);
	process.exit(0);
}

if (!Array.isArray(bindings) || bindings.length === 0) {
	console.log('[inject-bindings] no live bindings to preserve');
	process.exit(0);
}

// Translate each live binding back into the wrangler.json shape. Add
// new cases as the wizard learns to attach new binding types. Unknown
// types log a warning and get skipped so the deploy doesn't crash.
let added = 0;
const skipped = [];

for (const b of bindings) {
	const name = b.name;
	switch (b.type) {
		case 'r2_bucket':
			cfg.r2_buckets ??= [];
			if (!cfg.r2_buckets.some(x => x.binding === name)) {
				cfg.r2_buckets.push({ binding: name, bucket_name: b.bucket_name });
				added++;
			}
			break;
		case 'kv_namespace':
			cfg.kv_namespaces ??= [];
			if (!cfg.kv_namespaces.some(x => x.binding === name)) {
				cfg.kv_namespaces.push({ binding: name, id: b.namespace_id });
				added++;
			}
			break;
		case 'ai':
			cfg.ai ??= { binding: name };
			added++;
			break;
		case 'images':
			cfg.images ??= { binding: name };
			added++;
			break;
		case 'vectorize':
			cfg.vectorize ??= [];
			if (!cfg.vectorize.some(x => x.binding === name)) {
				cfg.vectorize.push({ binding: name, index_name: b.index_name });
				added++;
			}
			break;
		case 'd1':
			cfg.d1_databases ??= [];
			if (!cfg.d1_databases.some(x => x.binding === name)) {
				cfg.d1_databases.push({ binding: name, database_id: b.id ?? b.database_id, database_name: b.name });
				added++;
			}
			break;
		case 'service':
			cfg.services ??= [];
			if (!cfg.services.some(x => x.binding === name)) {
				cfg.services.push({ binding: name, service: b.service, environment: b.environment });
				added++;
			}
			break;
		case 'queue':
			cfg.queues ??= { producers: [], consumers: [] };
			cfg.queues.producers ??= [];
			if (!cfg.queues.producers.some(x => x.binding === name)) {
				cfg.queues.producers.push({ binding: name, queue: b.queue_name });
				added++;
			}
			break;
		case 'hyperdrive':
			cfg.hyperdrive ??= [];
			if (!cfg.hyperdrive.some(x => x.binding === name)) {
				cfg.hyperdrive.push({ binding: name, id: b.id });
				added++;
			}
			break;
		case 'durable_object_namespace':
			cfg.durable_objects ??= { bindings: [] };
			cfg.durable_objects.bindings ??= [];
			if (!cfg.durable_objects.bindings.some(x => x.name === name)) {
				cfg.durable_objects.bindings.push({
					name,
					class_name: b.class_name,
					script_name: b.script_name,
				});
				added++;
			}
			break;
		case 'plain_text':
		case 'secret_text':
			// Plaintext vars + secrets are kept across deploys by passing
			// --keep-vars to wrangler deploy. We don't have to (and for
			// secrets, can't) replay their values here.
			skipped.push(`${b.type}:${name}`);
			break;
		case 'assets':
			// ASSETS is auto-wired by the @astrojs/cloudflare adapter; never
			// replace it with the live shape.
			break;
		default:
			console.log(`[inject-bindings] unknown binding type '${b.type}' for '${name}', leaving for wrangler deploy to handle (may be wiped)`);
	}
}

writeFileSync(target, JSON.stringify(cfg));
console.log(`[inject-bindings] injected ${added} live binding(s) into wrangler.json for '${scriptName}'` + (skipped.length ? ` (handled-by-keep-vars: ${skipped.join(', ')})` : ''));
