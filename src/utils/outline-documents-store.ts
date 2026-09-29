// Remembers which Outline document was created from which page URL, so the
// next clip of the same page updates that document instead of creating a new
// one. Stored in storage.local (per device), keyed by normalized page URL.

import browser from './browser-polyfill';
import { normalizeUrl } from './url-utils';
import { normalizeOutlineBaseUrl } from './outline-client';

export const OUTLINE_DOCUMENTS_STORAGE_KEY = 'outline_documents';
export const OUTLINE_DOCUMENTS_MAX_ENTRIES = 5000;

export interface OutlineDocumentMapping {
	documentId: string;
	/** Outline server the document lives on; mappings from other servers are ignored */
	baseUrl: string;
	/** Absolute link to the document */
	url: string;
	title: string;
	updatedAt: string;
}

export type OutlineDocumentMap = Record<string, OutlineDocumentMapping>;

function safeBaseUrl(baseUrl: string): string {
	try {
		return normalizeOutlineBaseUrl(baseUrl);
	} catch {
		return baseUrl;
	}
}

export function lookupMapping(map: OutlineDocumentMap, pageUrl: string, baseUrl: string): OutlineDocumentMapping | null {
	if (!pageUrl) return null;
	const entry = map[normalizeUrl(pageUrl)];
	if (!entry || typeof entry.documentId !== 'string') return null;
	return safeBaseUrl(entry.baseUrl) === safeBaseUrl(baseUrl) ? entry : null;
}

/** Returns a new map with the entry set, dropping the oldest entries past the cap. */
export function withMapping(
	map: OutlineDocumentMap,
	pageUrl: string,
	mapping: OutlineDocumentMapping,
	maxEntries = OUTLINE_DOCUMENTS_MAX_ENTRIES,
): OutlineDocumentMap {
	const next: OutlineDocumentMap = { ...map, [normalizeUrl(pageUrl)]: { ...mapping, baseUrl: safeBaseUrl(mapping.baseUrl) } };
	const keys = Object.keys(next);
	if (keys.length <= maxEntries) return next;
	keys
		.sort((a, b) => (next[a].updatedAt || '').localeCompare(next[b].updatedAt || ''))
		.slice(0, keys.length - maxEntries)
		.forEach(key => delete next[key]);
	return next;
}

export function withoutMapping(map: OutlineDocumentMap, pageUrl: string): OutlineDocumentMap {
	const next = { ...map };
	delete next[normalizeUrl(pageUrl)];
	return next;
}

async function readMap(): Promise<OutlineDocumentMap> {
	const result = await browser.storage.local.get(OUTLINE_DOCUMENTS_STORAGE_KEY);
	const value = result[OUTLINE_DOCUMENTS_STORAGE_KEY];
	return value && typeof value === 'object' ? value as OutlineDocumentMap : {};
}

export async function getOutlineDocumentMapping(pageUrl: string, baseUrl: string): Promise<OutlineDocumentMapping | null> {
	return lookupMapping(await readMap(), pageUrl, baseUrl);
}

export async function setOutlineDocumentMapping(pageUrl: string, mapping: OutlineDocumentMapping): Promise<void> {
	if (!pageUrl) return;
	const map = await readMap();
	await browser.storage.local.set({ [OUTLINE_DOCUMENTS_STORAGE_KEY]: withMapping(map, pageUrl, mapping) });
}

export async function removeOutlineDocumentMapping(pageUrl: string): Promise<void> {
	if (!pageUrl) return;
	const map = await readMap();
	await browser.storage.local.set({ [OUTLINE_DOCUMENTS_STORAGE_KEY]: withoutMapping(map, pageUrl) });
}
