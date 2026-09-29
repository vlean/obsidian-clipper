// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Storage backing for getCurrentLanguage/getEffectiveLanguage.
const storageState: Record<string, unknown> = {};
const { sendMessage, getUILanguage } = vi.hoisted(() => ({
	sendMessage: vi.fn(),
	getUILanguage: vi.fn(() => 'en-US'),
}));

vi.mock('./browser-polyfill', () => ({
	default: {
		runtime: {
			getURL: (path: string) => `chrome-extension://mock-id/${path}`,
			sendMessage,
		},
		i18n: {
			getMessage: (key: string) => key, // native fallback returns the key
			getUILanguage,
		},
		extension: {
			getViews: () => [],
		},
	},
}));

vi.mock('./storage-utils', () => ({
	getLocalStorage: async (key: string) => storageState[key],
	setLocalStorage: async (key: string, value: unknown) => { storageState[key] = value; },
}));

import {
	getMessage,
	initializeI18n,
	setLocaleLoader,
	setLanguage,
	__resetLocaleCacheForTests,
} from './i18n';

const EN = {
	greeting: { message: 'Hello' },
	withSub: { message: 'Hi $1, welcome to $2' },
	withPlaceholder: {
		message: 'Count: $NUM$',
		placeholders: { NUM: { content: '42' } },
	},
	onlyEnglish: { message: 'English only' },
};

const FR = {
	greeting: { message: 'Bonjour' },
	withSub: { message: 'Salut $1, bienvenue sur $2' },
	// intentionally missing `onlyEnglish` to test English fallback
};

const bundles: Record<string, any> = { en: EN, fr: FR };

beforeEach(() => {
	for (const k of Object.keys(storageState)) delete storageState[k];
	sendMessage.mockReset();
	getUILanguage.mockReturnValue('en-US');
	__resetLocaleCacheForTests();
	setLocaleLoader(async (code: string) => bundles[code] ?? null);
});

afterEach(() => {
	setLocaleLoader(null);
});

describe('getMessage before init', () => {
	test('falls back to native browser.i18n (returns key) when cache empty', () => {
		expect(getMessage('greeting')).toBe('greeting');
	});
});

describe('getMessage after init', () => {
	test('returns the effective-language string', async () => {
		storageState.language = 'fr';
		await initializeI18n();
		expect(getMessage('greeting')).toBe('Bonjour');
	});

	test('applies $1/$2 substitutions', async () => {
		storageState.language = 'fr';
		await initializeI18n();
		expect(getMessage('withSub', ['Sam', 'Outline'])).toBe('Salut Sam, bienvenue sur Outline');
	});

	test('applies named placeholders', async () => {
		storageState.language = 'en';
		await initializeI18n();
		expect(getMessage('withPlaceholder')).toBe('Count: 42');
	});

	test('falls back to English for keys missing in the current language', async () => {
		storageState.language = 'fr';
		await initializeI18n();
		// `onlyEnglish` is not in FR, so it should resolve from the EN bundle.
		expect(getMessage('onlyEnglish')).toBe('English only');
	});

	test('returns native/key fallback for keys missing everywhere', async () => {
		storageState.language = 'en';
		await initializeI18n();
		expect(getMessage('doesNotExist')).toBe('doesNotExist');
	});
});

describe('language switch', () => {
	test('setLanguage reloads the new language into the cache', async () => {
		storageState.language = 'en';
		await initializeI18n();
		expect(getMessage('greeting')).toBe('Hello');

		await setLanguage('fr');
		expect(getMessage('greeting')).toBe('Bonjour');
	});
});

describe('content-script path via runtime.sendMessage', () => {
	test('uses the default loader which messages the background', async () => {
		// Restore the default (env-detecting) loader; jsdom location is http,
		// so it takes the content-script branch and calls runtime.sendMessage.
		setLocaleLoader(null);
		sendMessage.mockResolvedValue({ success: true, messages: FR });
		storageState.language = 'fr';

		await initializeI18n();

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'getLocaleMessages', code: 'fr' })
		);
		expect(getMessage('greeting')).toBe('Bonjour');
	});

	test('failure to load falls back to English/native without throwing', async () => {
		setLocaleLoader(null);
		// Background reports the locale is unavailable.
		sendMessage.mockResolvedValue({ success: false });
		storageState.language = 'fr';

		await expect(initializeI18n()).resolves.toBeUndefined();
		// No bundle cached at all → getMessage returns the native/key fallback.
		expect(getMessage('greeting')).toBe('greeting');
	});
});
