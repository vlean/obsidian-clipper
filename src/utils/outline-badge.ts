// Shows a small checkmark badge on the toolbar icon for tabs whose URL is
// already clipped to Outline, so a page's clip state is visible without
// opening the popup. The decision is a pure function so it can be unit tested;
// the wiring in background.ts only reads storage (no network).

import browser from './browser-polyfill';
import { OutlineSettings } from '../types/types';
import { OutlineDocumentMap, lookupMapping, OUTLINE_DOCUMENTS_STORAGE_KEY } from './outline-documents-store';
import { isValidUrl, isBlankPage } from './active-tab-manager';
import { normalizeUrl } from './url-utils';
import { sanitizeOutlineSettings } from './storage-utils';

export const CLIPPED_BADGE_TEXT = '✓';
export const CLIPPED_BADGE_COLOR = '#2e7d32';

export interface ClippedBadgeDecision {
	/** Badge text to show; empty string clears the badge */
	text: string;
	/** Background colour, only meaningful when text is non-empty */
	color: string;
}

const CLEARED: ClippedBadgeDecision = { text: '', color: CLIPPED_BADGE_COLOR };

/**
 * Decides the badge for a tab. Returns the checkmark only when the feature is
 * enabled, Outline has a collection configured, the URL is clippable, and a
 * mapping exists for it on the configured server. Everything else clears it.
 */
export function decideClippedBadge(params: {
	settings: Pick<OutlineSettings, 'showClippedBadge' | 'collectionId' | 'baseUrl'>;
	map: OutlineDocumentMap;
	url: string | undefined;
}): ClippedBadgeDecision {
	const { settings, map, url } = params;
	if (!settings.showClippedBadge || !settings.collectionId) return CLEARED;
	if (!url || !isValidUrl(url) || isBlankPage(url)) return CLEARED;
	const mapping = lookupMapping(map || {}, url, settings.baseUrl);
	return mapping ? { text: CLIPPED_BADGE_TEXT, color: CLIPPED_BADGE_COLOR } : CLEARED;
}

/** True when the MV3 action badge API is available in this browser. */
function actionBadgeAvailable(): boolean {
	const action = (browser as unknown as { action?: unknown }).action;
	return Boolean(action && typeof (action as { setBadgeText?: unknown }).setBadgeText === 'function');
}

/** Applies a badge decision to a single tab, guarding for unsupported browsers. */
export async function applyClippedBadge(tabId: number, decision: ClippedBadgeDecision): Promise<void> {
	if (!actionBadgeAvailable()) return;
	const action = (browser as unknown as {
		action: {
			setBadgeText: (details: { tabId: number; text: string }) => Promise<void> | void;
			setBadgeBackgroundColor?: (details: { tabId: number; color: string }) => Promise<void> | void;
		};
	}).action;
	try {
		if (decision.text && action.setBadgeBackgroundColor) {
			await action.setBadgeBackgroundColor({ tabId, color: decision.color });
		}
		await action.setBadgeText({ tabId, text: decision.text });
	} catch (error) {
		// Tab may have closed, or the browser doesn't support per-tab badges
		console.debug('Failed to set Outline clipped badge:', error);
	}
}

/** Reads the settings + document map needed to decide badges (storage only). */
async function loadBadgeContext(): Promise<{ settings: OutlineSettings; map: OutlineDocumentMap }> {
	const [syncData, localData] = await Promise.all([
		browser.storage.sync.get('outline_settings'),
		browser.storage.local.get(OUTLINE_DOCUMENTS_STORAGE_KEY),
	]);
	const settings = sanitizeOutlineSettings(syncData.outline_settings);
	const rawMap = localData[OUTLINE_DOCUMENTS_STORAGE_KEY];
	const map = rawMap && typeof rawMap === 'object' ? rawMap as OutlineDocumentMap : {};
	return { settings, map };
}

/** Updates the badge for a single tab from current storage (no network). */
export async function updateClippedBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
	try {
		const { settings, map } = await loadBadgeContext();
		await applyClippedBadge(tabId, decideClippedBadge({ settings, map, url }));
	} catch (error) {
		console.debug('Failed to update Outline clipped badge for tab:', error);
	}
}

/**
 * Refreshes badges on every open tab whose normalized URL matches `sourceUrl`.
 * Called after a successful save so a freshly clipped page shows its badge
 * without waiting for a tab switch.
 */
export async function updateClippedBadgesForUrl(sourceUrl: string): Promise<void> {
	if (!sourceUrl) return;
	try {
		const { settings, map } = await loadBadgeContext();
		const target = normalizeUrl(sourceUrl);
		const tabs = await browser.tabs.query({});
		await Promise.all(tabs.map(tab => {
			if (typeof tab.id !== 'number' || !tab.url) return Promise.resolve();
			if (normalizeUrl(tab.url) !== target) return Promise.resolve();
			return applyClippedBadge(tab.id, decideClippedBadge({ settings, map, url: tab.url }));
		}));
	} catch (error) {
		console.debug('Failed to update Outline clipped badges for URL:', error);
	}
}
