import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { handleOutlineMessage, OUTLINE_ACTIONS } from './outline-service';
import { normalizeUrl } from './url-utils';

const { syncStore, localStore } = vi.hoisted(() => ({
	syncStore: {} as Record<string, unknown>,
	localStore: {} as Record<string, unknown>,
}));
// vi.mock is hoisted above imports, so shared mocks must be hoisted too
const tabsCreate = vi.hoisted(() => vi.fn(async (_opts: { url: string }) => ({})));

function pick(store: Record<string, unknown>, keys: string | string[]) {
	const list = Array.isArray(keys) ? keys : [keys];
	return Object.fromEntries(list.filter(k => k in store).map(k => [k, store[k]]));
}

vi.mock('./browser-polyfill', () => ({
	default: {
		storage: {
			sync: { get: async (keys: string | string[]) => pick(syncStore, keys), set: async (items: Record<string, unknown>) => { Object.assign(syncStore, items); } },
			local: { get: async (keys: string | string[]) => pick(localStore, keys), set: async (items: Record<string, unknown>) => { Object.assign(localStore, items); } },
		},
		tabs: { create: tabsCreate },
		runtime: { sendMessage: async () => ({}) },
	},
}));

const fetchMock = vi.fn();

beforeEach(() => {
	for (const key of Object.keys(syncStore)) delete syncStore[key];
	for (const key of Object.keys(localStore)) delete localStore[key];
	syncStore.outline_settings = {
		baseUrl: 'https://wiki.example.com',
		collectionId: 'default-col',
		collectionName: 'Inbox',
		publish: false,
		uploadImages: false,
		syncComments: false,
	};
	localStore.outline_api_key = 'ol_api_secret';
	tabsCreate.mockClear();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('handleOutlineMessage', () => {
	test('ignores unrelated actions', () => {
		expect(handleOutlineMessage({ action: 'copy-to-clipboard' })).toBeNull();
	});

	test('creates a document using stored settings and opens it', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'Title', url: '/doc/title-abc' } }));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument,
			title: 'Title',
			text: 'Body',
		});

		expect(response).toEqual({ success: true, id: 'd1', title: 'Title', url: 'https://wiki.example.com/doc/title-abc', mode: 'created' });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://wiki.example.com/api/documents.create');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ol_api_secret');
		expect(JSON.parse(init.body as string)).toEqual({
			title: 'Title', text: 'Body', collectionId: 'default-col', publish: false,
		});
		expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://wiki.example.com/doc/title-abc' });
	});

	test('second clip of the same URL overwrites the mapped document', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] })) // source lookup finds nothing
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'First', url: '/doc/first' } }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'First', url: '/doc/first' } }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'Second', url: '/doc/first' } }));

		const first = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'First', text: 'v1',
			behavior: 'create', sourceUrl: 'https://example.com/post?utm_source=x',
		});
		expect(first).toMatchObject({ success: true, mode: 'created' });
		expect(localStore.outline_documents).toMatchObject({
			'https://example.com/post': { documentId: 'd1', baseUrl: 'https://wiki.example.com' },
		});

		const second = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'Second', text: 'v2',
			behavior: 'create', sourceUrl: 'https://example.com/post',
		});
		expect(second).toMatchObject({ success: true, mode: 'updated', id: 'd1' });
		expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
			'https://wiki.example.com/api/documents.search',
			'https://wiki.example.com/api/documents.create',
			'https://wiki.example.com/api/documents.info',
			'https://wiki.example.com/api/documents.update',
		]);
		expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)).toEqual({
			id: 'd1', text: 'v2', title: 'Second',
		});
	});

	test('forceCreate ignores the existing mapping and remaps the URL', async () => {
		localStore.outline_documents = {
			'https://example.com/post': { documentId: 'old', baseUrl: 'https://wiki.example.com', url: '', title: '', updatedAt: '' },
		};
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'new', title: 'T', url: '/doc/new' } }));
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', sourceUrl: 'https://example.com/post', forceCreate: true,
		});
		expect(response).toMatchObject({ success: true, mode: 'created', id: 'new' });
		expect(fetchMock.mock.calls[0][0]).toBe('https://wiki.example.com/api/documents.create');
		expect((localStore.outline_documents as any)['https://example.com/post'].documentId).toBe('new');
	});

	test('append behaviors do not create URL mappings', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'Reading list', url: '/doc/r' } }));
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'Reading list', text: 'x',
			behavior: 'append-specific', sourceUrl: 'https://example.com/post',
		});
		expect(response).toMatchObject({ success: true, mode: 'created' });
		expect(localStore.outline_documents).toBeUndefined();
	});

	test('unknown behaviors fall back to create', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', behavior: 'bogus',
		});
		expect(response).toMatchObject({ success: true, mode: 'created' });
	});

	test('uploads images and syncs note comments after saving', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), uploadImages: true, syncComments: true };
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] })) // source lookup
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // create
			.mockResolvedValueOnce(jsonResponse({ data: { url: '/api/attachments.redirect?id=a1' } })) // image
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // update text
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'c1' } })); // comment

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: 'Intro\n![img](https://cdn.example.org/a.png)',
			sourceUrl: 'https://example.com/post',
			comments: [{ key: 'k1', text: 'note', anchorText: 'Intro' }, { key: 'bad' }],
		});

		expect(response).toMatchObject({
			success: true, mode: 'created',
			images: { uploaded: 1, failed: 0 },
			comments: { created: 1, anchored: 1, failed: 0 },
		});
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual([
			'documents.search', 'documents.create', 'attachments.createFromUrl', 'documents.update', 'comments.create',
		]);
		expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string).text)
			.toBe('Intro\n![img](/api/attachments.redirect?id=a1)');
		expect((localStore.outline_doc_state as any).d1).toMatchObject({
			uploads: { 'https://cdn.example.org/a.png': '/api/attachments.redirect?id=a1' },
			comments: { k1: 'c1' },
		});
	});

	test('overwriting rebuilds previously created comments and reuses attachments', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), uploadImages: true, syncComments: true };
		localStore.outline_documents = {
			'https://example.com/post': { documentId: 'd1', baseUrl: 'https://wiki.example.com', url: '', title: '', updatedAt: '' },
		};
		localStore.outline_doc_state = {
			d1: { updatedAt: '', uploads: { 'https://cdn.example.org/a.png': '/att/a1' }, comments: { k1: 'old' } },
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // info
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // update
			.mockResolvedValueOnce(jsonResponse({ success: true })) // delete old comment
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'new' } })); // recreate

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '![img](https://cdn.example.org/a.png)',
			behavior: 'create', sourceUrl: 'https://example.com/post',
			comments: [{ key: 'k1', text: 'note', anchorText: 'x' }],
		});
		expect(response).toMatchObject({ success: true, mode: 'updated', images: { uploaded: 0, reused: 1 }, comments: { created: 1, removed: 1 } });
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual([
			'documents.info', 'documents.update', 'comments.delete', 'comments.create',
		]);
		expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).text).toBe('![img](/att/a1)');
		expect((localStore.outline_doc_state as any).d1.comments).toEqual({ k1: 'new' });
	});

	test('skips images and comments when both are disabled', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), uploadImages: false, syncComments: false };
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '![img](https://cdn.example.org/a.png)',
			comments: [{ key: 'k1', text: 'note' }],
		});
		expect(response).toMatchObject({ success: true });
		expect((response as any).images).toBeUndefined();
		expect((response as any).comments).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('finds a document clipped on another device by its source URL', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [
				{ document: { id: 'other', title: 'X', url: '/doc/x', collectionId: 'default-col', text: 'mentions https://example.com/post-2' } },
				{ document: { id: 'd9', title: 'T', url: '/doc/t', collectionId: 'default-col', text: '| source | https://example.com/post |' } },
			] }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd9', title: 'T', url: '/doc/t' } })) // info
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd9', title: 'T', url: '/doc/t' } })); // update
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: 'v2', sourceUrl: 'https://example.com/post',
		});
		expect(response).toMatchObject({ success: true, mode: 'updated', id: 'd9' });
		expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
			query: 'https://example.com/post', collectionId: 'default-col', limit: 10,
		});
		expect((localStore.outline_documents as any)['https://example.com/post'].documentId).toBe('d9');
	});

	test('nests new documents under the template path and backdates them', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), pathAsParent: true };
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] })) // source lookup
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'clip', title: 'Clippings', children: [] }] })) // tree
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'tech', title: 'Tech', url: '/doc/tech' } })) // folder
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })); // clip
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: 'x', sourceUrl: 'https://example.com/a',
			path: ' Clippings / Tech/', createdAt: '2026-05-08',
		});
		expect(response).toMatchObject({ success: true, mode: 'created' });
		const bodies = fetchMock.mock.calls.map(call => [(call[0] as string).split('/api/')[1], JSON.parse((call[1] as RequestInit).body as string)]);
		expect(bodies[1]).toEqual(['collections.documents', { id: 'default-col' }]);
		expect(bodies[2]).toEqual(['documents.create', { title: 'Tech', text: '', collectionId: 'default-col', publish: true, parentDocumentId: 'clip' }]);
		expect(bodies[3]).toEqual(['documents.create', {
			title: 'T', text: 'x', collectionId: 'default-col', publish: false,
			parentDocumentId: 'tech', createdAt: '2026-05-08T00:00:00.000Z',
		}]);
	});

	test('ignores the path when nesting is off and future creation dates', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		await handleOutlineMessage({
			action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: 'x', sourceUrl: 'https://example.com/a',
			path: 'Clippings', createdAt: '2999-01-01',
		});
		expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
			title: 'T', text: 'x', collectionId: 'default-col', publish: false,
		});
	});

	test('does not open the document when silent open is enabled', async () => {
		syncStore.general_settings = { silentOpen: true };
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '' });
		expect(tabsCreate).not.toHaveBeenCalled();
	});

	test('allows overriding the collection per request', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', collectionId: 'other' });
		expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).collectionId).toBe('other');
	});

	test('returns a config error when the API key is missing', async () => {
		delete localStore.outline_api_key;
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '' });
		expect(response).toMatchObject({ success: false, errorKind: 'config' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('returns API errors as structured failures', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, message: 'Authentication required' }, 401));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '' });
		expect(response).toEqual({ success: false, errorKind: 'unauthorized', error: 'Authentication required' });
		expect(tabsCreate).not.toHaveBeenCalled();
	});

	test('validates the create request payload', async () => {
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 42 });
		expect(response).toMatchObject({ success: false, errorKind: 'validation' });
	});

	test('test connection returns user, team and collections', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { user: { name: 'Jane' }, team: { name: 'Acme' } } }))
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'c1', name: 'Inbox' }] }));

		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.testConnection });
		expect(response).toEqual({
			success: true,
			userName: 'Jane',
			teamName: 'Acme',
			collections: [{ id: 'c1', name: 'Inbox' }],
		});
		expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
			'https://wiki.example.com/api/auth.info',
			'https://wiki.example.com/api/collections.list',
		]);
	});
});

describe('star on clip', () => {
	test('does not star by default (setting off, no per-clip flag)', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '' });
		expect(response).toMatchObject({ success: true, id: 'd1' });
		expect((response as any).starred).toBeUndefined();
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual(['documents.create']);
	});

	test('stars the document after a successful save when requested', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // create
			.mockResolvedValueOnce(jsonResponse({ data: { id: 's1' } })); // stars.create
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', star: true });
		expect(response).toMatchObject({ success: true, id: 'd1', starred: true });
		const calls = fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1]);
		expect(calls).toEqual(['documents.create', 'stars.create']);
		expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ documentId: 'd1' });
	});

	test('stars when the setting is on even without a per-clip flag', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), starOnClip: true };
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 's1' } }));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '' });
		expect(response).toMatchObject({ success: true, starred: true });
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual(['documents.create', 'stars.create']);
	});

	test('an explicit star:false overrides the setting', async () => {
		syncStore.outline_settings = { ...(syncStore.outline_settings as object), starOnClip: true };
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', star: false });
		expect(response).toMatchObject({ success: true });
		expect((response as any).starred).toBeUndefined();
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual(['documents.create']);
	});

	test('treats an already-starred validation error as success (still starred)', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }))
			.mockResolvedValueOnce(jsonResponse({ message: 'already starred' }, 400));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', star: true });
		expect(response).toMatchObject({ success: true, id: 'd1', starred: true });
		expect((response as any).starError).toBeUndefined();
	});

	test('a star failure does not fail the save', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }))
			.mockResolvedValueOnce(jsonResponse({ message: 'server exploded' }, 500));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.saveDocument, title: 'T', text: '', star: true });
		expect(response).toMatchObject({ success: true, id: 'd1', starred: false });
		expect((response as any).starError).toBeTruthy();
	});
});

describe('share document', () => {
	test('creates and publishes an unpublished share', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'sh1', url: 'https://wiki.example.com/s/abc', published: false } }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'sh1', url: 'https://wiki.example.com/s/abc', published: true } }));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.shareDocument, documentId: 'd1' });
		expect(response).toEqual({ success: true, url: 'https://wiki.example.com/s/abc' });
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual(['shares.create', 'shares.update']);
		expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ documentId: 'd1' });
	});

	test('skips the update when the share is already published', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'sh1', url: 'https://wiki.example.com/s/abc', published: true } }));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.shareDocument, documentId: 'd1' });
		expect(response).toEqual({ success: true, url: 'https://wiki.example.com/s/abc' });
		expect(fetchMock.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual(['shares.create']);
	});

	test('maps a 403 to a forbidden failure', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'sharing disabled' }, 403));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.shareDocument, documentId: 'd1' });
		expect(response).toMatchObject({ success: false, errorKind: 'forbidden' });
	});

	test('rejects a missing document id without calling the API', async () => {
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.shareDocument });
		expect(response).toMatchObject({ success: false, errorKind: 'validation' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('handleOutlineMessage — findRelated', () => {
	test('returns up to 5 live documents, excluding archived and deleted', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			data: [
				{ id: 'd1', title: 'Deep Modules', url: '/doc/deep-modules-1' },
				{ id: 'd2', title: 'Archived', url: '/doc/archived-2', archivedAt: '2023-01-01T00:00:00Z' },
				{ id: 'd3', title: 'Deleted', url: '/doc/deleted-3', deletedAt: '2023-01-01T00:00:00Z' },
				{ id: 'd4', title: 'Interface Design', url: '/doc/interface-4' },
				{ id: 'd5', title: 'Another', url: '/doc/another-5' },
				{ id: 'd6', title: 'And More', url: '/doc/more-6' },
				{ id: 'd7', title: 'Even More', url: '/doc/even-more-7' },
			],
		}));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.findRelated,
			title: 'Deep Modules in Practice | Hacker News',
		}) as { success: true; documents: { id: string; title: string; url: string }[] };

		expect(response.success).toBe(true);
		expect(response.documents.map(d => d.id)).toEqual(['d1', 'd4', 'd5', 'd6', 'd7']);
		// URLs are absolute
		expect(response.documents[0].url).toBe('https://wiki.example.com/doc/deep-modules-1');
		// Searched titles, scoped to the default collection, with a cleaned query
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://wiki.example.com/api/documents.search_titles');
		const body = JSON.parse(init.body as string);
		expect(body.query).toBe('Deep Modules Practice');
		expect(body.collectionId).toBe('default-col');
	});

	test('excludes the document already mapped to the source URL', async () => {
		const sourceUrl = 'https://example.com/post';
		localStore.outline_documents = {
			[normalizeUrl(sourceUrl)]: {
				documentId: 'd1',
				baseUrl: 'https://wiki.example.com',
				url: 'https://wiki.example.com/doc/deep-modules-1',
				title: 'Deep Modules',
				updatedAt: '2024-01-01T00:00:00Z',
			},
		};
		fetchMock.mockResolvedValueOnce(jsonResponse({
			data: [
				{ id: 'd1', title: 'Deep Modules', url: '/doc/deep-modules-1' },
				{ id: 'd4', title: 'Interface Design', url: '/doc/interface-4' },
			],
		}));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.findRelated,
			title: 'Deep Modules',
			sourceUrl,
		}) as { success: true; documents: { id: string }[] };

		expect(response.success).toBe(true);
		expect(response.documents.map(d => d.id)).toEqual(['d4']);
	});

	test('falls back to full-text search when title search finds nothing', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] })) // search_titles: empty
			.mockResolvedValueOnce(jsonResponse({
				data: [
					{ ranking: 0.9, context: '...', document: { id: 'd9', title: 'Full text hit', url: '/doc/ft-9' } },
				],
			}));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.findRelated,
			title: 'Some Obscure Topic',
		}) as { success: true; documents: { id: string; url: string }[] };

		expect(response.success).toBe(true);
		expect(response.documents.map(d => d.id)).toEqual(['d9']);
		expect(response.documents[0].url).toBe('https://wiki.example.com/doc/ft-9');
		expect((fetchMock.mock.calls[1][0] as string)).toBe('https://wiki.example.com/api/documents.search');
	});

	test('returns an empty list quickly when the title yields no query', async () => {
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.findRelated,
			title: '   ',
		});
		expect(response).toEqual({ success: true, documents: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('errors resolve to an empty list (never blocks the popup)', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.findRelated,
			title: 'Anything Here',
		});
		expect(response).toEqual({ success: true, documents: [] });
	});
});
