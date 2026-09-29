import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { handleOutlineMessage, OUTLINE_ACTIONS } from './outline-service';

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
			'https://wiki.example.com/api/documents.create',
			'https://wiki.example.com/api/documents.info',
			'https://wiki.example.com/api/documents.update',
		]);
		expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
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
			'documents.create', 'attachments.createFromUrl', 'documents.update', 'comments.create',
		]);
		expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).text)
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
