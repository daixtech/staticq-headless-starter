// Small HTML-transform utilities applied to WP `content.rendered` before it
// reaches the article template. Uses node-html-parser (lightweight, Workers-
// compatible, no DOM-only APIs).
//
// Functions are independent — call them in any order — but the typical
// pipeline is in `preparePostBody`: strip scripts → group standalone gallery
// figures → transform wp-block-galleries → rewrite links → add heading ids,
// then extract headings.

import { parse, type HTMLElement } from 'node-html-parser';
import { decodeEntities } from './text';

export interface HeadingInfo {
	id: string;
	level: 2 | 3;
	text: string;
}

// Strip the WP origin from <a href="..."> values so body links resolve
// against the headless frontend instead of jumping back to the WP site.
// Leaves external links (non-WP) alone. Also normalises protocol-relative
// `//www.example.com/...` and `http://` variants.
export function rewriteWpLinks(html: string, wpBase: string): string {
	if (!html || !wpBase) return html;
	const base = wpBase.replace(/\/$/, '');
	const host = base.replace(/^https?:/, '');
	const root = parse(html);
	const anchors = root.querySelectorAll('a[href]');
	for (const a of anchors) {
		const href = a.getAttribute('href') ?? '';
		let rewritten: string | null = null;
		if (href.startsWith(base)) {
			rewritten = href.slice(base.length) || '/';
		} else if (href.startsWith(host)) {
			rewritten = href.slice(host.length) || '/';
		}
		if (rewritten !== null) {
			if (!rewritten.startsWith('/')) rewritten = '/' + rewritten;
			a.setAttribute('href', rewritten);
		}
	}
	return root.toString();
}

// Remove inline <script> blocks from body HTML. WP-side SEO plugins
// (Rank Math, Yoast) inject JSON-LD <script type="application/ld+json">
// directly into post content; that conflicts with the schemas we emit from
// SEOJsonLd.astro. Stripping here keeps structured data deterministic and
// avoids duplicate Article / NewsArticle blocks confusing crawlers. Also
// strips any other inline <script> as a security belt-and-braces — body
// content should never need to run scripts in the headless render.
export function stripScripts(html: string): string {
	if (!html) return html;
	const root = parse(html);
	for (const s of root.querySelectorAll('script')) s.remove();
	return root.toString();
}

// Re-exported (imported at the top) so existing importers of
// decodeEntities from this module keep working. The implementation lives
// in text.ts to avoid coupling string decoding to node-html-parser.
export { decodeEntities };

// Group standalone `<figure class="wp-block-image">` siblings that follow a
// "Gallery" H2 into a `.wp-block-gallery` wrapper so the downstream
// `transformGalleries` pass turns them into a grid. The source editorial
// pattern places each gallery image as its own block — without this step
// they'd render as full-width vertically-stacked images.
//
// Heuristic: any H2 whose decoded text equals "Gallery" (case-insensitive)
// triggers grouping of every immediately-following `figure.wp-block-image`
// sibling until another heading or non-figure element appears.
export function groupGalleryFigures(html: string): string {
	if (!html) return html;
	const root = parse(html);
	const headings = root.querySelectorAll('h2, h3');
	for (const h of headings) {
		const label = decodeEntities(h.innerText ?? '').trim().toLowerCase();
		if (label !== 'gallery') continue;
		const figs: HTMLElement[] = [];
		let next: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
		while (next) {
			const tag = next.tagName?.toLowerCase();
			const cls = next.getAttribute('class') ?? '';
			const isImageFigure = tag === 'figure' && /\bwp-block-image\b/.test(cls);
			if (!isImageFigure) break;
			figs.push(next);
			next = next.nextElementSibling as HTMLElement | null;
		}
		if (figs.length < 2) continue;
		const wrapper = parse(
			`<figure class="wp-block-gallery is-cropped">${figs.map((f) => f.toString()).join('')}</figure>`,
		).firstChild as HTMLElement;
		// Replace the first figure with the wrapper, remove the rest.
		figs[0].replaceWith(wrapper);
		for (const f of figs.slice(1)) f.remove();
	}
	return root.toString();
}

// Replace Gutenberg `.wp-block-gallery` blocks with our own grid markup
// (`.sq-gallery`). Each image becomes a `<figure>` with an optional
// caption. When the source gallery wraps each image in an <a> (Gutenberg
// does this when the block is saved with `linkTo: "media"`), preserve
// the href and add target="_blank" + rel — that's how the live Tipi
// renderer's `cursor: zoom-in` "click to open in new tab" behavior on
// `.tipi-gallery__link` was working, and the user relies on it.
// Falls back to deriving the master URL by stripping the WP size
// suffix (`-1024x768`) from the img src when there's no parent anchor.
export function transformGalleries(html: string): string {
	if (!html) return html;
	const root = parse(html);
	const galleries = root.querySelectorAll('.wp-block-gallery, .blocks-gallery-grid');
	for (const gallery of galleries) {
		const imgs = gallery.querySelectorAll('img');
		if (imgs.length === 0) {
			gallery.remove();
			continue;
		}
		const columns = imgs.length <= 2 ? 2 : imgs.length === 3 ? 3 : 4;
		const items = imgs.map((img) => {
			const src = img.getAttribute('src') ?? '';
			const alt = img.getAttribute('alt') ?? '';
			const fig = img.closest('figure');
			const caption = decodeEntities(fig?.querySelector('figcaption')?.innerText ?? '').trim();
			const parentA = img.closest('a');
			let fullHref = parentA?.getAttribute('href') ?? '';
			if (!fullHref && src) {
				// Strip Gutenberg/WP `-1234x567` size suffix to derive the
				// master URL. Works for the standard WP image_size_names
				// pattern; harmless on URLs without a suffix.
				fullHref = src.replace(/-\d+x\d+(?=\.[a-z0-9]+(?:\?|$))/i, '');
			}
			return { src, alt, caption, fullHref };
		});
		const grid = `<div class="sq-gallery sq-gallery--cols-${columns}">${items
			.map((it) => {
				const imgHtml = `<img src="${escapeAttr(it.src)}" alt="${escapeAttr(it.alt)}" loading="lazy" />`;
				const captionHtml = it.caption ? `<figcaption>${escapeText(it.caption)}</figcaption>` : '';
				const linked = it.fullHref
					? `<a class="sq-gallery__link" href="${escapeAttr(it.fullHref)}" target="_blank" rel="noopener noreferrer" aria-label="Open original image in new tab">${imgHtml}</a>`
					: imgHtml;
				return `
				<figure class="sq-gallery__item">
					${linked}
					${captionHtml}
				</figure>`;
			})
			.join('')}</div>`;
		gallery.replaceWith(parse(grid));
	}
	return root.toString();
}

// Wrap every body <img> that isn't already inside a <picture> in one, adding
// a `<source type="image/webp">` with URL-derived WebP paths. The
// staticq-media WP plugin emits this wrapper for Gutenberg `wp-block-image`
// figures already, but classic-editor / custom-block images (e.g. the
// `b-article-detail-image-center` wrapper) ship without it, so the body
// inconsistently mixes WebP-enhanced and JPG-only images.
//
// Skips imgs already in a <picture>, imgs inside <noscript> (those are
// SEO/no-JS fallbacks, the visible img is elsewhere), imgs inside an AMP
// custom element (e.g. <amp-story-player> expects a specific
// `<a><img class="amp-story-player-poster-img"/></a>` child shape and
// breaks if we wrap the poster in a <picture>), and imgs whose src
// extension isn't `.jpg`/`.jpeg`/`.png` (e.g. already-WebP, or SVG).
//
// As with our featured-image WebP derivation, browsers fall back to the
// JPG <img> inside <picture> if a WebP 404s, so missing-WebP cases
// degrade silently.
export function enhanceBodyImages(html: string): string {
	if (!html) return html;
	const root = parse(html);
	const imgs = root.querySelectorAll('img');
	for (const img of imgs) {
		if (img.closest('picture') || img.closest('noscript')) continue;
		// Walk up the ancestor chain for any `amp-*` custom element. We
		// can't use closest('[tag^="amp-"]') because tag-prefix CSS
		// selectors aren't supported, so check tagName explicitly.
		let inAmp = false;
		let parent = img.parentNode as HTMLElement | null;
		while (parent) {
			const t = parent.tagName?.toLowerCase();
			if (t && t.startsWith('amp-')) { inAmp = true; break; }
			parent = parent.parentNode as HTMLElement | null;
		}
		if (inAmp) continue;
		const src = img.getAttribute('src');
		if (!src) continue;
		// Only enhance raster-photo extensions we know the plugin generates
		// WebP for. SVG / GIF / WebP / etc. are left as-is.
		if (!/\.(jpe?g|png)(\?.*)?$/i.test(src)) continue;

		const srcset = img.getAttribute('srcset') ?? '';
		const sizes = img.getAttribute('sizes') ?? '';

		const webpSrcset = srcset
			? srcset
					.split(',')
					.map((part) => {
						const trimmed = part.trim();
						const m = trimmed.match(/^(\S+)(\s+.*)?$/);
						if (!m) return trimmed;
						return rewriteSrcsetUrl(m[1]) + (m[2] ?? '');
					})
					.join(', ')
			: rewriteSrcsetUrl(src);

		const sourceAttrs = [
			'type="image/webp"',
			`srcset="${escapeAttr(webpSrcset)}"`,
			sizes ? `sizes="${escapeAttr(sizes)}"` : '',
		]
			.filter(Boolean)
			.join(' ');

		const picture = parse(`<picture><source ${sourceAttrs}></picture>`)
			.firstChild as HTMLElement;
		// Append the original img element into the new picture, then swap
		// the picture into the img's slot. (node-html-parser supports
		// replaceWith with a parsed node tree.)
		const imgHtml = img.toString();
		picture.appendChild(parse(imgHtml).firstChild as HTMLElement);
		img.replaceWith(picture);
	}
	return root.toString();
}

function rewriteSrcsetUrl(url: string): string {
	return url.replace(/\.(jpe?g|png)(\?.*)?$/i, '.webp$2');
}

// Demote every <h1> in the rendered body to <h2>. The article wrapper
// already emits <h1 class="wp-page__title"> for the page title, so any
// <h1> inside content is a duplicate (SEO + accessibility both flag
// pages with multiple H1s). Tipi authors frequently wrote raw <h1>
// tags inside the WYSIWYG editor, and those survive into migrated
// post_content as `<h1 style="text-align: center;">…</h1>` blocks.
// Preserves all attributes (style, class, etc.) — the existing
// h2 styling (green accent bar) makes them read as prominent section
// headings, which is the visual role the editor intended.
export function demoteContentH1(html: string): string {
	if (!html || html.indexOf('<h1') < 0) return html;
	const root = parse(html);
	const h1s = root.querySelectorAll('h1');
	for (const h1 of h1s) {
		const attrs = h1.attributes;
		let attrStr = '';
		for (const name in attrs) {
			attrStr += ` ${name}="${(attrs[name] ?? '').replace(/"/g, '&quot;')}"`;
		}
		const replacement = `<h2${attrStr}>${h1.innerHTML}</h2>`;
		h1.replaceWith(parse(replacement));
	}
	return root.toString();
}

// wpDataTables emits the literal string "N/A" as the value when a row's
// URL or image column is empty. The rendered HTML then has anchors like
// `<a href="N/A" target="_blank"><button>Full Specs</button></a>` and
// images like `<img src="N/A">` — both of which the browser tries to
// resolve against the page URL, gets a 404, and shows as broken links
// or icons. Same fix pattern as TipiTitledContent uses for Tipi-
// rendered pages; ported here so migrated-page rendering through
// preparePostBody catches them too.
//
// - Anchor wrappers with href="N/A" → replace with a styled label
//   ("N/A") so the row reads as "no data" instead of as a broken
//   button.
// - Bare <img src="N/A"> (and the WP size-suffixed variants the plugin
//   sometimes inserts, e.g. `N/A-100x100.jpg`) → same label.
//
// All regex-based — the strings are simple and we avoid the DOM parse
// cost on tables with hundreds of rows.
export function stripWpdtNaLinks(html: string): string {
	if (!html) return html;
	let out = html;
	// Anchor whose href is literally N/A, around any inner content
	// (typically a <button>). Match both ' and " quoting. Replace the
	// whole anchor with a muted <span class="wpdt-na">N/A</span>; the
	// CSS in ArticleBody styles it as a dimmed inline label.
	out = out.replace(
		/<a\b[^>]*\bhref\s*=\s*(['"])N\/A\1[^>]*>[\s\S]*?<\/a>/gi,
		'<span class="wpdt-na">N/A</span>',
	);
	// Bare <img src="NA"> or "N/A", optionally with WP's size suffix
	// (`-100x100`) and an extension. Wider regex covers both. We don't
	// need to match `data-src` or `srcset` because the broken-link case
	// is the visible src.
	out = out.replace(
		/<img\b[^>]*\bsrc\s*=\s*(['"])(?:NA|N\/A)(?:-\d+x\d+)?(?:\.[a-z0-9]+)?\1[^>]*>/gi,
		'<span class="wpdt-na">N/A</span>',
	);
	return out;
}

// Remove empty heading tags from the rendered body. Tipi authors
// routinely left <h2></h2> / <h3></h3> tags between sections as a
// spacer device — they survive into migrated post_content and become
// SEO + accessibility liabilities (empty headings signal "important
// section" with no content; Rank Math, Lighthouse, and screen readers
// all flag them). Whitespace-only headings (e.g. "<h3> </h3>") count
// as empty too — innerText.trim() handles both. Run BEFORE
// addHeadingIds so we don't burn id slugs on tags we're about to drop.
export function stripEmptyHeadings(html: string): string {
	if (!html) return html;
	const root = parse(html);
	const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
	for (const h of headings) {
		const text = decodeEntities(h.innerText ?? '').trim();
		if (text === '') h.remove();
	}
	return root.toString();
}

// Add stable id attributes to H2/H3 elements that don't already have one,
// so the sidebar TOC can deep-link to them.
export function addHeadingIds(html: string): string {
	if (!html) return html;
	const root = parse(html);
	const used = new Set<string>();
	const headings = root.querySelectorAll('h2, h3');
	for (const h of headings) {
		const existing = h.getAttribute('id');
		if (existing) {
			used.add(existing);
			continue;
		}
		const text = decodeEntities(h.innerText ?? '').trim();
		const slug = slugifyForId(text) || 'section';
		let candidate = slug;
		let n = 2;
		while (used.has(candidate)) candidate = `${slug}-${n++}`;
		used.add(candidate);
		h.setAttribute('id', candidate);
	}
	return root.toString();
}

// Pull out the final H2/H3 list (with ids) for TOC rendering. Returns text
// with entities decoded so the sidebar can render it as plain text.
export function extractHeadings(html: string): HeadingInfo[] {
	if (!html) return [];
	const root = parse(html);
	const headings = root.querySelectorAll('h2, h3');
	const out: HeadingInfo[] = [];
	for (const h of headings) {
		const id = h.getAttribute('id');
		if (!id) continue;
		const level = h.tagName.toLowerCase() === 'h2' ? 2 : 3;
		const text = decodeEntities(h.innerText ?? '').trim();
		if (!text) continue;
		out.push({ id, level, text });
	}
	return out;
}

// Truncate at a word boundary so headlines, descriptions, etc. don't get
// chopped mid-token. Returns the original string when it's already under
// the limit; otherwise trims to the last whitespace before `max`.
export function truncateAtWord(text: string, max: number): string {
	if (!text || text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	if (lastSpace < max * 0.6) return cut.trim() + '…';
	return cut.slice(0, lastSpace).trim() + '…';
}

// Convenience: run the full body pipeline in one call. Returns the final
// HTML plus the heading list extracted from it. Order matters here.
export function preparePostBody(html: string, wpBase: string): {
	html: string;
	headings: HeadingInfo[];
} {
	let working = stripScripts(html);
	working = groupGalleryFigures(working);
	working = transformGalleries(working);
	working = enhanceBodyImages(working);
	working = rewriteWpLinks(working, wpBase);
	working = stripWpdtNaLinks(working);
	working = demoteContentH1(working);
	working = stripEmptyHeadings(working);
	working = addHeadingIds(working);
	const headings = extractHeadings(working);
	return { html: working, headings };
}

function slugifyForId(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 60);
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
