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
			sync: { get: async (keys: string | string[]) => pick(syncStore, keys), set: async () => {} },
			local: { get: async (keys: string | string[]) => pick(localStore, keys), set: async () => {} },
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
			action: OUTLINE_ACTIONS.createDocument,
			title: 'Title',
			text: 'Body',
		});

		expect(response).toEqual({ success: true, id: 'd1', title: 'Title', url: 'https://wiki.example.com/doc/title-abc' });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://wiki.example.com/api/documents.create');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ol_api_secret');
		expect(JSON.parse(init.body as string)).toEqual({
			title: 'Title', text: 'Body', collectionId: 'default-col', publish: false,
		});
		expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://wiki.example.com/doc/title-abc' });
	});

	test('does not open the document when silent open is enabled', async () => {
		syncStore.general_settings = { silentOpen: true };
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		await handleOutlineMessage({ action: OUTLINE_ACTIONS.createDocument, title: 'T', text: '' });
		expect(tabsCreate).not.toHaveBeenCalled();
	});

	test('allows overriding the collection per request', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } }));
		await handleOutlineMessage({ action: OUTLINE_ACTIONS.createDocument, title: 'T', text: '', collectionId: 'other' });
		expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).collectionId).toBe('other');
	});

	test('returns a config error when the API key is missing', async () => {
		delete localStore.outline_api_key;
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.createDocument, title: 'T', text: '' });
		expect(response).toMatchObject({ success: false, errorKind: 'config' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('returns API errors as structured failures', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, message: 'Authentication required' }, 401));
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.createDocument, title: 'T', text: '' });
		expect(response).toEqual({ success: false, errorKind: 'unauthorized', error: 'Authentication required' });
		expect(tabsCreate).not.toHaveBeenCalled();
	});

	test('validates the create request payload', async () => {
		const response = await handleOutlineMessage({ action: OUTLINE_ACTIONS.createDocument, title: 42 });
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
