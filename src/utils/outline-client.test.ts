import { describe, expect, test, vi } from 'vitest';
import {
	OutlineApiError,
	createOutlineDocument,
	getOutlineAuthInfo,
	getOutlineDocumentUrl,
	getOutlineErrorMessageKey,
	listOutlineCollections,
	normalizeOutlineBaseUrl,
	outlineRequest,
} from './outline-client';

const config = { baseUrl: 'https://wiki.example.com', apiKey: 'ol_api_test' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

describe('normalizeOutlineBaseUrl', () => {
	test('strips trailing slashes and /api suffix', () => {
		expect(normalizeOutlineBaseUrl('https://wiki.example.com/')).toBe('https://wiki.example.com');
		expect(normalizeOutlineBaseUrl('https://wiki.example.com/api/')).toBe('https://wiki.example.com');
		expect(normalizeOutlineBaseUrl('https://example.com/outline/')).toBe('https://example.com/outline');
	});

	test('adds https when protocol is missing', () => {
		expect(normalizeOutlineBaseUrl('wiki.example.com')).toBe('https://wiki.example.com');
	});

	test('allows http for local self-hosted instances', () => {
		expect(normalizeOutlineBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
	});

	test('rejects empty and unsupported URLs', () => {
		expect(() => normalizeOutlineBaseUrl('')).toThrow(OutlineApiError);
		expect(() => normalizeOutlineBaseUrl('ftp://example.com')).toThrow(OutlineApiError);
		expect(() => normalizeOutlineBaseUrl('javascript://alert(1)')).toThrow(OutlineApiError);
	});
});

describe('getOutlineDocumentUrl', () => {
	test('joins relative document paths with the base URL', () => {
		expect(getOutlineDocumentUrl('https://wiki.example.com/', '/doc/hello-abc123'))
			.toBe('https://wiki.example.com/doc/hello-abc123');
	});

	test('returns absolute URLs unchanged', () => {
		expect(getOutlineDocumentUrl('https://wiki.example.com', 'https://other.example.com/doc/x'))
			.toBe('https://other.example.com/doc/x');
	});
});

describe('outlineRequest', () => {
	test('sends a POST with bearer auth and JSON body', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { ok: true } }));
		const result = await outlineRequest(config, 'documents.info', { id: 'x' }, { fetchImpl });

		expect(result).toEqual({ data: { ok: true } });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://wiki.example.com/api/documents.info');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ol_api_test');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
		expect(JSON.parse(init.body as string)).toEqual({ id: 'x' });
	});

	test('fails fast without an API key', async () => {
		const fetchImpl = vi.fn();
		await expect(outlineRequest({ ...config, apiKey: ' ' }, 'auth.info', {}, { fetchImpl }))
			.rejects.toMatchObject({ kind: 'config' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test.each([
		[401, 'unauthorized'],
		[403, 'forbidden'],
		[404, 'notFound'],
		[400, 'validation'],
		[500, 'server'],
	])('maps HTTP %i to %s', async (status, kind) => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: 'err', message: 'Something failed' }, status));
		await expect(outlineRequest(config, 'auth.info', {}, { fetchImpl }))
			.rejects.toMatchObject({ kind, status, message: 'Something failed' });
	});

	test('wraps network errors', async () => {
		const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
		await expect(outlineRequest(config, 'auth.info', {}, { fetchImpl }))
			.rejects.toMatchObject({ kind: 'network', message: 'Failed to fetch' });
	});

	test('retries once on 429 honouring Retry-After', async () => {
		const sleep = vi.fn(async () => {});
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: false }, 429, { 'Retry-After': '2' }))
			.mockResolvedValueOnce(jsonResponse({ data: 'ok' }));

		const result = await outlineRequest(config, 'documents.create', {}, { fetchImpl, sleep });
		expect(result).toEqual({ data: 'ok' });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(2000);
	});

	test('caps the retry delay', async () => {
		const sleep = vi.fn(async () => {});
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({}, 429, { 'Retry-After': '600' }))
			.mockResolvedValueOnce(jsonResponse({ data: 'ok' }));
		await outlineRequest(config, 'documents.create', {}, { fetchImpl, sleep, maxRetryDelaySeconds: 5 });
		expect(sleep).toHaveBeenCalledWith(5000);
	});

	test('gives up after the retry budget on repeated 429', async () => {
		const sleep = vi.fn(async () => {});
		const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Rate limited' }, 429, { 'Retry-After': '1' }));
		await expect(outlineRequest(config, 'documents.create', {}, { fetchImpl, sleep, maxRetries: 1 }))
			.rejects.toMatchObject({ kind: 'rateLimited' });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	test('rejects non-JSON success responses', async () => {
		const fetchImpl = vi.fn(async () => new Response('<html>login</html>', { status: 200 }));
		await expect(outlineRequest(config, 'auth.info', {}, { fetchImpl }))
			.rejects.toMatchObject({ kind: 'server' });
	});
});

describe('API helpers', () => {
	test('getOutlineAuthInfo extracts user and team names', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { user: { name: 'Jane' }, team: { name: 'Acme' } } }));
		await expect(getOutlineAuthInfo(config, { fetchImpl })).resolves.toEqual({ userName: 'Jane', teamName: 'Acme' });
	});

	test('listOutlineCollections paginates until a short page', async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `Collection ${i}` }));
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ data: fullPage }))
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'last', name: 'Last' }] }));

		const collections = await listOutlineCollections(config, { fetchImpl });
		expect(collections).toHaveLength(101);
		expect(collections[100]).toEqual({ id: 'last', name: 'Last' });
		const secondBody = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
		expect(secondBody).toEqual({ limit: 100, offset: 100 });
	});

	test('createOutlineDocument sends title, text, collection and publish flag', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: 'doc1', title: 'T', url: '/doc/t-abc' } }));
		const doc = await createOutlineDocument(config, {
			title: 'T', text: 'Body', collectionId: 'col1', publish: true,
		}, { fetchImpl });

		expect(doc).toEqual({ id: 'doc1', title: 'T', url: '/doc/t-abc' });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://wiki.example.com/api/documents.create');
		expect(JSON.parse(init.body as string)).toEqual({
			title: 'T', text: 'Body', collectionId: 'col1', publish: true,
		});
	});

	test('createOutlineDocument requires a collection', async () => {
		const fetchImpl = vi.fn();
		await expect(createOutlineDocument(config, { title: 'T', text: '', collectionId: '', publish: true }, { fetchImpl }))
			.rejects.toMatchObject({ kind: 'config' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('getOutlineErrorMessageKey', () => {
	test('maps kinds to message keys', () => {
		expect(getOutlineErrorMessageKey('unauthorized')).toBe('outlineErrorUnauthorized');
		expect(getOutlineErrorMessageKey('validation')).toBe('outlineErrorGeneric');
		expect(getOutlineErrorMessageKey(undefined)).toBe('outlineErrorGeneric');
	});
});
