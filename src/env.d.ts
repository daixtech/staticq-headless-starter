interface ImportMetaEnv {
	readonly WP_BASE_URL: string;
	readonly WP_FETCH_COOKIE?: string;
	readonly SITE_GATE_COOKIE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
