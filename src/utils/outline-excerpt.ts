// Appends a selected passage to today's Outline daily note as a Markdown
// blockquote followed by a source attribution line. Used by the right-click
// "Excerpt to today's Outline daily note" action and (Stage 2) an in-page
// selection toolbar.
//
// The formatting is deliberately fixed and frontmatter-free: a daily note is
// appended to many times a day, so it must never accumulate frontmatter/
// property blocks. Paragraph spacing still follows the Outline setting so the
// output matches the rest of a user's documents.

import dayjs from 'dayjs';
import { OutlineFailure, handleOutlineSaveDocument } from './outline-service';
import { OutlineSaveMode } from './outline-sync';
import { convertMarkdownForOutline } from './outline-markdown';
import { addParagraphSpacing } from './outline-layout';

/** Payload accepted by the excerpt handler. All fields optional; defaults come from the caller. */
export interface OutlineExcerptRequest {
	/** Selection as Markdown (preferred). Falls back to plain text when absent. */
	selectionMarkdown?: string;
	/** Selection as plain text, used when Markdown extraction failed. */
	selectionText?: string;
	/** Title of the page the excerpt came from, used in the source line. */
	pageTitle?: string;
	/** URL of the page the excerpt came from, used in the source line. */
	pageUrl?: string;
	/** Overrides "now" for deterministic tests. */
	now?: Date;
	/** Insert blank lines between blocks (defaults to the Outline paragraph-spacing setting). */
	paragraphSpacing?: boolean;
}

export type OutlineExcerptResponse =
	| { success: true; id: string; title: string; url: string; mode: OutlineSaveMode; dailyTitle: string }
	| OutlineFailure;

/** Escapes `]` in link text and `)` in a URL so the Markdown link stays well-formed. */
function escapeLinkText(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function escapeLinkUrl(url: string): string {
	// Angle-bracket form tolerates most characters; escape the closing bracket/paren defensively
	return url.replace(/\)/g, '%29').replace(/ /g, '%20');
}

/** Prefixes every line with `> ` (empty lines become a bare `>`), yielding one blockquote. */
export function toBlockquote(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	return lines
		.map(line => (line.trim().length === 0 ? '>' : `> ${line}`))
		.join('\n');
}

/** Builds the `— [title](url) · HH:mm` attribution line. Omits the link when there is no URL. */
export function buildSourceLine(pageTitle: string, pageUrl: string, when: Date): string {
	const time = dayjs(when).format('HH:mm');
	const title = (pageTitle || pageUrl || '').trim();
	if (pageUrl) {
		const label = title || pageUrl;
		return `— [${escapeLinkText(label)}](${escapeLinkUrl(pageUrl)}) · ${time}`;
	}
	if (title) {
		return `— ${title} · ${time}`;
	}
	return `— ${time}`;
}

/**
 * Formats an excerpt for a daily note: the excerpt as a blockquote, a blank
 * line, then the source line. Returns an empty string for a blank excerpt.
 */
export function formatExcerptForDaily(
	excerptMarkdown: string,
	pageTitle: string,
	pageUrl: string,
	when: Date,
): string {
	const trimmed = excerptMarkdown.replace(/\s+$/g, '').replace(/^\s*\n/g, '');
	if (!trimmed.trim()) return '';
	const quote = toBlockquote(trimmed);
	const source = buildSourceLine(pageTitle, pageUrl, when);
	return `${quote}\n\n${source}`;
}

/**
 * Core excerpt handler: validates the selection, formats it, and appends it to
 * today's Outline daily note via the shared save pipeline (behavior
 * 'append-daily', no frontmatter, image upload/comments not involved). Reusable
 * from the context-menu handler and from a runtime message. Rejects an
 * empty/whitespace excerpt with a validation failure.
 */
export async function handleOutlineExcerptToDaily(request: OutlineExcerptRequest): Promise<OutlineExcerptResponse> {
	const when = request.now instanceof Date && !Number.isNaN(request.now.getTime()) ? request.now : new Date();
	const dailyTitle = dayjs(when).format('YYYY-MM-DD');

	const rawExcerpt = (typeof request.selectionMarkdown === 'string' && request.selectionMarkdown.trim())
		? request.selectionMarkdown
		: (typeof request.selectionText === 'string' ? request.selectionText : '');

	if (!rawExcerpt || !rawExcerpt.trim()) {
		return { success: false, errorKind: 'validation', error: 'Selection is empty' };
	}

	const pageTitle = typeof request.pageTitle === 'string' ? request.pageTitle : '';
	const pageUrl = typeof request.pageUrl === 'string' ? request.pageUrl : '';

	// Convert Obsidian-flavoured Markdown to Outline Markdown, then build the block.
	const converted = convertMarkdownForOutline(rawExcerpt);
	let block = formatExcerptForDaily(converted, pageTitle, pageUrl, when);
	if (!block.trim()) {
		return { success: false, errorKind: 'validation', error: 'Selection is empty' };
	}
	if (request.paragraphSpacing) {
		block = addParagraphSpacing(block);
	}

	const response = await handleOutlineSaveDocument({
		action: 'outlineSaveDocument',
		title: dailyTitle,
		text: block,
		behavior: 'append-daily',
	});

	if (!response.success) {
		return response;
	}
	return {
		success: true,
		id: response.id,
		title: response.title,
		url: response.url,
		mode: response.mode,
		dailyTitle,
	};
}
