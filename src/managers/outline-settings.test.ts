// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Template } from '../types/types';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('../utils/browser-polyfill', () => ({
	default: {
		runtime: { sendMessage },
		storage: {
			local: { get: async () => ({}), set: async () => {} },
			sync: { get: async () => ({}), set: async () => {} },
		},
		i18n: { getMessage: (key: string) => key },
	},
}));

import { generalSettings, DEFAULT_OUTLINE_SETTINGS } from '../utils/storage-utils';
import { populateTemplateOutlineCollection } from './outline-settings';

function template(overrides: Partial<Template> = {}): Template {
	return {
		id: 't1', name: 'T', behavior: 'create', noteNameFormat: '', path: '',
		noteContentFormat: '', properties: [], ...overrides,
	};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function options(): Array<[string, string]> {
	const select = document.getElementById('template-outline-collection') as HTMLSelectElement;
	return Array.from(select.options).map(o => [o.value, o.textContent ?? '']);
}

beforeEach(() => {
	document.body.innerHTML = `<div id="template-outline-collection-container" hidden>
		<select id="template-outline-collection"></select>
	</div>`;
	sendMessage.mockReset();
	generalSettings.outline = { ...DEFAULT_OUTLINE_SETTINGS, baseUrl: 'https://wiki.example.com', collectionId: 'inbox', collectionName: 'Inbox' };
});

describe('populateTemplateOutlineCollection', () => {
	test('stays hidden when Outline has no default collection', () => {
		generalSettings.outline = { ...generalSettings.outline, collectionId: '' };
		populateTemplateOutlineCollection(template());
		expect(document.getElementById('template-outline-collection-container')!.hidden).toBe(true);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('lists collections with a default option and selects the saved one', async () => {
		sendMessage.mockResolvedValue({
			success: true, userName: 'u', teamName: 't',
			collections: [{ id: 'inbox', name: 'Inbox' }, { id: 'reading', name: 'Reading' }],
		});
		populateTemplateOutlineCollection(template({ outlineCollectionId: 'reading' }));
		expect(document.getElementById('template-outline-collection-container')!.hidden).toBe(false);

		await flush();
		expect(options().map(([value]) => value)).toEqual(['', 'inbox', 'reading']);
		expect((document.getElementById('template-outline-collection') as HTMLSelectElement).value).toBe('reading');
	});

	test('keeps an unknown saved collection selectable when collections fail to load', async () => {
		sendMessage.mockResolvedValue({ success: false, errorKind: 'network', error: 'offline' });
		populateTemplateOutlineCollection(template({ id: 't2', outlineCollectionId: 'gone', outlineCollectionName: 'Archive' }));
		await flush();
		expect(options()).toContainEqual(['gone', 'Archive']);
		expect((document.getElementById('template-outline-collection') as HTMLSelectElement).value).toBe('gone');
	});
});
