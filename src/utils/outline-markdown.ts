// Converts Web Clipper output (Obsidian-flavoured Markdown) into Markdown
// that renders well in Outline. Pure functions, no browser dependencies.
//
// Decisions:
// - YAML frontmatter is preserved verbatim inside a ```yaml code block at the
//   top of the document. Outline's markdown parser has no frontmatter support,
//   and a raw `---` block would render as a horizontal rule + setext heading.
// - Callouts (`> [!type] Title`) become Outline notices (`:::info` etc.).
// - Wikilinks (`[[target|alias]]`) become plain text (Outline can't resolve
//   vault links). Embeds (`![[file]]`) become plain text file names.
// - `==highlight==`, tables, task lists, math and code are supported by Outline
//   and left untouched.
// - Content inside fenced code blocks and inline code spans is never modified.

export const OUTLINE_TITLE_MAX_LENGTH = 100;

type NoticeStyle = 'info' | 'warning' | 'tip' | 'success';

const CALLOUT_STYLE_MAP: Record<string, NoticeStyle> = {
	note: 'info',
	info: 'info',
	abstract: 'info',
	summary: 'info',
	tldr: 'info',
	todo: 'info',
	quote: 'info',
	cite: 'info',
	example: 'info',
	tip: 'tip',
	hint: 'tip',
	important: 'tip',
	success: 'success',
	check: 'success',
	done: 'success',
	question: 'warning',
	help: 'warning',
	faq: 'warning',
	warning: 'warning',
	caution: 'warning',
	attention: 'warning',
	failure: 'warning',
	fail: 'warning',
	missing: 'warning',
	danger: 'warning',
	error: 'warning',
	bug: 'warning',
};

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CALLOUT_RE = /^\s{0,3}>\s*\[!([^\]]+)\][+-]?\s*(.*)$/;
const QUOTE_LINE_RE = /^\s{0,3}>/;

export function mapCalloutType(type: string): NoticeStyle {
	return CALLOUT_STYLE_MAP[type.trim().toLowerCase()] ?? 'info';
}

/**
 * Wraps frontmatter produced by generateFrontmatter() in a fenced yaml block.
 * Returns an empty string when there is no frontmatter.
 */
export function frontmatterToCodeBlock(frontmatter: string): string {
	const trimmed = frontmatter.trim();
	if (!trimmed) return '';

	const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n?---$/);
	const yaml = (match ? match[1] : trimmed).trim();
	if (!yaml) return '';

	// Use a fence longer than any backtick run inside the YAML
	const longestRun = Math.max(2, ...(yaml.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longestRun + 1);
	return `${fence}yaml\n${yaml}\n${fence}\n\n`;
}

/** Converts wikilinks/embeds in a text segment that contains no code. */
function convertWikilinks(text: string): string {
	return text
		// Embeds: ![[file.png|alias]] -> alias or file name
		.replace(/!\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => wikilinkLabel(inner))
		// Links: [[target#heading|alias]] -> alias or target
		.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => wikilinkLabel(inner));
}

function wikilinkLabel(inner: string): string {
	const pipeIndex = inner.indexOf('|');
	if (pipeIndex !== -1) {
		const alias = inner.slice(pipeIndex + 1).trim();
		if (alias) return alias;
		inner = inner.slice(0, pipeIndex);
	}
	return inner.replace(/#\^?/, ' > ').trim();
}

/** Applies inline conversions while leaving inline code spans untouched. */
function convertInline(line: string): string {
	// Split on inline code spans (matching backtick runs), keep them verbatim
	const parts = line.split(/(`+[^`]*?`+)/g);
	return parts
		.map((part, index) => (index % 2 === 1 ? part : convertWikilinks(part)))
		.join('');
}

function stripQuoteMarker(line: string): string {
	return line.replace(/^\s{0,3}>\s?/, '');
}

/**
 * Converts Obsidian-flavoured Markdown body content to Outline Markdown.
 */
export function convertMarkdownForOutline(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const output: string[] = [];
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Pass fenced code through untouched
		const fenceMatch = line.match(FENCE_RE);
		if (fence) {
			output.push(line);
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			output.push(line);
			continue;
		}

		const calloutMatch = line.match(CALLOUT_RE);
		if (calloutMatch) {
			const style = mapCalloutType(calloutMatch[1]);
			const title = calloutMatch[2].trim();
			const body: string[] = [];
			while (i + 1 < lines.length && QUOTE_LINE_RE.test(lines[i + 1])) {
				i++;
				body.push(stripQuoteMarker(lines[i]));
			}

			// Recursively convert the body so nested callouts/code are handled
			const convertedBody = body.length > 0 ? convertMarkdownForOutline(body.join('\n')) : '';
			// Outer containers need a longer marker than any nested container
			const nestedMarkers = convertedBody.match(/^:{3,}/gm) ?? [];
			const markerLength = Math.max(2, ...nestedMarkers.map(m => m.length)) + 1;
			const marker = ':'.repeat(markerLength);

			output.push(`${marker}${style}`);
			if (title) output.push(`**${convertInline(title)}**`);
			if (title && convertedBody) output.push('');
			if (convertedBody) output.push(convertedBody);
			output.push(marker);
			continue;
		}

		output.push(convertInline(line));
	}

	return output.join('\n');
}

/** Builds the full Outline document text: frontmatter code block + converted body. */
export function buildOutlineDocumentText(frontmatter: string, body: string): string {
	return frontmatterToCodeBlock(frontmatter) + convertMarkdownForOutline(body);
}

/** Outline limits titles to 100 characters. */
export function normalizeOutlineTitle(title: string, fallback = 'Untitled'): string {
	const collapsed = title.replace(/\s+/g, ' ').trim() || fallback;
	const chars = Array.from(collapsed);
	if (chars.length <= OUTLINE_TITLE_MAX_LENGTH) return collapsed;
	return chars.slice(0, OUTLINE_TITLE_MAX_LENGTH - 1).join('').trimEnd() + '…';
}

/**
 * Applies `transform` to every piece of text outside fenced code blocks and
 * inline code spans. Used to rewrite image URLs without touching code.
 */
export function mapOutsideCode(markdown: string, transform: (text: string) => string): string {
	const lines = markdown.split('\n');
	let fence: string | null = null;
	return lines.map(line => {
		const fenceMatch = line.match(FENCE_RE);
		if (fence) {
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
				fence = null;
			}
			return line;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			return line;
		}
		return line
			.split(/(`+[^`]*?`+)/g)
			.map((part, index) => (index % 2 === 1 ? part : transform(part)))
			.join('');
	}).join('\n');
}
