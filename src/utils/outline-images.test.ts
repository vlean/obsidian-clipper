import { describe, expect, test, vi } from 'vitest';
import {
	findMarkdownImageUrls,
	isUploadableImageUrl,
	replaceMarkdownImageUrls,
	uploadOutlineImages,
} from './outline-images';
import { withDocState, readDocState } from './outline-doc-state';

const config = { baseUrl: 'https://wiki.example.com', apiKey: 'ol_api_test' };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('findMarkdownImageUrls', () => {
	test('finds inline images with titles and angle brackets, deduplicated', () => {
		const md = [
			'![a](https://x.com/a.png)',
			'![b](https://x.com/b.png "Title") and ![a again](https://x.com/a.png)',
			'![c](<https://x.com/c.png>)',
			'[![linked](https://x.com/d.png)](https://x.com/page)',
		].join('\n');
		expect(findMarkdownImageUrls(md)).toEqual([
			'https://x.com/a.png', 'https://x.com/b.png', 'https://x.com/c.png', 'https://x.com/d.png',
		]);
	});

	test('ignores links and images inside code', () => {
		const md = '[not image](https://x.com/a.png)\n`![x](https://x.com/inline.png)`\n```\n![y](https://x.com/fenced.png)\n```';
		expect(findMarkdownImageUrls(md)).toEqual([]);
	});
});

describe('replaceMarkdownImageUrls', () => {
	test('rewrites only mapped image URLs and keeps alt/title', () => {
		const md = '![a](https://x.com/a.png "T")\n![b](https://x.com/b.png)\n[link](https://x.com/a.png)';
		expect(replaceMarkdownImageUrls(md, { 'https://x.com/a.png': '/api/attachments.redirect?id=1' })).toBe(
			'![a](/api/attachments.redirect?id=1 "T")\n![b](https://x.com/b.png)\n[link](https://x.com/a.png)'
		);
	});

	test('leaves code untouched', () => {
		const md = '```\n![a](https://x.com/a.png)\n```';
		expect(replaceMarkdownImageUrls(md, { 'https://x.com/a.png': 'new' })).toBe(md);
	});
});

describe('isUploadableImageUrl', () => {
	test('accepts remote http(s) images only', () => {
		expect(isUploadableImageUrl('https://cdn.example.org/a.png', config.baseUrl)).toBe(true);
		expect(isUploadableImageUrl('http://cdn.example.org/a.png', config.baseUrl)).toBe(true);
		expect(isUploadableImageUrl('data:image/png;base64,AAA', config.baseUrl)).toBe(false);
		expect(isUploadableImageUrl('/relative.png', config.baseUrl)).toBe(false);
		expect(isUploadableImageUrl('https://wiki.example.com/api/attachments.redirect?id=1', config.baseUrl)).toBe(false);
	});
});

describe('uploadOutlineImages', () => {
	test('uploads new images, reuses cached ones and rewrites the text', async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(init!.body as string);
			return jsonResponse({ data: { url: `/api/attachments.redirect?id=${body.url.split('/').pop()}` } });
		});
		const md = '![a](https://x.com/a.png)\n![b](https://x.com/b.png)\n![d](data:image/png;base64,AA)';
		const result = await uploadOutlineImages(config, md, {
			documentId: 'doc1',
			attachments: { 'https://x.com/b.png': '/api/attachments.redirect?id=cached' },
		}, { fetchImpl });

		expect(result.text).toBe('![a](/api/attachments.redirect?id=a.png)\n![b](/api/attachments.redirect?id=cached)\n![d](data:image/png;base64,AA)');
		expect(result).toMatchObject({ uploaded: 1, reused: 1, failed: 0, skipped: 0 });
		expect(result.attachments['https://x.com/a.png']).toBe('/api/attachments.redirect?id=a.png');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://wiki.example.com/api/attachments.createFromUrl');
		expect(JSON.parse(init!.body as string)).toEqual({ url: 'https://x.com/a.png', documentId: 'doc1' });
	});

	// Outline 1.10.x answers 200 with an empty attachment when the server-side
	// download/storage fails; the URL then points at nothing (broken image).
	test('treats an empty attachment as failed, keeps the original URL and cleans it up', async () => {
		const fetchImpl = vi.fn(async (url: string) => url.endsWith('attachments.delete')
			? jsonResponse({ success: true })
			: jsonResponse({ data: { id: 'att1', url: '/api/attachments.redirect?id=att1', size: '0', contentType: 'application/octet-stream' } }));
		const md = '![a](https://pbs.twimg.com/media/a.jpg)';
		const result = await uploadOutlineImages(config, md, { documentId: 'doc1' }, { fetchImpl });
		expect(result.text).toBe(md);
		expect(result).toMatchObject({ uploaded: 0, failed: 1 });
		expect(result.attachments).toEqual({});
		expect(fetchImpl.mock.calls.map(call => (call[0] as string).split('/api/')[1])).toEqual([
			'attachments.createFromUrl', 'attachments.delete',
		]);
	});

	test('keeps the original URL when an upload fails', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ message: 'Could not fetch' }, 400))
			.mockResolvedValueOnce(jsonResponse({ data: { url: '/att/2' } }));
		const md = '![a](https://x.com/a.png) ![b](https://x.com/b.png)';
		const result = await uploadOutlineImages(config, md, { documentId: 'doc1', concurrency: 1 }, { fetchImpl });
		expect(result.text).toBe('![a](https://x.com/a.png) ![b](/att/2)');
		expect(result).toMatchObject({ uploaded: 1, failed: 1 });
	});

	test('stops uploading after an authorization error', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, 403));
		const md = '![a](https://x.com/a.png) ![b](https://x.com/b.png) ![c](https://x.com/c.png)';
		const result = await uploadOutlineImages(config, md, { documentId: 'doc1', concurrency: 1 }, { fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ uploaded: 0, failed: 3 });
		expect(result.text).toBe(md);
	});

	test('caps the number of uploads per clip', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ data: { url: '/att' } }));
		const md = Array.from({ length: 5 }, (_, i) => `![${i}](https://x.com/${i}.png)`).join('\n');
		const result = await uploadOutlineImages(config, md, { documentId: 'doc1', maxImages: 2 }, { fetchImpl });
		expect(result).toMatchObject({ uploaded: 2, skipped: 3 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	test('does nothing when there are no images', async () => {
		const fetchImpl = vi.fn();
		const result = await uploadOutlineImages(config, 'text only', { documentId: 'doc1' }, { fetchImpl });
		expect(result.text).toBe('text only');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('document sync state', () => {
	test('reads sanitized state and defaults for unknown documents', () => {
		const map = { d1: { updatedAt: 'x', uploads: { a: 'b', bad: 1 }, comments: {} } } as any;
		expect(readDocState(map, 'd1')).toEqual({ updatedAt: 'x', uploads: { a: 'b' }, comments: {} });
		expect(readDocState(map, 'missing')).toEqual({ updatedAt: '', uploads: {}, comments: {} });
	});

	test('ignores the legacy attachments cache, which may hold empty attachments', () => {
		const map = { d1: { updatedAt: 'x', attachments: { 'https://x.com/a.png': '/api/attachments.redirect?id=empty' }, comments: { k: 'c' } } } as any;
		expect(readDocState(map, 'd1')).toEqual({ updatedAt: 'x', uploads: {}, comments: { k: 'c' } });
	});

	test('drops the least recently updated documents past the cap', () => {
		const state = (updatedAt: string) => ({ updatedAt, uploads: {}, comments: {} });
		let map = withDocState({}, 'a', state('2026-01-01'), 2);
		map = withDocState(map, 'b', state('2026-01-03'), 2);
		map = withDocState(map, 'c', state('2026-01-02'), 2);
		expect(Object.keys(map).sort()).toEqual(['b', 'c']);
	});
});
