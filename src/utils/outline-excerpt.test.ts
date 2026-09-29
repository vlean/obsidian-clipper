import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	buildSourceLine,
	formatExcerptForDaily,
	handleOutlineExcerptToDaily,
	toBlockquote,
} from './outline-excerpt';
import { isOutlineConfigured } from './outline-service';

const { syncStore, localStore } = vi.hoisted(() => ({
	syncStore: {} as Record<string, unknown>,
	localStore: {} as Record<string, unknown>,
}));
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
		paragraphSpacing: false,
	};
	// Silent open so the handler does not try to open a tab
	syncStore.general_settings = { silentOpen: true };
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

const WHEN = new Date('2026-09-29T14:05:00'); // local time; HH:mm derived by dayjs

describe('isOutlineConfigured', () => {
	test('true when url, collection and api key are present', () => {
		expect(isOutlineConfigured({ baseUrl: 'https://wiki.example.com', collectionId: 'col1' }, 'key')).toBe(true);
	});

	test('false when the api key is missing or blank', () => {
		expect(isOutlineConfigured({ baseUrl: 'https://wiki.example.com', collectionId: 'col1' }, '')).toBe(false);
		expect(isOutlineConfigured({ baseUrl: 'https://wiki.example.com', collectionId: 'col1' }, '   ')).toBe(false);
	});

	test('false when the collection is missing', () => {
		expect(isOutlineConfigured({ baseUrl: 'https://wiki.example.com', collectionId: '' }, 'key')).toBe(false);
	});

	test('false when settings are null', () => {
		expect(isOutlineConfigured(null, 'key')).toBe(false);
	});
});

describe('toBlockquote', () => {
	test('prefixes each line, collapsing blank lines to a bare marker', () => {
		expect(toBlockquote('first\n\nsecond')).toBe('> first\n>\n> second');
	});

	test('handles a single line', () => {
		expect(toBlockquote('hello world')).toBe('> hello world');
	});

	test('treats whitespace-only lines as empty', () => {
		expect(toBlockquote('a\n   \nb')).toBe('> a\n>\n> b');
	});
});

describe('buildSourceLine', () => {
	test('escapes ] in title and ) in url', () => {
		const line = buildSourceLine('Title [with] brackets', 'https://ex.com/a(b)c', WHEN);
		expect(line).toContain('Title \\[with\\] brackets');
		expect(line).toContain('https://ex.com/a(b%29c');
		expect(line).toMatch(/· \d{2}:\d{2}$/);
	});

	test('falls back to plain title when there is no url', () => {
		const line = buildSourceLine('Just a title', '', WHEN);
		expect(line.startsWith('— Just a title · ')).toBe(true);
		expect(line).not.toContain('](');
	});
});

describe('formatExcerptForDaily', () => {
	test('produces blockquote + blank line + source line', () => {
		const out = formatExcerptForDaily('line one\n\nline two', 'My Page', 'https://ex.com/p', WHEN);
		const [q1, q2, q3, blank, source] = out.split('\n');
		expect(q1).toBe('> line one');
		expect(q2).toBe('>');
		expect(q3).toBe('> line two');
		expect(blank).toBe('');
		expect(source).toContain('[My Page](https://ex.com/p)');
	});

	test('returns empty string for a blank excerpt', () => {
		expect(formatExcerptForDaily('   \n  ', 'T', 'https://ex.com', WHEN)).toBe('');
	});
});

describe('handleOutlineExcerptToDaily', () => {
	test('rejects an empty excerpt without calling the API', async () => {
		const response = await handleOutlineExcerptToDaily({
			selectionMarkdown: '   ',
			selectionText: '',
			pageTitle: 'T',
			pageUrl: 'https://ex.com',
			now: WHEN,
		});
		expect(response).toEqual({ success: false, errorKind: 'validation', error: 'Selection is empty' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('appends to an existing daily note (no frontmatter) with append semantics', async () => {
		fetchMock
			// documents.search_titles finds today's daily note
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'daily1', title: '2026-09-29', url: '/doc/2026-09-29', collectionId: 'default-col' }] }))
			// documents.update appends
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'daily1', title: '2026-09-29', url: '/doc/2026-09-29' } }));

		const response = await handleOutlineExcerptToDaily({
			selectionMarkdown: 'An interesting quote',
			pageTitle: 'Source Page',
			pageUrl: 'https://ex.com/article',
			now: WHEN,
		});

		expect(response).toMatchObject({ success: true, id: 'daily1', mode: 'appended', dailyTitle: '2026-09-29' });

		const searchUrl = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
		expect(searchUrl).toBe('https://wiki.example.com/api/documents.search_titles');

		const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(updateUrl).toBe('https://wiki.example.com/api/documents.update');
		const body = JSON.parse(updateInit.body as string);
		expect(body.id).toBe('daily1');
		expect(body.editMode).toBe('append');
		// The appended text is a blockquote + source line, with no frontmatter/property block
		expect(body.text).toContain('> An interesting quote');
		expect(body.text).toContain('[Source Page](https://ex.com/article)');
		expect(body.text).not.toContain('---');
		expect(body.text).not.toContain('```yaml');
		expect(body.text).not.toContain('| Property |');
	});

	test('creates the daily note when none exists', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] })) // search finds nothing
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'new1', title: '2026-09-29', url: '/doc/2026-09-29' } }));

		const response = await handleOutlineExcerptToDaily({
			selectionMarkdown: 'Quote',
			pageTitle: 'P',
			pageUrl: 'https://ex.com',
			now: WHEN,
		});

		expect(response).toMatchObject({ success: true, id: 'new1', mode: 'created', dailyTitle: '2026-09-29' });
		const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(createUrl).toBe('https://wiki.example.com/api/documents.create');
		const body = JSON.parse(createInit.body as string);
		expect(body.title).toBe('2026-09-29');
		expect(body.collectionId).toBe('default-col');
		expect(body.text).toContain('> Quote');
	});

	test('falls back to plain selection text when markdown is empty', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: [] }))
			.mockResolvedValueOnce(jsonResponse({ data: { id: 'n2', title: '2026-09-29', url: '/doc/x' } }));

		const response = await handleOutlineExcerptToDaily({
			selectionMarkdown: '',
			selectionText: 'plain text only',
			pageTitle: 'P',
			pageUrl: 'https://ex.com',
			now: WHEN,
		});

		expect(response).toMatchObject({ success: true, mode: 'created' });
		const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
		expect(body.text).toContain('> plain text only');
	});

	test('maps API failures to a failure response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

		const response = await handleOutlineExcerptToDaily({
			selectionMarkdown: 'Quote',
			pageTitle: 'P',
			pageUrl: 'https://ex.com',
			now: WHEN,
		});

		expect(response.success).toBe(false);
		if (!response.success) {
			expect(response.errorKind).toBe('unauthorized');
		}
	});
});
