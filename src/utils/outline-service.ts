// Background-side handling of Outline requests. Runs in the extension's
// background context so requests survive the popup closing and the API key
// never has to travel through runtime messages.

import browser from './browser-polyfill';
import {
	OutlineApiError,
	OutlineCollection,
	OutlineConfig,
	OutlineErrorKind,
	getOutlineAuthInfo,
	getOutlineDocumentUrl,
	listOutlineCollections,
} from './outline-client';
import { OUTLINE_API_KEY_STORAGE_KEY, sanitizeOutlineSettings } from './storage-utils';
import { OutlineSettings, Template } from '../types/types';
import { OutlineSaveMode, saveOutlineDocument, tracksSourceUrl } from './outline-sync';
import { getOutlineDocumentMapping, setOutlineDocumentMapping } from './outline-documents-store';
import { getOutlineDocState, updateOutlineDocState } from './outline-doc-state';
import { OutlineImageStats, uploadOutlineImages } from './outline-images';
import { OutlineCommentInput, OutlineCommentStats, syncOutlineComments } from './outline-comments';

const VALID_BEHAVIORS: Template['behavior'][] = ['create', 'append-specific', 'append-daily', 'prepend-specific', 'prepend-daily', 'overwrite'];

export const OUTLINE_ACTIONS = {
	testConnection: 'outlineTestConnection',
	saveDocument: 'outlineSaveDocument',
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
	}
	| OutlineFailure;

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

		let images: OutlineImageStats | undefined;
		const transformText = settings.uploadImages
			? async (text: string, documentId: string): Promise<string> => {
				try {
					const state = await getOutlineDocState(documentId);
					const result = await uploadOutlineImages(config, text, { documentId, attachments: state.attachments });
					images = { uploaded: result.uploaded, reused: result.reused, failed: result.failed, skipped: result.skipped };
					if (result.uploaded > 0) await updateOutlineDocState(documentId, { attachments: result.attachments });
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
			collectionId: request.collectionId || settings.collectionId,
			publish: settings.publish,
			mappedDocumentId: mapping?.documentId,
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
		}

		// Mirror the Obsidian flow: open the note unless "silent open" is enabled
		if (!silentOpen) {
			browser.tabs.create({ url }).catch(error => console.error('Failed to open Outline document:', error));
		}

		return { success: true, id: document.id, title: document.title, url, mode, images, comments };
	} catch (error) {
		console.error('Failed to save Outline document:', error);
		return toFailure(error);
	}
}

/**
 * Handles Outline runtime messages. Returns a promise for handled actions,
 * or null when the message isn't an Outline action.
 */
export function handleOutlineMessage(request: { action?: string } & Record<string, unknown>): Promise<unknown> | null {
	switch (request.action) {
		case OUTLINE_ACTIONS.testConnection:
			return handleOutlineTestConnection();
		case OUTLINE_ACTIONS.saveDocument:
			if (typeof request.title !== 'string' || typeof request.text !== 'string') {
				return Promise.resolve({ success: false, errorKind: 'validation', error: 'Missing title or text' } satisfies OutlineFailure);
			}
			return handleOutlineSaveDocument(request as unknown as OutlineSaveDocumentRequest);
		default:
			return null;
	}
}
