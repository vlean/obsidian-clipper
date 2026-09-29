// Background-side handling of Outline requests. Runs in the extension's
// background context so requests survive the popup closing and the API key
// never has to travel through runtime messages.

import browser from './browser-polyfill';
import {
	ensureOutlineDocumentPath,
	findOutlineDocumentBySource,
	splitOutlinePath,
	OutlineApiError,
	OutlineCollection,
	OutlineConfig,
	OutlineErrorKind,
	getOutlineAuthInfo,
	getOutlineDocument,
	getOutlineDocumentUrl,
	listOutlineCollections,
	shareOutlineDocumentPublicly,
	starOutlineDocument,
	searchOutlineDocumentTitles,
	searchOutlineDocuments,
	OutlineSearchResult,
} from './outline-client';
import { OUTLINE_API_KEY_STORAGE_KEY, sanitizeOutlineSettings } from './storage-utils';
import { OutlineSettings, Template } from '../types/types';
import { OutlineSaveMode, saveOutlineDocument, tracksSourceUrl } from './outline-sync';
import { getOutlineDocumentMapping, setOutlineDocumentMapping } from './outline-documents-store';
import { getOutlineDocState, updateOutlineDocState } from './outline-doc-state';
import { OutlineImageStats, uploadOutlineImages } from './outline-images';
import { OutlineCommentInput, OutlineCommentStats, syncOutlineComments, syncOutlineNoteComments } from './outline-comments';
import { updateClippedBadgesForUrl } from './outline-badge';
import { buildRelatedDocumentsQuery } from './outline-related';
const VALID_BEHAVIORS: Template['behavior'][] = ['create', 'append-specific', 'append-daily', 'prepend-specific', 'prepend-daily', 'overwrite'];

export const OUTLINE_ACTIONS = {
	testConnection: 'outlineTestConnection',
	saveDocument: 'outlineSaveDocument',
	listCollections: 'outlineListCollections',
	syncNotes: 'outlineSyncNotes',
	shareDocument: 'outlineShareDocument',
	findRelated: 'outlineFindRelated',
} as const;

export interface OutlineFailure {
	success: false;
	errorKind: OutlineErrorKind;
	error: string;
}

export type OutlineTestConnectionResponse =
	| { success: true; userName: string; teamName: string; collections: OutlineCollection[] }
	| OutlineFailure;

export type OutlineSaveDocumentResponse =
	| {
		success: true;
		id: string;
		title: string;
		url: string;
		mode: OutlineSaveMode;
		/** Present when image upload is enabled */
		images?: OutlineImageStats;
		/** Present when comment sync ran */
		comments?: OutlineCommentStats;
		/** Present when the clip requested a star; true once the document is starred */
		starred?: boolean;
		/** Set when starring failed for a reason other than 'already starred' */
		starError?: string;
	}
	| OutlineFailure;

export type OutlineSyncNotesResponse =
	| { success: true; url: string; comments: OutlineCommentStats }
	| OutlineFailure;

export type OutlineShareDocumentResponse =
	| { success: true; url: string }
	| OutlineFailure;

export interface OutlineRelatedDocument {
	id: string;
	title: string;
	/** Absolute URL to the document */
	url: string;
}

export interface OutlineFindRelatedRequest {
	action: typeof OUTLINE_ACTIONS.findRelated;
	/** Page title used to derive the search query */
	title?: string;
	/** Page being clipped; its already-mapped document is excluded from results */
	sourceUrl?: string;
}

export interface OutlineFindRelatedResponse {
	success: true;
	documents: OutlineRelatedDocument[];
}

export interface OutlineShareDocumentRequest {
	action: typeof OUTLINE_ACTIONS.shareDocument;
	/** Document to create/publish a public share for */
	documentId?: string;
}

export interface OutlineSyncNotesRequest {
	action: typeof OUTLINE_ACTIONS.syncNotes;
	/** Page the notes belong to; used to find the mapped document */
	sourceUrl?: string;
	/** Highlight notes to reconcile as comments */
	comments?: OutlineCommentInput[];
}

export interface OutlineSaveDocumentRequest {
	action: typeof OUTLINE_ACTIONS.saveDocument;
	title: string;
	text: string;
	/** Template behavior; defaults to `create` */
	behavior?: Template['behavior'];
	/** Page the clip came from, used to find the document to update */
	sourceUrl?: string;
	/** Always create a new document, ignoring any existing one */
	forceCreate?: boolean;
	/** Overrides the configured default collection */
	collectionId?: string;
	/** Highlight notes to post as anchored comments */
	comments?: OutlineCommentInput[];
	/** Template note location (a/b/c), nested as parent documents when enabled */
	path?: string;
	/** Creation date for new documents (ISO), when "use published date" is enabled */
	createdAt?: string;
	/** Star the document (add to sidebar) after a successful save */
	star?: boolean;
}

function sanitizeCreatedAt(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value) return undefined;
	const time = Date.parse(value);
	// Only backdate: future or invalid dates are ignored
	if (Number.isNaN(time) || time > Date.now()) return undefined;
	return new Date(time).toISOString();
}

function sanitizeCommentInputs(value: unknown): OutlineCommentInput[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is OutlineCommentInput =>
		Boolean(item) && typeof item.key === 'string' && typeof item.text === 'string' && item.text.trim().length > 0
	);
}

async function loadOutlineState(): Promise<{ settings: OutlineSettings; config: OutlineConfig; silentOpen: boolean }> {
	const [syncData, localData] = await Promise.all([
		browser.storage.sync.get(['outline_settings', 'general_settings']),
		browser.storage.local.get(OUTLINE_API_KEY_STORAGE_KEY),
	]);
	const settings = sanitizeOutlineSettings(syncData.outline_settings);
	const apiKey = localData[OUTLINE_API_KEY_STORAGE_KEY];
	const generalSettings = syncData.general_settings as { silentOpen?: boolean } | undefined;
	return {
		settings,
		config: { baseUrl: settings.baseUrl, apiKey: typeof apiKey === 'string' ? apiKey : '' },
		silentOpen: Boolean(generalSettings?.silentOpen),
	};
}

function toFailure(error: unknown): OutlineFailure {
	if (error instanceof OutlineApiError) {
		return { success: false, errorKind: error.kind, error: error.message };
	}
	return { success: false, errorKind: 'server', error: error instanceof Error ? error.message : String(error) };
}

export async function handleOutlineTestConnection(): Promise<OutlineTestConnectionResponse> {
	try {
		const { config } = await loadOutlineState();
		const auth = await getOutlineAuthInfo(config);
		const collections = await listOutlineCollections(config);
		return { success: true, userName: auth.userName, teamName: auth.teamName, collections };
	} catch (error) {
		return toFailure(error);
	}
}

export async function handleOutlineSaveDocument(request: OutlineSaveDocumentRequest): Promise<OutlineSaveDocumentResponse> {
	try {
		const { settings, config, silentOpen } = await loadOutlineState();
		const behavior = request.behavior && VALID_BEHAVIORS.includes(request.behavior) ? request.behavior : 'create';
		const sourceUrl = typeof request.sourceUrl === 'string' ? request.sourceUrl : '';
		const tracked = tracksSourceUrl(behavior) && Boolean(sourceUrl);
		const mapping = tracked ? await getOutlineDocumentMapping(sourceUrl, settings.baseUrl) : null;
		const collectionId = request.collectionId || settings.collectionId;

		// No local record (e.g. clipped on another device): look for a document
		// in the collection that already contains this page's URL
		let mappedDocumentId = mapping?.documentId;
		if (tracked && !mappedDocumentId && !request.forceCreate && collectionId) {
			try {
				mappedDocumentId = (await findOutlineDocumentBySource(config, sourceUrl, collectionId))?.id;
			} catch (error) {
				console.warn('Outline source lookup failed:', error);
			}
		}

		const segments = settings.pathAsParent && typeof request.path === 'string' ? splitOutlinePath(request.path) : [];
		const resolveParentDocumentId = segments.length > 0
			? () => ensureOutlineDocumentPath(config, collectionId, segments)
			: undefined;

		let images: OutlineImageStats | undefined;
		const transformText = settings.uploadImages
			? async (text: string, documentId: string): Promise<string> => {
				try {
					const state = await getOutlineDocState(documentId);
					const result = await uploadOutlineImages(config, text, { documentId, attachments: state.uploads });
					images = { uploaded: result.uploaded, reused: result.reused, failed: result.failed, skipped: result.skipped };
					if (result.uploaded > 0) await updateOutlineDocState(documentId, { uploads: result.attachments });
					return result.text;
				} catch (error) {
					// Never block the clip on image handling
					console.error('Outline image upload failed:', error);
					return text;
				}
			}
			: undefined;

		const { document, mode } = await saveOutlineDocument(config, {
			title: request.title,
			text: request.text,
			behavior,
			collectionId,
			publish: settings.publish,
			mappedDocumentId,
			createdAt: sanitizeCreatedAt(request.createdAt),
			resolveParentDocumentId,
			forceCreate: Boolean(request.forceCreate),
			transformText,
		});
		const url = getOutlineDocumentUrl(settings.baseUrl, document.url);

		// Replacing the text drops existing comment anchors, so rebuild ours
		let comments: OutlineCommentStats | undefined;
		if (settings.syncComments) {
			const inputs = sanitizeCommentInputs(request.comments);
			const rebuild = mode === 'updated';
			const state = await getOutlineDocState(document.id);
			const hasExisting = Object.keys(state.comments).length > 0;
			if (inputs.length > 0 || (rebuild && hasExisting)) {
				try {
					const result = await syncOutlineComments(config, {
						documentId: document.id,
						inputs,
						existing: state.comments,
						rebuild,
					});
					comments = { created: result.created, anchored: result.anchored, failed: result.failed, removed: result.removed };
					await updateOutlineDocState(document.id, { comments: result.comments });
				} catch (error) {
					console.error('Outline comment sync failed:', error);
					comments = { created: 0, anchored: 0, failed: inputs.length, removed: 0 };
				}
			}
		}

		if (tracked) {
			await setOutlineDocumentMapping(sourceUrl, {
				documentId: document.id,
				baseUrl: settings.baseUrl,
				url,
				title: document.title,
				updatedAt: new Date().toISOString(),
			});
			// Show the "already clipped" badge on any open tab for this page
			updateClippedBadgesForUrl(sourceUrl).catch(error => console.debug('Badge update failed:', error));
		}

		// Optionally star the document. This must never fail the save: a star is a
		// convenience, and 'already starred' is reported as success by the client.
		let starred: boolean | undefined;
		let starError: string | undefined;
		const shouldStar = typeof request.star === 'boolean' ? request.star : settings.starOnClip;
		if (shouldStar) {
			try {
				await starOutlineDocument(config, document.id);
				starred = true;
			} catch (error) {
				console.warn('Outline star failed:', error);
				starred = false;
				starError = error instanceof Error ? error.message : String(error);
			}
		}

		// Mirror the Obsidian flow: open the note unless "silent open" is enabled
		if (!silentOpen) {
			browser.tabs.create({ url }).catch(error => console.error('Failed to open Outline document:', error));
		}

		return { success: true, id: document.id, title: document.title, url, mode, images, comments, starred, starError };
	} catch (error) {
		console.error('Failed to save Outline document:', error);
		return toFailure(error);
	}
}

/**
 * Reconciles highlight notes as comments on an already-clipped document,
 * without changing the document text. Fails with 'notFound' when the page was
 * never clipped or the document no longer exists.
 */
export async function handleOutlineSyncNotes(request: OutlineSyncNotesRequest): Promise<OutlineSyncNotesResponse> {
	try {
		const { settings, config } = await loadOutlineState();
		const sourceUrl = typeof request.sourceUrl === 'string' ? request.sourceUrl : '';
		if (!sourceUrl) {
			return { success: false, errorKind: 'notFound', error: 'No source URL' };
		}
		const mapping = await getOutlineDocumentMapping(sourceUrl, settings.baseUrl);
		if (!mapping) {
			return { success: false, errorKind: 'notFound', error: 'Page is not clipped to Outline' };
		}

		// The document may have been deleted on the server since it was clipped
		const document = await getOutlineDocument(config, mapping.documentId);
		if (!document) {
			return { success: false, errorKind: 'notFound', error: 'Outline document no longer exists' };
		}

		const url = getOutlineDocumentUrl(settings.baseUrl, document.url);
		const inputs = sanitizeCommentInputs(request.comments);
		const state = await getOutlineDocState(document.id);
		const result = await syncOutlineNoteComments(config, {
			documentId: document.id,
			inputs,
			existing: state.comments,
		});
		await updateOutlineDocState(document.id, { comments: result.comments });
		return {
			success: true,
			url,
			comments: { created: result.created, anchored: result.anchored, failed: result.failed, removed: result.removed },
		};
	} catch (error) {
		console.error('Failed to sync Outline notes:', error);
		return toFailure(error);
	}
}

/**
 * Creates and publishes a public share link for a document. When sharing is
 * disabled by the workspace, Outline answers with a 403; that is surfaced with
 * a dedicated message so the user understands it is a permissions issue rather
 * than a transient error.
 */
export async function handleOutlineShareDocument(request: OutlineShareDocumentRequest): Promise<OutlineShareDocumentResponse> {
	try {
		const documentId = typeof request.documentId === 'string' ? request.documentId.trim() : '';
		if (!documentId) {
			return { success: false, errorKind: 'validation', error: 'No document to share' };
		}
		const { config } = await loadOutlineState();
		const url = await shareOutlineDocumentPublicly(config, documentId);
		if (!url) {
			return { success: false, errorKind: 'server', error: 'Outline did not return a share URL' };
		}
		return { success: true, url };
	} catch (error) {
		console.error('Failed to share Outline document:', error);
		return toFailure(error);
	}
}

/**
 * Finds documents in the workspace whose titles resemble the page title, so the
 * popup can surface them before clipping. Never throws: any failure (bad query,
 * network, permissions) resolves to an empty list so the popup is never blocked.
 * Archived/deleted documents and the document already mapped to `sourceUrl` are
 * excluded, and at most 5 results are returned.
 */
export async function handleOutlineFindRelated(request: OutlineFindRelatedRequest): Promise<OutlineFindRelatedResponse> {
	const empty: OutlineFindRelatedResponse = { success: true, documents: [] };
	try {
		const query = buildRelatedDocumentsQuery(typeof request.title === 'string' ? request.title : '');
		if (!query) return empty;

		const { settings, config } = await loadOutlineState();
		if (!config.baseUrl || !config.apiKey) return empty;

		const sourceUrl = typeof request.sourceUrl === 'string' ? request.sourceUrl : '';
		const excludedId = sourceUrl
			? (await getOutlineDocumentMapping(sourceUrl, settings.baseUrl))?.documentId
			: undefined;

		const collectionId = settings.collectionId || undefined;
		let results = await searchOutlineDocumentTitles(config, query, { collectionId, limit: 20 });

		// Postgres title search can come up empty for reworded titles; fall back
		// to full-text search over document contents.
		if (results.length === 0) {
			results = await searchOutlineDocuments(config, query, { collectionId, limit: 20 });
		}

		const documents = filterRelatedResults(results, excludedId, settings.baseUrl);
		return { success: true, documents };
	} catch (error) {
		console.warn('Outline related lookup failed:', error);
		return empty;
	}
}

/** Excludes archived/deleted docs and the mapped doc, dedupes, maps to 5 absolute-URL results. */
function filterRelatedResults(
	results: OutlineSearchResult[],
	excludedId: string | undefined,
	baseUrl: string,
): OutlineRelatedDocument[] {
	const seen = new Set<string>();
	const documents: OutlineRelatedDocument[] = [];
	for (const doc of results) {
		if (!doc.id || doc.archivedAt || doc.deletedAt) continue;
		if (excludedId && doc.id === excludedId) continue;
		if (seen.has(doc.id)) continue;
		seen.add(doc.id);
		documents.push({
			id: doc.id,
			title: doc.title || doc.url || doc.id,
			url: getOutlineDocumentUrl(baseUrl, doc.url),
		});
		if (documents.length >= 5) break;
	}
	return documents;
}

/**
 * Handles Outline runtime messages. Returns a promise for handled actions,
 * or null when the message isn't an Outline action.
 */
export function handleOutlineMessage(request: { action?: string } & Record<string, unknown>): Promise<unknown> | null {
	switch (request.action) {
		case OUTLINE_ACTIONS.testConnection:
			return handleOutlineTestConnection();
		case OUTLINE_ACTIONS.listCollections:
			return loadOutlineState()
				.then(({ config }) => listOutlineCollections(config))
				.then(collections => ({ success: true, collections }))
				.catch(toFailure);
		case OUTLINE_ACTIONS.saveDocument:
			if (typeof request.title !== 'string' || typeof request.text !== 'string') {
				return Promise.resolve({ success: false, errorKind: 'validation', error: 'Missing title or text' } satisfies OutlineFailure);
			}
			return handleOutlineSaveDocument(request as unknown as OutlineSaveDocumentRequest);
		case OUTLINE_ACTIONS.syncNotes:
			return handleOutlineSyncNotes(request as unknown as OutlineSyncNotesRequest);
		case OUTLINE_ACTIONS.shareDocument:
			return handleOutlineShareDocument(request as unknown as OutlineShareDocumentRequest);
		case OUTLINE_ACTIONS.findRelated:
			return handleOutlineFindRelated(request as unknown as OutlineFindRelatedRequest);
		default:
			return null;
	}
}
