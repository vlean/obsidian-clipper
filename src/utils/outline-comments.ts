// Turns highlight notes into Outline comments anchored to the highlighted text.
//
// Anchoring falls back step by step, because the highlight's surrounding text
// comes from the web page and may not match the document exactly:
//   1. anchorText + anchorPrefix/anchorSuffix (disambiguates repeated text)
//   2. anchorText only (first occurrence)
//   3. a document-level comment that quotes the highlight
//
// When a document's text is replaced, Outline drops existing comment anchors,
// so comments this extension created are deleted and rebuilt. Appends keep
// anchors intact, so only new notes are posted.

import {
	OutlineApiError,
	OutlineConfig,
	OutlineRequestOptions,
	createOutlineComment,
	deleteOutlineComment,
	listOutlineComments,
} from './outline-client';

export const OUTLINE_COMMENT_MAX_LENGTH = 10000;
const QUOTE_MAX_LENGTH = 300;

/** Minimal highlight shape needed to build comments (matches AnyHighlightData). */
export interface CommentableHighlight {
	id: string;
	type: string;
	content: string;
	groupId?: string;
	notes?: string[];
	textQuote?: { prefix?: string; suffix?: string };
}

/** Serializable payload sent from the popup to the background. */
export interface OutlineCommentInput {
	/** Stable identity of the note, used to avoid posting it twice */
	key: string;
	/** Comment body (the note) */
	text: string;
	anchorText?: string;
	anchorPrefix?: string;
	anchorSuffix?: string;
	/** Highlighted text, quoted when the comment can't be anchored */
	quote?: string;
}

export interface OutlineCommentStats {
	created: number;
	anchored: number;
	failed: number;
	removed: number;
}

export interface SyncOutlineCommentsResult extends OutlineCommentStats {
	/** Note key → comment id, to persist for the document */
	comments: Record<string, string>;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, ' ');
}

function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

/** FNV-1a, enough to identify a note without storing its text twice. */
function hashString(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(16)}-${input.length.toString(36)}`;
}

function groupHighlightsInOrder<T extends CommentableHighlight>(highlights: T[]): T[][] {
	const groups: T[][] = [];
	const byGroupId = new Map<string, T[]>();
	for (const highlight of highlights) {
		if (!highlight.groupId) {
			groups.push([highlight]);
			continue;
		}
		const existing = byGroupId.get(highlight.groupId);
		if (existing) {
			existing.push(highlight);
		} else {
			const group = [highlight];
			byGroupId.set(highlight.groupId, group);
			groups.push(group);
		}
	}
	return groups;
}

/**
 * Builds one comment per highlight (or highlight group) that has a note.
 * `htmlToText` converts stored highlight HTML to plain text.
 */
export function buildOutlineComments(
	highlights: CommentableHighlight[],
	htmlToText: (html: string) => string,
): OutlineCommentInput[] {
	const comments: OutlineCommentInput[] = [];
	for (const group of groupHighlightsInOrder(highlights)) {
		const note = group
			.flatMap(h => h.notes ?? [])
			.map(n => n.trim())
			.filter(Boolean)
			.join('\n\n');
		if (!note) continue;

		const first = group[0];
		const texts = group
			.filter(h => h.type === 'text')
			.map(h => collapse(htmlToText(h.content || '')).trim())
			.filter(Boolean);

		const input: OutlineCommentInput = {
			key: '',
			text: truncate(note, OUTLINE_COMMENT_MAX_LENGTH),
		};

		// A group spans blocks; Outline anchors within plain text, so anchor to the first block
		if (first.type === 'text' && texts[0]) {
			input.anchorText = texts[0];
			// Keep whitespace adjacent to the highlight: it is part of the context match
			const prefix = collapse(first.textQuote?.prefix ?? '').trimStart();
			const suffix = collapse(first.textQuote?.suffix ?? '').trimEnd();
			if (prefix.trim()) input.anchorPrefix = prefix;
			if (suffix.trim()) input.anchorSuffix = suffix;
		}
		if (texts.length > 0) input.quote = truncate(texts.join(' … '), QUOTE_MAX_LENGTH);

		input.key = hashString(`${input.anchorText ?? first.id}\u0000${note}`);
		comments.push(input);
	}
	return comments;
}

function documentLevelText(input: OutlineCommentInput): string {
	if (!input.quote) return input.text;
	const quoted = input.quote.split('\n').map(line => `> ${line}`).join('\n');
	return truncate(`${quoted}\n\n${input.text}`, OUTLINE_COMMENT_MAX_LENGTH);
}

/** Creates a comment, relaxing the anchor when Outline can't place it. */
export async function createAnchoredComment(
	config: OutlineConfig,
	documentId: string,
	input: OutlineCommentInput,
	options?: OutlineRequestOptions,
): Promise<{ id: string; anchored: boolean }> {
	const attempts: Array<{ anchorText?: string; anchorPrefix?: string; anchorSuffix?: string }> = [];
	if (input.anchorText) {
		if (input.anchorPrefix || input.anchorSuffix) {
			attempts.push({ anchorText: input.anchorText, anchorPrefix: input.anchorPrefix, anchorSuffix: input.anchorSuffix });
		}
		attempts.push({ anchorText: input.anchorText });
	}
	attempts.push({});

	for (let i = 0; i < attempts.length; i++) {
		const anchor = attempts[i];
		const anchored = Boolean(anchor.anchorText);
		try {
			const id = await createOutlineComment(config, {
				documentId,
				text: anchored ? input.text : documentLevelText(input),
				...anchor,
			}, options);
			return { id, anchored };
		} catch (error) {
			// Outline answers 404 (not 400) when the anchor text isn't in the document
			const canRelax = error instanceof OutlineApiError
				&& (error.kind === 'validation' || error.kind === 'notFound')
				&& i < attempts.length - 1;
			if (!canRelax) throw error;
		}
	}
	throw new OutlineApiError('server', 'Unable to create comment');
}

function isFatal(error: unknown): boolean {
	return error instanceof OutlineApiError
		&& (error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'rateLimited' || error.kind === 'config');
}

export async function syncOutlineComments(
	config: OutlineConfig,
	params: {
		documentId: string;
		inputs: OutlineCommentInput[];
		/** Comments previously created for this document (note key → comment id) */
		existing: Record<string, string>;
		/** Delete and recreate existing comments (the document text was replaced) */
		rebuild: boolean;
	},
	options?: OutlineRequestOptions,
): Promise<SyncOutlineCommentsResult> {
	const stats: OutlineCommentStats = { created: 0, anchored: 0, failed: 0, removed: 0 };
	let comments = { ...params.existing };

	if (params.rebuild) {
		for (const [key, commentId] of Object.entries(comments)) {
			try {
				if (await deleteOutlineComment(config, commentId, options)) stats.removed++;
				delete comments[key];
			} catch (error) {
				console.warn('Failed to delete Outline comment:', commentId, error);
				if (isFatal(error)) {
					// Can't clean up; don't post duplicates on top of the old comments
					return { ...stats, failed: params.inputs.length, comments };
				}
				delete comments[key];
			}
		}
		comments = {};
	}

	const seen = new Set<string>();
	for (let i = 0; i < params.inputs.length; i++) {
		const input = params.inputs[i];
		if (seen.has(input.key) || comments[input.key]) continue;
		seen.add(input.key);
		try {
			const { id, anchored } = await createAnchoredComment(config, params.documentId, input, options);
			comments[input.key] = id;
			stats.created++;
			if (anchored) stats.anchored++;
		} catch (error) {
			console.warn('Failed to create Outline comment:', error);
			stats.failed++;
			if (isFatal(error)) {
				stats.failed += params.inputs.slice(i + 1).filter(rest => !comments[rest.key] && !seen.has(rest.key)).length;
				break;
			}
		}
	}

	return { ...stats, comments };
}

/**
 * Syncs highlight notes to an existing document's comments WITHOUT touching the
 * document text (used by "sync notes only"). Creates comments for notes not yet
 * posted, and prunes comments whose note was edited or removed — but never a
 * comment that has replies. Reply detection lists the document's comments and
 * skips deleting any id that is another comment's `parentCommentId`.
 */
export async function syncOutlineNoteComments(
	config: OutlineConfig,
	params: {
		documentId: string;
		inputs: OutlineCommentInput[];
		/** Comments previously created for this document (note key → comment id) */
		existing: Record<string, string>;
	},
	options?: OutlineRequestOptions,
): Promise<SyncOutlineCommentsResult> {
	const stats: OutlineCommentStats = { created: 0, anchored: 0, failed: 0, removed: 0 };
	const comments = { ...params.existing };

	// Prune notes that are no longer present (edited/removed), keeping replies safe
	const wantedKeys = new Set(params.inputs.map(input => input.key));
	const staleKeys = Object.keys(comments).filter(key => !wantedKeys.has(key));
	if (staleKeys.length > 0) {
		let commentsWithReplies = new Set<string>();
		try {
			const records = await listOutlineComments(config, params.documentId, options);
			commentsWithReplies = new Set(
				records.map(record => record.parentCommentId).filter((id): id is string => Boolean(id)),
			);
		} catch (error) {
			// Can't confirm replies: skip pruning rather than risk deleting a reply thread
			console.warn('Failed to list Outline comments; skipping prune:', error);
			staleKeys.length = 0;
		}
		for (const key of staleKeys) {
			const commentId = comments[key];
			if (commentsWithReplies.has(commentId)) continue;
			try {
				if (await deleteOutlineComment(config, commentId, options)) stats.removed++;
				delete comments[key];
			} catch (error) {
				console.warn('Failed to delete stale Outline comment:', commentId, error);
				if (isFatal(error)) return { ...stats, comments };
				// Non-fatal: drop the mapping so we stop trying to reconcile it
				delete comments[key];
			}
		}
	}

	// Create only notes we haven't posted yet
	const seen = new Set<string>();
	for (let i = 0; i < params.inputs.length; i++) {
		const input = params.inputs[i];
		if (seen.has(input.key) || comments[input.key]) continue;
		seen.add(input.key);
		try {
			const { id, anchored } = await createAnchoredComment(config, params.documentId, input, options);
			comments[input.key] = id;
			stats.created++;
			if (anchored) stats.anchored++;
		} catch (error) {
			console.warn('Failed to create Outline comment:', error);
			stats.failed++;
			if (isFatal(error)) {
				stats.failed += params.inputs.slice(i + 1).filter(rest => !comments[rest.key] && !seen.has(rest.key)).length;
				break;
			}
		}
	}

	return { ...stats, comments };
}
