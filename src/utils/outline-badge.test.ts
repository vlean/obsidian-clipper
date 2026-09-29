import { describe, test, expect, vi } from 'vitest';
import { decideClippedBadge, CLIPPED_BADGE_TEXT, CLIPPED_BADGE_COLOR } from './outline-badge';
import { OutlineDocumentMap } from './outline-documents-store';

vi.mock('./browser-polyfill', () => ({
	default: {
		storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}) } },
		tabs: { query: async () => [] },
	},
}));

const baseSettings = { showClippedBadge: true, collectionId: 'col-1', baseUrl: 'https://wiki.example.com' };

function mapFor(url: string): OutlineDocumentMap {
	// Keys are normalized page URLs; use the raw URL here since the test URLs are already normal
	return {
		[url]: { documentId: 'd1', baseUrl: 'https://wiki.example.com', url: 'https://wiki.example.com/doc/d1', title: 'Doc', updatedAt: '' },
	};
}

describe('decideClippedBadge', () => {
	test('shows the checkmark for a mapped, clippable URL', () => {
		const url = 'https://example.com/post';
		const decision = decideClippedBadge({ settings: baseSettings, map: mapFor(url), url });
		expect(decision).toEqual({ text: CLIPPED_BADGE_TEXT, color: CLIPPED_BADGE_COLOR });
	});

	test('clears when no mapping exists for the URL', () => {
		const decision = decideClippedBadge({ settings: baseSettings, map: {}, url: 'https://example.com/post' });
		expect(decision.text).toBe('');
	});

	test('clears when the feature is disabled', () => {
		const url = 'https://example.com/post';
		const decision = decideClippedBadge({ settings: { ...baseSettings, showClippedBadge: false }, map: mapFor(url), url });
		expect(decision.text).toBe('');
	});

	test('clears when no collection is configured', () => {
		const url = 'https://example.com/post';
		const decision = decideClippedBadge({ settings: { ...baseSettings, collectionId: '' }, map: mapFor(url), url });
		expect(decision.text).toBe('');
	});

	test('clears for a mapping on a different Outline server', () => {
		const url = 'https://example.com/post';
		const decision = decideClippedBadge({
			settings: { ...baseSettings, baseUrl: 'https://other.example.com' },
			map: mapFor(url),
			url,
		});
		expect(decision.text).toBe('');
	});

	test('clears for blank or invalid URLs', () => {
		const url = 'https://example.com/post';
		expect(decideClippedBadge({ settings: baseSettings, map: mapFor(url), url: undefined }).text).toBe('');
		expect(decideClippedBadge({ settings: baseSettings, map: mapFor(url), url: 'about:blank' }).text).toBe('');
	});

	test('matches regardless of tracking query params (URL normalization)', () => {
		// Mapping is stored under the normalized URL; a tracked variant should still match
		const decision = decideClippedBadge({
			settings: baseSettings,
			map: mapFor('https://example.com/post'),
			url: 'https://example.com/post?utm_source=x',
		});
		expect(decision.text).toBe(CLIPPED_BADGE_TEXT);
	});
});
