import { describe, expect, test, vi } from 'vitest';
import {
	buildOutlineComments,
	createAnchoredComment,
	syncOutlineComments,
	CommentableHighlight,
	OutlineCommentInput,
} from './outline-comments';

const config = { baseUrl: 'https://wiki.example.com', apiKey: 'ol_api_test' };
const stripTags = (html: string) => html.replace(/<[^>]+>/g, '');

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function calls(fetchImpl: ReturnType<typeof vi.fn>) {
	return fetchImpl.mock.calls.map(call => ({
		method: (call[0] as string).split('/api/')[1],
		body: JSON.parse((call[1] as RequestInit).body as string),
	}));
}

describe('buildOutlineComments', () => {
	test('builds anchored comments only for highlights with notes', () => {
		const highlights: CommentableHighlight[] = [
			{ id: '1', type: 'text', content: '<p>no  note</p>' },
			{
				id: '2', type: 'text', content: '<p>The <b>key</b>\n point</p>', notes: [' Important '],
				textQuote: { prefix: 'Before   the ', suffix: ' after it.  ' },
			},
		];
		const [comment, ...rest] = buildOutlineComments(highlights, stripTags);
		expect(rest).toEqual([]);
		expect(comment).toMatchObject({
			text: 'Important',
			anchorText: 'The key point',
			anchorPrefix: 'Before the ',
			anchorSuffix: ' after it.',
			quote: 'The key point',
		});
		expect(comment.key).toMatch(/^[0-9a-f]+-[0-9a-z]+$/);
	});

	test('groups anchor to the first block and quote all blocks', () => {
		const highlights: CommentableHighlight[] = [
			{ id: '1', type: 'text', content: 'First block', groupId: 'g', notes: ['note'] },
			{ id: '2', type: 'text', content: 'Second block', groupId: 'g' },
		];
		const [comment] = buildOutlineComments(highlights, stripTags);
		expect(comment.anchorText).toBe('First block');
		expect(comment.quote).toBe('First block … Second block');
	});

	test('element highlights become document-level comments', () => {
		const [comment] = buildOutlineComments([
			{ id: '1', type: 'element', content: '<img src="x.png">', notes: ['About this chart'] },
		], stripTags);
		expect(comment.anchorText).toBeUndefined();
		expect(comment.quote).toBeUndefined();
		expect(comment.text).toBe('About this chart');
	});

	test('keys are stable and change with the note', () => {
		const make = (note: string) => buildOutlineComments([{ id: '1', type: 'text', content: 'Text', notes: [note] }], stripTags)[0].key;
		expect(make('a')).toBe(make('a'));
		expect(make('a')).not.toBe(make('b'));
	});
});

const input: OutlineCommentInput = {
	key: 'k1', text: 'My note', anchorText: 'The key point', anchorPrefix: 'Before ', anchorSuffix: ' after', quote: 'The key point',
};

describe('createAnchoredComment', () => {
	test('anchors with context on the first try', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: 'c1' } }));
		await expect(createAnchoredComment(config, 'doc', input, { fetchImpl })).resolves.toEqual({ id: 'c1', anchored: true });
		expect(calls(fetchImpl)).toEqual([{ method: 'comments.create', body: {
			documentId: 'doc', text: 'My note', anchorText: 'The key point', anchorPrefix: 'Before ', anchorSuffix: ' after',
		} }]);
	});

	test('falls back to text only, then to a quoted document-level comment', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ message: 'anchor not found' }, 400))
			.mockResolvedValueOnce(jsonResponse({ message: 'anchor not found' }, 400))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'c1' } }));
		await expect(createAnchoredComment(config, 'doc', input, { fetchImpl })).resolves.toEqual({ id: 'c1', anchored: false });
		expect(calls(fetchImpl).map(c => c.body)).toEqual([
			{ documentId: 'doc', text: 'My note', anchorText: 'The key point', anchorPrefix: 'Before ', anchorSuffix: ' after' },
			{ documentId: 'doc', text: 'My note', anchorText: 'The key point' },
			{ documentId: 'doc', text: '> The key point\n\nMy note' },
		]);
	});

	test('does not retry on non-validation errors', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 401));
		await expect(createAnchoredComment(config, 'doc', input, { fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe('syncOutlineComments', () => {
	const second: OutlineCommentInput = { key: 'k2', text: 'Second' };

	test('append mode only posts notes not synced before', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: 'c2' } }));
		const result = await syncOutlineComments(config, {
			documentId: 'doc', inputs: [input, second], existing: { k1: 'c1', other: 'c9' }, rebuild: false,
		}, { fetchImpl });
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['comments.create']);
		expect(result.comments).toEqual({ k1: 'c1', other: 'c9', k2: 'c2' });
		expect(result).toMatchObject({ created: 1, removed: 0, failed: 0 });
	});

	test('rebuild deletes previous comments and recreates all notes', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ success: true }))
			.mockResolvedValueOnce(jsonResponse({ message: 'gone' }, 404))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'n1' } }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'n2' } }));
		const result = await syncOutlineComments(config, {
			documentId: 'doc', inputs: [input, second], existing: { k1: 'c1', stale: 'c9' }, rebuild: true,
		}, { fetchImpl });
		expect(calls(fetchImpl).map(c => `${c.method}:${c.body.id ?? ''}`)).toEqual([
			'comments.delete:c1', 'comments.delete:c9', 'comments.create:', 'comments.create:',
		]);
		expect(result.comments).toEqual({ k1: 'n1', k2: 'n2' });
		expect(result).toMatchObject({ created: 2, removed: 1 });
	});

	test('rebuild with no notes just removes old comments', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
		const result = await syncOutlineComments(config, {
			documentId: 'doc', inputs: [], existing: { k1: 'c1' }, rebuild: true,
		}, { fetchImpl });
		expect(result.comments).toEqual({});
		expect(result.removed).toBe(1);
	});

	test('stops on fatal errors and counts the rest as failed', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, 403));
		const result = await syncOutlineComments(config, {
			documentId: 'doc', inputs: [{ key: 'a', text: 'a' }, { key: 'b', text: 'b' }, { key: 'c', text: 'c' }], existing: {}, rebuild: false,
		}, { fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ created: 0, failed: 3 });
	});

	test('skips duplicate keys within one sync', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: 'c' } }));
		await syncOutlineComments(config, { documentId: 'doc', inputs: [second, second], existing: {}, rebuild: false }, { fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
