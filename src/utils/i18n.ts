import dayjs from 'dayjs';
import browser from './browser-polyfill';
import { getLocalStorage, setLocalStorage } from './storage-utils';
import DOMPurify from 'dompurify';

// Import dayjs locales that match our supported languages
import 'dayjs/locale/ar';
import 'dayjs/locale/ca';
import 'dayjs/locale/cs';
import 'dayjs/locale/da';
import 'dayjs/locale/de';
import 'dayjs/locale/el';
import 'dayjs/locale/en';
import 'dayjs/locale/es';
import 'dayjs/locale/fa';
import 'dayjs/locale/fi';
import 'dayjs/locale/fr';
import 'dayjs/locale/he';
import 'dayjs/locale/hi';
import 'dayjs/locale/hu';
import 'dayjs/locale/id';
import 'dayjs/locale/it';
import 'dayjs/locale/ja';
import 'dayjs/locale/ko';
import 'dayjs/locale/nb';
import 'dayjs/locale/nl';
import 'dayjs/locale/pl';
import 'dayjs/locale/pt';
import 'dayjs/locale/ro';
import 'dayjs/locale/ru';
import 'dayjs/locale/sv';
import 'dayjs/locale/th';
import 'dayjs/locale/tl-ph';
import 'dayjs/locale/tr';
import 'dayjs/locale/uk';
import 'dayjs/locale/vi';
import 'dayjs/locale/zh-tw';
import 'dayjs/locale/zh';

function convertToLocaleCode(locale: string): string {
	// Convert locale codes like 'pt_BR' to 'pt-br'
	const lowercaseLocale = locale.toLowerCase();

	const specialCases: { [key: string]: string } = {
		'tl': 'tl-ph',
		'no': 'nb'
	};
	
	if (specialCases[lowercaseLocale]) {
		return specialCases[lowercaseLocale];
	}
	
	return lowercaseLocale.replace('_', '-');
}

export function setDayjsLocale(locale: string): void {
	const dayjsLocale = convertToLocaleCode(locale);
	try {
		dayjs.locale(dayjsLocale);
	} catch (error) {
		console.warn(`Failed to set dayjs locale for ${locale}, falling back to English`, error);
		dayjs.locale('en');
	}
}

let currentLanguage: string | null = null;

// Shape of a single locale's messages.json (Chrome extension i18n format).
interface MessageEntry {
	message: string;
	placeholders?: { [key: string]: { content: string } };
}
type MessageBundle = { [key: string]: MessageEntry };

// In-memory cache of loaded locale bundles, keyed by language code. Populated
// on demand by initializeI18n(); getMessage() only reads from here so it can
// stay synchronous. Nothing is bundled at build time — the JSON is loaded at
// runtime (fetch on extension pages, background message from content scripts).
const loadedMessages: { [code: string]: MessageBundle } = {};

/**
 * Loads a locale bundle at runtime.
 *
 * - Extension pages (popup, settings, highlights, reader page) can read the
 *   packaged JSON directly via fetch(runtime.getURL(...)).
 * - Content scripts run in the page's origin and cannot fetch extension URLs
 *   (and we deliberately do NOT expose _locales as web_accessible_resources),
 *   so they ask the background page, which fetches and caches it.
 *
 * Tests can replace this with setLocaleLoader() since fetch(runtime.getURL)
 * doesn't work under node/jsdom.
 */
type LocaleLoader = (code: string) => Promise<MessageBundle | null>;

// True when running on an extension page (popup/settings/etc.), where we can
// fetch packaged resources directly. Content scripts run on http(s) pages.
function isExtensionPageContext(): boolean {
	try {
		return typeof location !== 'undefined'
			&& (location.protocol === 'chrome-extension:'
				|| location.protocol === 'moz-extension:'
				|| location.protocol === 'safari-web-extension:');
	} catch {
		return false;
	}
}

const defaultLocaleLoader: LocaleLoader = async (code: string) => {
	try {
		if (isExtensionPageContext()) {
			const url = browser.runtime.getURL(`_locales/${code}/messages.json`);
			const response = await fetch(url);
			if (!response.ok) return null;
			return await response.json() as MessageBundle;
		}
		// Content script: delegate to the background page.
		const result = await browser.runtime.sendMessage({ action: 'getLocaleMessages', code }) as
			{ success?: boolean; messages?: MessageBundle } | undefined;
		if (result && result.success && result.messages) {
			return result.messages;
		}
		return null;
	} catch (error) {
		console.warn(`Failed to load messages for language ${code}`, error);
		return null;
	}
};

let localeLoader: LocaleLoader = defaultLocaleLoader;

/**
 * Override the locale loader. Used by tests (where fetch/runtime messaging is
 * unavailable) to supply locale bundles directly.
 */
export function setLocaleLoader(loader: LocaleLoader | null): void {
	localeLoader = loader ?? defaultLocaleLoader;
}

/** Test-only: clear the in-memory locale cache and reset current language. */
export function __resetLocaleCacheForTests(): void {
	for (const key of Object.keys(loadedMessages)) {
		delete loadedMessages[key];
	}
	currentLanguage = null;
}

/**
 * Loads a locale bundle into the module cache if not already present.
 * Returns the cached bundle (or null if loading failed).
 */
async function ensureLocaleLoaded(code: string): Promise<MessageBundle | null> {
	if (loadedMessages[code]) {
		return loadedMessages[code];
	}
	const bundle = await localeLoader(code);
	if (bundle) {
		loadedMessages[code] = bundle;
	}
	return bundle;
}

// Return raw values, translation will be handled by the i18n system
export function getAvailableLanguages(): { code: string; name: string }[] {
	return [
		{ code: '', name: 'systemDefault' },
		{ code: 'ar', name: 'العربية' },
		{ code: 'bn', name: 'বাংলা' },
		{ code: 'ca', name: 'Català' },
		{ code: 'cs', name: 'Čeština' },
		{ code: 'da', name: 'Dansk' },
		{ code: 'de', name: 'Deutsch' },
		{ code: 'el', name: 'Ελληνικά' },
		{ code: 'en', name: 'English' },
		{ code: 'es', name: 'Español' },
		{ code: 'fa', name: 'فارسی' },
		{ code: 'fi', name: 'Suomi' },
		{ code: 'fr', name: 'Français' },
		{ code: 'he', name: 'עברית' },
		{ code: 'hi', name: 'हिन्दी' },
		{ code: 'hu', name: 'Magyar' },
		{ code: 'id', name: 'Bahasa Indonesia' },
		{ code: 'it', name: 'Italiano' },
		{ code: 'ja', name: '日本語' },
		{ code: 'km', name: 'ខ្មែរ' },
		{ code: 'ko', name: '한국어' },
		{ code: 'nl', name: 'Nederlands' },
		{ code: 'no', name: 'Norsk' },
		{ code: 'pl', name: 'Polski' },
		{ code: 'pt', name: 'Português' },
		{ code: 'pt_BR', name: 'Português do Brasil' },
		{ code: 'ro', name: 'Română' },
		{ code: 'ru', name: 'Русский' },
		{ code: 'sk', name: 'Slovenčina' },
		{ code: 'sv', name: 'Svenska' },
		{ code: 'th', name: 'ไทย' },
		{ code: 'tl', name: 'Tagalog' },
		{ code: 'tr', name: 'Türkçe' },
		{ code: 'uk', name: 'Українська' },
		{ code: 'vi', name: 'Tiếng Việt' },
		{ code: 'zh_CN', name: '简体中文' },
		{ code: 'zh_TW', name: '繁體中文' }
	];
}

export async function getCurrentLanguage(): Promise<string> {
	const savedLanguage = await getLocalStorage('language');
	if (savedLanguage && savedLanguage !== '') {
		return savedLanguage;
	}
	return ''; // Return empty string for system default
}

/**
 * The language code currently used to resolve messages (e.g. 'en', 'zh_CN').
 * Falls back to 'en' before i18n has been initialised.
 */
export function getCurrentUILanguage(): string {
	return currentLanguage || 'en';
}

/** True when the UI is displayed in a Chinese locale (zh_CN, zh_TW, ...). */
export function isChineseUILanguage(): boolean {
	return getCurrentUILanguage().toLowerCase().startsWith('zh');
}

export async function setLanguage(language: string): Promise<void> {
	await setLocalStorage('language', language);
	// Load the newly selected language so the current page re-translates
	// correctly (settings.ts re-runs setupLanguageAndDirection + translatePage
	// after switching, without a full page reload).
	await initializeI18n();
	// Reload all extension pages to apply the new language
	const extensionPages = await browser.extension.getViews();
	extensionPages.forEach(page => {
		page.location.reload();
	});
}

// Helper function to match browser language to available languages
export function matchBrowserLanguage(): string {
	const browserLang = browser.i18n.getUILanguage().toLowerCase().split('-')[0]; // Get base language code
	const availableLangs = getAvailableLanguages()
		.map(lang => lang.code)
		.filter(code => code !== ''); // Exclude system default option

	// If browser language matches an available language, use it
	if (availableLangs.includes(browserLang)) {
		return browserLang;
	}

	// Otherwise default to English
	return 'en';
}

export async function initializeI18n() {
	const { code } = await getEffectiveLanguage();
	currentLanguage = code;
	setDayjsLocale(code);
	// Load the effective language and English fallback into the module cache so
	// getMessage() can resolve strings synchronously. English is always loaded
	// as the fallback for missing keys. Failures fall back to browser.i18n.
	await Promise.all([
		ensureLocaleLoaded(code),
		code !== 'en' ? ensureLocaleLoaded('en') : Promise.resolve(loadedMessages['en'] ?? null),
	]);
}

export function getMessage(messageName: string, substitutions?: string | string[]): string {
	try {
		// Apply $1.. substitutions and $name$ placeholders to a message entry.
		const render = (messageObj: MessageEntry): string => {
			let text = messageObj.message;
			if (substitutions) {
				const subsArray = Array.isArray(substitutions) ? substitutions : [substitutions];
				subsArray.forEach((sub, index) => {
					text = text.replace(`$${index + 1}`, sub);
				});
			}
			if (messageObj.placeholders) {
				Object.entries(messageObj.placeholders).forEach(([key, value]) => {
					const placeholder = `$${key}$`;
					const content = (value as { content: string }).content;
					text = text.replace(placeholder, content);
				});
			}
			return text;
		};

		// Read messages for the current language from the in-memory cache.
		const code = currentLanguage || 'en';
		const messages = loadedMessages[code];
		const messageObj = messages ? messages[messageName] : undefined;

		if (!messageObj) {
			// If message not found in current language, try English
			if (code !== 'en') {
				const enMessages = loadedMessages['en'];
				const enMessageObj = enMessages ? enMessages[messageName] : undefined;
				if (enMessageObj) {
					return render(enMessageObj);
				}
			}
			return browser.i18n.getMessage(messageName, substitutions) || messageName;
		}

		return render(messageObj);
	} catch (error) {
		console.warn(`Failed to resolve message for language ${currentLanguage}`, error);
		return browser.i18n.getMessage(messageName, substitutions) || messageName;
	}
}

export async function translatePage() {
	await initializeI18n();

	// Translate elements with data-i18n attribute
	document.querySelectorAll('[data-i18n]').forEach(element => {
		const key = element.getAttribute('data-i18n');
		if (key) {
			const translation = getMessage(key);
			if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
				element.placeholder = translation;
			} else {
				// Sanitize HTML content before inserting
				element.replaceChildren(DOMPurify.sanitize(translation, { RETURN_DOM_FRAGMENT: true }));
			}
		}
	});

	// Translate elements with data-i18n-title attribute
	document.querySelectorAll('[data-i18n-title]').forEach(element => {
		const key = element.getAttribute('data-i18n-title');
		if (key) {
			element.setAttribute('title', getMessage(key));
		}
	});
}

// Helper function to get the effective language
export async function getEffectiveLanguage(): Promise<{ code: string; isRTL: boolean }> {
	const currentLang = await getCurrentLanguage();
	const languageCode = currentLang && currentLang !== '' ? currentLang : matchBrowserLanguage();
	return {
		code: languageCode,
		isRTL: isRTLLanguage(languageCode)
	};
}

export function isRTLLanguage(languageCode: string): boolean {
	// List of RTL language codes
	const rtlLanguages = [
		'ar',  // Arabic
		'arc', // Aramaic
		'ckb', // Central Kurdish (Sorani)
		'dv',  // Divehi/Maldivian
		'fa',  // Persian/Farsi
		'ha',  // Hausa (when written in Arabic script)
		'he',  // Hebrew
		'khw', // Khowar
		'ks',  // Kashmiri
		'ku',  // Kurdish (in Arabic script)
		'ps',  // Pashto
		'sd',  // Sindhi
		'syr', // Syriac
		'ur',  // Urdu
		'uz-AF', // Uzbek (in Afghanistan)
		'yi'   // Yiddish
	];
	return rtlLanguages.includes(languageCode.toLowerCase().split('-')[0]);
}

// Helper function to set up language and RTL support
export async function setupLanguageAndDirection(): Promise<void> {
	const { code: languageCode, isRTL } = await getEffectiveLanguage();

	// Set HTML lang attribute
	document.documentElement.setAttribute('lang', languageCode);

	// Set RTL support
	if (isRTL) {
		document.documentElement.classList.add('mod-rtl');
		document.documentElement.setAttribute('dir', 'rtl');
	} else {
		document.documentElement.classList.remove('mod-rtl');
		document.documentElement.removeAttribute('dir');
	}
}