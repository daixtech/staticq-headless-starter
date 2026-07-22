// Small, dependency-free text helpers shared across the data layer and the
// HTML-processing layer. Kept separate from html.ts so modules that only
// need string decoding (wp.ts and the category/home routes) don't pull in
// node-html-parser.

// Decode the most common HTML numeric and named entities to real
// characters. WordPress returns taxonomy/term names and author display
// names HTML-encoded (e.g. `Pictures &amp; Videos`), and node-html-parser
// keeps literal entity text in .innerText / .text. Anywhere that string is
// rendered as PLAIN TEXT (breadcrumbs, nav labels, card kickers, the TOC)
// needs the decoded form, or the raw `&amp;` shows through.
//
// Order matters: `&amp;` is decoded first so a double-encoded value like
// `&amp;#39;` resolves correctly on the subsequent numeric pass.
export function decodeEntities(text: string): string {
	if (!text) return text;
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
