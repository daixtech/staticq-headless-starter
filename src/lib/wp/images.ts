import type { ResponsiveImageData, ResponsiveImageVariant, WPPost } from './types';

export function getFeaturedImageUrl(post: WPPost, size: string = 'medium_large'): string | null {
	const media = post._embedded?.['wp:featuredmedia']?.[0];
	if (!media) return null;
	return media.media_details?.sizes?.[size]?.source_url ?? media.source_url ?? null;
}

export function getFeaturedImageAlt(post: WPPost): string {
	return post._embedded?.['wp:featuredmedia']?.[0]?.alt_text ?? '';
}

// Pulls every registered size from `_embedded.wp:featuredmedia` and builds
// a responsive-image record ready for the <ResponsiveImage> component.
// WebP URLs are derived by swapping the extension on the JPG/PNG path —
// optimistic, but the <picture> element falls back to the JPG if the
// webp 404s, so missing-webp cases degrade gracefully.
export function getResponsiveImage(
	post: WPPost,
	preferredSize: string = 'large',
): ResponsiveImageData | null {
	const media = post._embedded?.['wp:featuredmedia']?.[0];
	if (!media) return null;

	const sizes = media.media_details?.sizes ?? {};

	const variants: ResponsiveImageVariant[] = Object.values(sizes)
		.filter((s) => !!s?.source_url && (s.width ?? 0) > 0)
		.map((s) => ({
			src: s.source_url,
			webp: deriveWebpUrl(s.source_url),
			width: s.width,
			height: s.height,
		}))
		.sort((a, b) => a.width - b.width);

	if (variants.length === 0) {
		if (!media.source_url) return null;
		return {
			src: media.source_url,
			width: 0,
			height: 0,
			alt: media.alt_text ?? '',
			variants: [
				{
					src: media.source_url,
					webp: deriveWebpUrl(media.source_url),
					width: 0,
					height: 0,
				},
			],
		};
	}

	const preferred = sizes[preferredSize];
	const fallback = variants[variants.length - 1];
	const defaultSrc = preferred?.source_url ?? fallback.src;
	const defaultWidth = preferred?.width ?? fallback.width;
	const defaultHeight = preferred?.height ?? fallback.height;

	return {
		src: defaultSrc,
		width: defaultWidth,
		height: defaultHeight,
		alt: media.alt_text ?? '',
		variants,
	};
}

// Swap a .jpg / .jpeg / .png extension for .webp, preserving any query
// string. Uses a lowercase `.webp` extension, matching how WordPress
// media/optimization plugins typically emit their WebP variants.
function deriveWebpUrl(url: string): string {
	return url.replace(/\.(jpe?g|png)(\?.*)?$/i, '.webp$2');
}
