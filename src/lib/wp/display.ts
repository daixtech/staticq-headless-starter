import { decodeEntities } from '../text';
import { withDecodedName } from './env';
import type { WPEmbeddedTerm, WPPost } from './types';

export function getAuthorName(post: WPPost): string | null {
	const name = post._embedded?.author?.[0]?.name;
	return name != null ? decodeEntities(name) : null;
}

export function getPrimaryCategory(post: WPPost): WPEmbeddedTerm | null {
	const terms = post._embedded?.['wp:term'];
	if (!terms) return null;
	const cats = terms.find((group) => group.some((t) => t.taxonomy === 'category'));
	return cats?.[0] ? withDecodedName(cats[0]) : null;
}

export function formatDate(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function readingTimeMinutes(html: string, wordsPerMinute = 220): number {
	const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
	const words = text ? text.split(' ').length : 0;
	return Math.max(1, Math.round(words / wordsPerMinute));
}
