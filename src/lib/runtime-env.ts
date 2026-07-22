/**
 * Runtime environment access for the deployed Cloudflare Worker.
 *
 * Reads from the Worker's runtime `env` (exposed by @astrojs/cloudflare
 * via the `cloudflare:workers` virtual module) FIRST, then falls back
 * to `import.meta.env` (build-time, Vite-inlined) when no runtime
 * binding is present.
 *
 * Why runtime first: the StaticQ Headless WordPress plugin's
 * "Push to Astro Worker" feature pushes operator-configured values
 * (WP_BASE_URL, SITE_URL, etc.) to the Worker as plain_text bindings.
 * Without runtime access, those would be dead weight — Vite's
 * build-time inlining would have already baked in whatever was in
 * the GH Variables at build time, and any later operator change in
 * WP admin would be invisible until the next rebuild. Reading runtime
 * first means the plugin's bindings actually drive the deployed
 * Worker's behavior; settings changes take effect on the next request,
 * no rebuild needed.
 *
 * Why a build-time fallback: for local `astro dev` (no Worker
 * runtime, no `cloudflare:workers` virtual module), `import.meta.env`
 * is the only env source available. Operators developing locally
 * still get values from their `.env` file.
 */
import { env as workersEnv } from 'cloudflare:workers';

const envBag = workersEnv as Record<string, unknown>;

/**
 * Get a string env var. Runtime > build-time > fallback.
 *
 * Returns the fallback for empty strings too — treating "" as "not
 * set" is what every caller wants here (no var ever legitimately
 * needs to be the literal empty string).
 */
export function envStr(key: string, fallback = ''): string {
	const runtime = envBag[key];
	if (typeof runtime === 'string' && runtime !== '') {
		return runtime;
	}
	const buildTime = (import.meta.env as Record<string, unknown>)[key];
	if (typeof buildTime === 'string' && buildTime !== '') {
		return buildTime;
	}
	return fallback;
}

/** Numeric env var, falling back if missing or unparseable. */
export function envNum(key: string, fallback = 0): number {
	const raw = envStr(key, '');
	if (raw === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Boolean env var. Accepts the usual truthy / falsy strings
 * (case-insensitive). Unknown values fall through to the fallback,
 * so callers can pick a safe default ("treat unset as false" or
 * "treat unset as true") depending on the use case.
 */
export function envBool(key: string, fallback = false): boolean {
	const raw = envStr(key, '').toLowerCase();
	if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
	if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
	return fallback;
}
