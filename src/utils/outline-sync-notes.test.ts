import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleOutlineMessage, OUTLINE_ACTIONS } from './outline-service';

const { syncStore, localStore } = vi.hoisted(() => ({
	syncStore: {} as Record<string, unknown>,
	localStore: {} as Record<string, unknown>,
}));

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
		tabs: { create: vi.fn(), query: async () => [] },
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
		syncComments: true,
	};
	localStore.outline_api_key = 'ol_api_secret';
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function api(call: unknown[]): string {
	return (call[0] as string).split('/api/')[1];
}

function seedMapping() {
	localStore.outline_documents = {
		'https://example.com/post': { documentId: 'd1', baseUrl: 'https://wiki.example.com', url: '/doc/t', title: 'The Doc', updatedAt: '' },
	};
}

describe('handleOutlineSyncNotes', () => {
	test('fails with notFound when the page was never clipped', async () => {
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.syncNotes,
			sourceUrl: 'https://example.com/post',
			comments: [{ key: 'k1', text: 'note' }],
		});
		expect(response).toEqual({ success: false, errorKind: 'notFound', error: 'Page is not clipped to Outline' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('fails with notFound when the mapped document no longer exists', async () => {
		seedMapping();
		// documents.info returns 404 → getOutlineDocument resolves null
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404));
		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.syncNotes,
			sourceUrl: 'https://example.com/post',
			comments: [{ key: 'k1', text: 'note' }],
		});
		expect(response).toMatchObject({ success: false, errorKind: 'notFound' });
		expect(fetchMock.mock.calls.map(api)).toEqual(['documents.info']);
	});

	test('creates only new notes and leaves existing ones untouched', async () => {
		seedMapping();
		localStore.outline_doc_state = {
			d1: { updatedAt: '', uploads: {}, comments: { k1: 'c1' } },
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // info
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'c2' } })); // create k2

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.syncNotes,
			sourceUrl: 'https://example.com/post',
			comments: [
				{ key: 'k1', text: 'already posted', anchorText: 'A' },
				{ key: 'k2', text: 'new note', anchorText: 'B' },
			],
		});

		expect(response).toMatchObject({ success: true, url: 'https://wiki.example.com/doc/t', comments: { created: 1, anchored: 1, removed: 0, failed: 0 } });
		// No comments.list (nothing stale), no delete, only one create
		expect(fetchMock.mock.calls.map(api)).toEqual(['documents.info', 'comments.create']);
		expect((localStore.outline_doc_state as any).d1.comments).toEqual({ k1: 'c1', k2: 'c2' });
	});

	test('prunes a stale note whose comment has no replies', async () => {
		seedMapping();
		localStore.outline_doc_state = {
			d1: { updatedAt: '', uploads: {}, comments: { k1: 'c1', kStale: 'cStale' } },
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // info
			.mockResolvedValueOnce(jsonResponse({ data: [ // comments.list
				{ id: 'c1' },
				{ id: 'cStale' },
			] }))
			.mockResolvedValueOnce(jsonResponse({ success: true })); // comments.delete cStale

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.syncNotes,
			sourceUrl: 'https://example.com/post',
			comments: [{ key: 'k1', text: 'kept', anchorText: 'A' }],
		});

		expect(response).toMatchObject({ success: true, comments: { created: 0, removed: 1, failed: 0 } });
		expect(fetchMock.mock.calls.map(api)).toEqual(['documents.info', 'comments.list', 'comments.delete']);
		expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({ id: 'cStale' });
		expect((localStore.outline_doc_state as any).d1.comments).toEqual({ k1: 'c1' });
	});

	test('keeps a stale comment that has replies', async () => {
		seedMapping();
		localStore.outline_doc_state = {
			d1: { updatedAt: '', uploads: {}, comments: { kReplied: 'cReplied' } },
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'd1', title: 'T', url: '/doc/t' } })) // info
			.mockResolvedValueOnce(jsonResponse({ data: [ // comments.list: cReplied has a child reply
				{ id: 'cReplied' },
				{ id: 'cReply', parentCommentId: 'cReplied' },
			] }));

		const response = await handleOutlineMessage({
			action: OUTLINE_ACTIONS.syncNotes,
			sourceUrl: 'https://example.com/post',
			comments: [], // note removed
		});

		expect(response).toMatchObject({ success: true, comments: { created: 0, removed: 0, failed: 0 } });
		// Lists comments but never deletes the replied-to one
		expect(fetchMock.mock.calls.map(api)).toEqual(['documents.info', 'comments.list']);
		// Mapping preserved so we don't try to reconcile it again
		expect((localStore.outline_doc_state as any).d1.comments).toEqual({ kReplied: 'cReplied' });
	});
});
