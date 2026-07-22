// Shared cache-key helper. The receiver Worker uses the equivalent function
// in `r2-delete.ts` to derive the same key from purge URLs, so both ends
// agree on what gets stored/deleted. Don't change one without the other.

const KEY_PREFIX = 'pages';

// Trailing-slash URLs (e.g. `/foo/`) map to `<prefix>/foo/index.html` so R2
// stores a real, viewable object name instead of an empty leaf. The root `/`
// becomes `<prefix>/index.html`. Paths with file extensions (e.g. `/rss.xml`)
// are left as-is.
export function pathToKey(pathname: string): string {
	const path = pathname || '/';
	const needsIndex = path.endsWith('/');
	return `${KEY_PREFIX}${path}${needsIndex ? 'index.html' : ''}`;
}
