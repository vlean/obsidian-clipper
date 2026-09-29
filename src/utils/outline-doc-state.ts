// Per-document sync state kept in storage.local, keyed by Outline document id:
// - uploads: source image URL → Outline attachment URL, so re-clipping a
//   page reuses uploads instead of storing every image again. Scoped per
//   document because Outline checks attachment access through its document.
//   (Stored as `uploads`; the earlier `attachments` cache is ignored because
//   1.7.3 could record empty attachments from failed server-side downloads.)
// - comments: highlight note key → Outline comment id, so notes aren't posted
//   twice and comments we created can be rebuilt when the document is replaced.

import browser from './browser-polyfill';

export const OUTLINE_DOC_STATE_STORAGE_KEY = 'outline_doc_state';
export const OUTLINE_DOC_STATE_MAX_ENTRIES = 1000;

export interface OutlineDocState {
	updatedAt: string;
	uploads: Record<string, string>;
	comments: Record<string, string>;
}

export type OutlineDocStateMap = Record<string, OutlineDocState>;

export function emptyDocState(): OutlineDocState {
	return { updatedAt: '', uploads: {}, comments: {} };
}

function sanitizeRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object') return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [string, string][]
	);
}

export function readDocState(map: OutlineDocStateMap, documentId: string): OutlineDocState {
	const entry = map[documentId];
	if (!entry || typeof entry !== 'object') return emptyDocState();
	return {
		updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
		uploads: sanitizeRecord(entry.uploads),
		comments: sanitizeRecord(entry.comments),
	};
}

/** Returns a new map with the entry set, dropping the least recently updated past the cap. */
export function withDocState(
	map: OutlineDocStateMap,
	documentId: string,
	state: OutlineDocState,
	maxEntries = OUTLINE_DOC_STATE_MAX_ENTRIES,
): OutlineDocStateMap {
	const next: OutlineDocStateMap = { ...map, [documentId]: state };
	const keys = Object.keys(next);
	if (keys.length <= maxEntries) return next;
	keys
		.sort((a, b) => (next[a].updatedAt || '').localeCompare(next[b].updatedAt || ''))
		.slice(0, keys.length - maxEntries)
		.forEach(key => delete next[key]);
	return next;
}

async function readMap(): Promise<OutlineDocStateMap> {
	const result = await browser.storage.local.get(OUTLINE_DOC_STATE_STORAGE_KEY);
	const value = result[OUTLINE_DOC_STATE_STORAGE_KEY];
	return value && typeof value === 'object' ? value as OutlineDocStateMap : {};
}

export async function getOutlineDocState(documentId: string): Promise<OutlineDocState> {
	return readDocState(await readMap(), documentId);
}

export async function updateOutlineDocState(
	documentId: string,
	changes: Partial<Pick<OutlineDocState, 'uploads' | 'comments'>>,
): Promise<void> {
	const map = await readMap();
	const current = readDocState(map, documentId);
	// Rebuilt from sanitized fields, which also drops the legacy `attachments` cache
	const next: OutlineDocState = { ...current, ...changes, updatedAt: new Date().toISOString() };
	await browser.storage.local.set({ [OUTLINE_DOC_STATE_STORAGE_KEY]: withDocState(map, documentId, next) });
}
