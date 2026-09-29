import { describe, expect, test, vi } from 'vitest';
import { saveOutlineDocument, OutlineSaveInput } from './outline-sync';
import { withMapping, lookupMapping, withoutMapping, OutlineDocumentMapping } from './outline-documents-store';

const config = { baseUrl: 'https://wiki.example.com', apiKey: 'ol_api_test' };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function doc(id: string, title: string, extra: Record<string, unknown> = {}) {
	return { id, title, url: `/doc/${id}`, collectionId: 'col', ...extra };
}

function calls(fetchImpl: ReturnType<typeof vi.fn>) {
	return fetchImpl.mock.calls.map(call => ({
		method: (call[0] as string).split('/api/')[1],
		body: JSON.parse((call[1] as RequestInit).body as string),
	}));
}

const base: OutlineSaveInput = {
	title: 'Page title',
	text: 'Body',
	behavior: 'create',
	collectionId: 'col',
	publish: true,
};

describe('saveOutlineDocument', () => {
	test('create without mapping creates a document', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: doc('new', 'Page title') }));
		const result = await saveOutlineDocument(config, base, { fetchImpl });
		expect(result.mode).toBe('created');
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['documents.create']);
	});

	test('create with a live mapped document replaces it', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: doc('d1', 'Old') }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('d1', 'Page title') }));
		const result = await saveOutlineDocument(config, { ...base, mappedDocumentId: 'd1' }, { fetchImpl });
		expect(result).toMatchObject({ mode: 'updated', document: { id: 'd1' } });
		expect(calls(fetchImpl)).toEqual([
			{ method: 'documents.info', body: { id: 'd1' } },
			{ method: 'documents.update', body: { id: 'd1', text: 'Body', title: 'Page title' } },
		]);
	});

	test.each([
		['deleted (404)', () => jsonResponse({ message: 'Not found' }, 404)],
		['inaccessible (403)', () => jsonResponse({ message: 'Forbidden' }, 403)],
		['archived', () => jsonResponse({ data: doc('d1', 'Old', { archivedAt: '2026-01-01' }) })],
		['in trash', () => jsonResponse({ data: doc('d1', 'Old', { deletedAt: '2026-01-01' }) })],
	])('create falls back to a new document when the mapped one is %s', async (_label, infoResponse) => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(infoResponse())
			.mockResolvedValueOnce(jsonResponse({ data: doc('new', 'Page title') }));
		const result = await saveOutlineDocument(config, { ...base, mappedDocumentId: 'd1' }, { fetchImpl });
		expect(result).toMatchObject({ mode: 'created', document: { id: 'new' } });
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['documents.info', 'documents.create']);
	});

	test('create does not look up by title', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: doc('new', 'Page title') }));
		await saveOutlineDocument(config, base, { fetchImpl });
		expect(calls(fetchImpl).map(c => c.method)).not.toContain('documents.search_titles');
	});

	test('propagates non-404 errors from the mapping lookup', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Bad key' }, 401));
		await expect(saveOutlineDocument(config, { ...base, mappedDocumentId: 'd1' }, { fetchImpl }))
			.rejects.toMatchObject({ kind: 'unauthorized' });
	});

	test('overwrite falls back to an exact title match in the collection', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [
				doc('other', 'Page title extended'),
				doc('elsewhere', 'Page title', { collectionId: 'other-col' }),
				doc('match', '  page TITLE '),
			] }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('match', 'Page title') }));
		const result = await saveOutlineDocument(config, { ...base, behavior: 'overwrite' }, { fetchImpl });
		expect(result).toMatchObject({ mode: 'updated', document: { id: 'match' } });
		expect(calls(fetchImpl)).toEqual([
			{ method: 'documents.search_titles', body: { query: 'Page title', collectionId: 'col', limit: 25 } },
			{ method: 'documents.update', body: { id: 'match', text: 'Body', title: 'Page title' } },
		]);
	});

	test('overwrite prefers the URL mapping over title search', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: doc('d1', 'Old') }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('d1', 'Page title') }));
		await saveOutlineDocument(config, { ...base, behavior: 'overwrite', mappedDocumentId: 'd1' }, { fetchImpl });
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['documents.info', 'documents.update']);
	});

	test('append-specific appends to the document with the same title', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [doc('list', 'Reading list')] }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('list', 'Reading list') }));
		const result = await saveOutlineDocument(config, {
			...base, title: 'Reading list', behavior: 'append-specific', mappedDocumentId: 'ignored',
		}, { fetchImpl });
		expect(result.mode).toBe('appended');
		expect(calls(fetchImpl)).toEqual([
			{ method: 'documents.search_titles', body: { query: 'Reading list', collectionId: 'col', limit: 25 } },
			{ method: 'documents.update', body: { id: 'list', text: '\n\nBody', editMode: 'append' } },
		]);
	});

	test('prepend-daily prepends to today\'s document', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [doc('day', '2026-09-29')] }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('day', '2026-09-29') }));
		const result = await saveOutlineDocument(config, { ...base, title: '2026-09-29', behavior: 'prepend-daily' }, { fetchImpl });
		expect(result.mode).toBe('prepended');
		expect(calls(fetchImpl)[1]).toEqual({ method: 'documents.update', body: { id: 'day', text: 'Body\n\n', editMode: 'prepend' } });
	});

	test('append behaviors create the document when no title matches', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [] }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('new', '2026-09-29') }));
		const result = await saveOutlineDocument(config, { ...base, title: '2026-09-29', behavior: 'append-daily' }, { fetchImpl });
		expect(result.mode).toBe('created');
		expect(calls(fetchImpl)[1].body).toMatchObject({ title: '2026-09-29', text: 'Body' });
	});

	test('forceCreate skips all lookups', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: doc('new', 'Page title') }));
		const result = await saveOutlineDocument(config, {
			...base, behavior: 'overwrite', mappedDocumentId: 'd1', forceCreate: true,
		}, { fetchImpl });
		expect(result.mode).toBe('created');
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['documents.create']);
	});
});

describe('saveOutlineDocument transformText', () => {
	test('new documents are created first, then updated with the transformed text', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: doc('new', 'Page title') }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('new', 'Page title') }));
		const transformText = vi.fn(async (text: string, id: string) => `${text} [${id}]`);
		const result = await saveOutlineDocument(config, { ...base, transformText }, { fetchImpl });
		expect(result.mode).toBe('created');
		expect(transformText).toHaveBeenCalledWith('Body', 'new');
		expect(calls(fetchImpl)).toEqual([
			{ method: 'documents.create', body: { title: 'Page title', text: 'Body', collectionId: 'col', publish: true } },
			{ method: 'documents.update', body: { id: 'new', text: 'Body [new]', title: 'Page title' } },
		]);
	});

	test('transforms the text stored by Outline, which already has server-side attachments', async () => {
		const stored = '![a](/api/attachments.redirect?id=srv) ![b](https://x.com/b.png)';
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: { ...doc('new', 'Page title'), text: stored } }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('new', 'Page title') }));
		const transformText = vi.fn(async (text: string) => text.replace('https://x.com/b.png', '/att/b'));
		await saveOutlineDocument(config, { ...base, text: '![a](https://x.com/a.png) ![b](https://x.com/b.png)', transformText }, { fetchImpl });
		expect(transformText).toHaveBeenCalledWith(stored, 'new');
		expect(calls(fetchImpl)[1].body.text).toBe('![a](/api/attachments.redirect?id=srv) ![b](/att/b)');
	});

	test('skips the extra update when the text is unchanged', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: doc('new', 'Page title') }));
		await saveOutlineDocument(config, { ...base, transformText: async text => text }, { fetchImpl });
		expect(calls(fetchImpl).map(c => c.method)).toEqual(['documents.create']);
	});

	test('updates transform the text before writing', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: [doc('list', 'Page title')] }))
			.mockResolvedValueOnce(jsonResponse({ data: doc('list', 'Page title') }));
		await saveOutlineDocument(config, {
			...base, behavior: 'append-specific', transformText: async (text, id) => `${text}@${id}`,
		}, { fetchImpl });
		expect(calls(fetchImpl)[1]).toEqual({ method: 'documents.update', body: { id: 'list', text: '\n\nBody@list', editMode: 'append' } });
	});
});

describe('outline document mappings', () => {
	const mapping = (id: string, updatedAt = '2026-01-01T00:00:00.000Z'): OutlineDocumentMapping => ({
		documentId: id, baseUrl: 'https://wiki.example.com/', url: `https://wiki.example.com/doc/${id}`, title: id, updatedAt,
	});

	test('stores under the normalized URL and matches the server', () => {
		const map = withMapping({}, 'https://example.com/a?utm_source=x#top', mapping('d1'));
		expect(Object.keys(map)).toEqual(['https://example.com/a']);
		expect(lookupMapping(map, 'https://example.com/a', 'https://wiki.example.com')?.documentId).toBe('d1');
		expect(lookupMapping(map, 'https://example.com/a#other', 'wiki.example.com/api')?.documentId).toBe('d1');
	});

	test('ignores mappings from a different Outline server', () => {
		const map = withMapping({}, 'https://example.com/a', mapping('d1'));
		expect(lookupMapping(map, 'https://example.com/a', 'https://app.getoutline.com')).toBeNull();
	});

	test('returns null for unknown or empty URLs', () => {
		expect(lookupMapping({}, 'https://example.com/a', 'https://wiki.example.com')).toBeNull();
		expect(lookupMapping({}, '', 'https://wiki.example.com')).toBeNull();
	});

	test('drops the oldest entries past the cap', () => {
		let map = withMapping({}, 'https://example.com/1', mapping('d1', '2026-01-01T00:00:00.000Z'), 2);
		map = withMapping(map, 'https://example.com/2', mapping('d2', '2026-01-03T00:00:00.000Z'), 2);
		map = withMapping(map, 'https://example.com/3', mapping('d3', '2026-01-02T00:00:00.000Z'), 2);
		expect(Object.keys(map).sort()).toEqual(['https://example.com/2', 'https://example.com/3']);
	});

	test('removes a mapping', () => {
		const map = withMapping({}, 'https://example.com/a', mapping('d1'));
		expect(withoutMapping(map, 'https://example.com/a?utm_medium=y')).toEqual({});
	});
});
