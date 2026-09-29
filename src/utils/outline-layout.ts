// Readability passes applied to the Outline document markdown. Pure functions.
//
// Outline's editor styles paragraphs with `margin: 0` and relies on empty
// paragraphs for vertical space (it serializes them explicitly so they survive
// reloads). Standard markdown only separates paragraphs with a blank line, so
// clipped articles render as a wall of text. `addParagraphSpacing` inserts an
// empty paragraph (a lone `\` line, which Outline stores as an empty
// paragraph) between top-level blocks.

export type OutlineFrontmatterStyle = 'table' | 'callout' | 'code';

export interface FrontmatterProperty {
	name: string;
	values: string[];
}

export interface PropertyLabels {
	name: string;
	value: string;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const NOTICE_OPEN_RE = /^\s{0,3}(:{3,})\s*[A-Za-z]/;
const NOTICE_CLOSE_RE = /^\s{0,3}(:{3,})\s*$/;
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/;
const EMPTY_PARAGRAPH = '\\';

// --- Frontmatter ---------------------------------------------------------

function unquoteYaml(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

/** Parses the YAML subset produced by generateFrontmatter(). */
export function parseFrontmatterProperties(frontmatter: string): FrontmatterProperty[] {
	const match = frontmatter.trim().match(/^---\r?\n([\s\S]*?)\r?\n?---$/);
	if (!match) return [];
	const properties: FrontmatterProperty[] = [];
	for (const line of match[1].split(/\r?\n/)) {
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && properties.length > 0) {
			const value = unquoteYaml(item[1]);
			if (value) properties[properties.length - 1].values.push(value);
			continue;
		}
		const entry = line.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?):(?:\s+(.*))?$/);
		if (!entry) continue;
		const value = entry[2] !== undefined ? unquoteYaml(entry[2]) : '';
		properties.push({ name: unquoteYaml(entry[1]), values: value ? [value] : [] });
	}
	return properties;
}

function displayValue(value: string): string {
	// Wikilinks can't resolve in Outline: [[target|alias]] → alias
	const text = value.replace(/!?\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
		const pipe = inner.indexOf('|');
		return (pipe !== -1 ? inner.slice(pipe + 1) : inner).trim();
	});
	if (/^https?:\/\/\S+$/.test(text)) return `[${text}](${text})`;
	return text;
}

/** Renders properties as a table or notice. Returns '' when nothing to show. */
export function renderFrontmatterProperties(
	properties: FrontmatterProperty[],
	style: Exclude<OutlineFrontmatterStyle, 'code'>,
	labels: PropertyLabels,
): string {
	// The title is already the document title
	const rows = properties
		.filter(p => p.name.trim().toLowerCase() !== 'title')
		.map(p => ({ name: p.name.trim(), value: p.values.map(displayValue).filter(Boolean).join(', ') }))
		.filter(p => p.name && p.value);
	if (rows.length === 0) return '';

	if (style === 'callout') {
		const lines = rows.map(r => `**${r.name.replace(/\*/g, '\\*')}**: ${r.value.replace(/\s*\n\s*/g, ' ')}`);
		return `:::info\n${lines.join('\n\n')}\n:::\n\n`;
	}

	const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
	const table = [
		`| ${cell(labels.name)} | ${cell(labels.value)} |`,
		'| --- | --- |',
		...rows.map(r => `| ${cell(r.name)} | ${cell(r.value)} |`),
	];
	return `${table.join('\n')}\n\n`;
}

// --- Block splitting -----------------------------------------------------

type BlockType = 'heading' | 'list' | 'spacer' | 'fence' | 'notice' | 'table' | 'quote' | 'paragraph';

interface Block {
	type: BlockType;
	lines: string[];
}

function classify(firstLine: string): BlockType {
	if (firstLine.trim() === EMPTY_PARAGRAPH) return 'spacer';
	if (FENCE_RE.test(firstLine)) return 'fence';
	if (NOTICE_OPEN_RE.test(firstLine)) return 'notice';
	if (HEADING_RE.test(firstLine)) return 'heading';
	if (LIST_RE.test(firstLine)) return 'list';
	if (/^\s{0,3}>/.test(firstLine)) return 'quote';
	if (/^\s{0,3}\|/.test(firstLine)) return 'table';
	return 'paragraph';
}

/** Splits markdown into top-level blocks, keeping code, notices and loose lists whole. */
function splitBlocks(markdown: string): Block[] {
	const blocks: Block[] = [];
	let current: string[] = [];
	let fence: string | null = null;
	const notices: number[] = [];

	const flush = () => {
		if (current.length > 0) {
			blocks.push({ type: classify(current[0]), lines: current });
			current = [];
		}
	};

	for (const line of markdown.split('\n')) {
		if (fence) {
			current.push(line);
			const m = line.match(FENCE_RE);
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
			continue;
		}
		const fenceMatch = line.match(FENCE_RE);
		if (fenceMatch) {
			fence = fenceMatch[1];
			current.push(line);
			continue;
		}
		const open = line.match(NOTICE_OPEN_RE);
		if (open) {
			notices.push(open[1].length);
			current.push(line);
			continue;
		}
		const close = line.match(NOTICE_CLOSE_RE);
		if (close && notices.length > 0 && close[1].length >= notices[notices.length - 1]) {
			notices.pop();
			current.push(line);
			continue;
		}
		if (notices.length > 0) {
			current.push(line);
			continue;
		}
		if (line.trim() === '') {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();

	// Loose lists (blank lines between items or indented continuations) stay one block
	const merged: Block[] = [];
	for (const block of blocks) {
		const prev = merged[merged.length - 1];
		const continuesList = block.type === 'list' || /^(\s{2,}|\t)/.test(block.lines[0]);
		if (prev && prev.type === 'list' && continuesList) {
			prev.lines.push('', ...block.lines);
		} else {
			merged.push(block);
		}
	}
	return merged;
}

function joinBlocks(blocks: Block[]): string {
	return blocks.map(b => b.lines.join('\n')).join('\n\n');
}

// --- Paragraph spacing ---------------------------------------------------

/**
 * Inserts an empty paragraph between top-level blocks. Headings keep their own
 * margins, so no spacer is added next to them; nothing is added inside code,
 * notices, lists, tables or quotes.
 */
export function addParagraphSpacing(markdown: string): string {
	const blocks = splitBlocks(markdown);
	const output: Block[] = [];
	for (const block of blocks) {
		const prev = output[output.length - 1];
		if (prev && prev.type !== 'heading' && block.type !== 'heading' && prev.type !== 'spacer' && block.type !== 'spacer') {
			output.push({ type: 'spacer', lines: [EMPTY_PARAGRAPH] });
		}
		output.push(block);
	}
	return joinBlocks(output);
}

// --- Bilingual pages -----------------------------------------------------
//
// Translation extensions (e.g. Immersive Translate) append the translation to
// each original paragraph/heading inline. Clipped, that becomes one run-on
// paragraph ("…dataset. 如果拥有…") and headings like "Discussion讨论". When a
// page looks bilingual, put the translation on its own line and separate
// heading translations with " / ".

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
const LATIN_RE = /[A-Za-z]/g;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const HARD_BREAK_RE = /( {2,}|\\|<br\s*\/?>)$/i;

function scriptCounts(text: string): { latin: number; cjk: number } {
	const cleaned = text
		.replace(/\]\([^)]*\)/g, ']')
		.replace(/\[\^[^\]]*\]/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/https?:\/\/\S+/g, '');
	return { latin: (cleaned.match(LATIN_RE) ?? []).length, cjk: (cleaned.match(CJK_RE) ?? []).length };
}

function isLatinDominant(text: string, minLatin: number): boolean {
	const { latin, cjk } = scriptCounts(text);
	return latin >= minLatin && cjk <= latin * 0.05;
}

function isCjkDominant(text: string): boolean {
	const { latin, cjk } = scriptCounts(text);
	return cjk >= 2 && cjk >= (latin + cjk) * 0.3;
}

/**
 * Index where an inline translation starts, or -1. The translation follows the
 * original, so prefer the last sentence boundary where everything before is
 * Latin and everything after is CJK; otherwise the last point where CJK text
 * begins (translations can start with Latin names, e.g. "Claude 4 系列…").
 */
function findTranslationStart(text: string, minLatin: number, allowNoSpace: boolean): number {
	const valid = (index: number) => index > 0 && index < text.length
		&& isLatinDominant(text.slice(0, index), minLatin) && isCjkDominant(text.slice(index));

	const sentenceBoundaries: number[] = [];
	const sentenceRe = /[.?!;:](?:["'\u201d\u2019)\]*_]*)\s+/g;
	let match: RegExpExecArray | null;
	while ((match = sentenceRe.exec(text)) !== null) sentenceBoundaries.push(match.index + match[0].length);
	const sentence = sentenceBoundaries.filter(valid);
	if (sentence.length > 0) return sentence[sentence.length - 1];

	const cjkStarts: number[] = [];
	for (let i = 1; i < text.length; i++) {
		if (!CJK_CHAR_RE.test(text[i]) || CJK_CHAR_RE.test(text[i - 1])) continue;
		if (allowNoSpace || /\s/.test(text[i - 1])) cjkStarts.push(i);
	}
	const starts = cjkStarts.filter(valid);
	return starts.length > 0 ? starts[starts.length - 1] : -1;
}

interface BilingualEdit {
	apply: () => void;
}

/** Returns the markdown with inline translations separated, or unchanged if not bilingual. */
export function applyBilingualLayout(markdown: string): string {
	const blocks = splitBlocks(markdown);
	let evidence = 0;
	const edits: BilingualEdit[] = [];

	for (const block of blocks) {
		if (block.type === 'heading') {
			const m = block.lines[0].match(/^(\s{0,3}#{1,6}\s+)(.*)$/);
			if (!m) continue;
			const index = findTranslationStart(m[2], 6, true);
			if (index > 0) {
				edits.push({ apply: () => {
					block.lines[0] = `${m[1]}${m[2].slice(0, index).trimEnd()} / ${m[2].slice(index).trimStart()}`;
				} });
			}
			continue;
		}
		if (block.type !== 'paragraph' && block.type !== 'list') continue;

		for (let i = 0; i < block.lines.length; i++) {
			const line = block.lines[i];
			// Already split by a hard break: counts as evidence, nothing to change
			if (HARD_BREAK_RE.test(line) && i + 1 < block.lines.length
				&& isLatinDominant(line, 12) && isCjkDominant(block.lines[i + 1])) {
				evidence++;
				continue;
			}
			const marker = block.type === 'list' ? (line.match(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)/)?.[1] ?? '') : '';
			if (block.type === 'list' && !marker) continue;
			const content = line.slice(marker.length);
			const index = findTranslationStart(content, 12, false);
			if (index > 0) {
				evidence++;
				const indent = block.type === 'list' ? ' '.repeat(marker.length) : '';
				edits.push({ apply: () => {
					block.lines[i] = `${marker}${content.slice(0, index).trimEnd()}\\\n${indent}${content.slice(index)}`;
				} });
			}
		}
	}

	// A couple of matching paragraphs means the page itself is bilingual
	if (evidence < 2 || edits.length === 0) return markdown;
	edits.forEach(edit => edit.apply());
	return joinBlocks(blocks);
}
