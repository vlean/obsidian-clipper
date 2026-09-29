// Background-side handling of Outline requests. Runs in the extension's
// background context so requests survive the popup closing and the API key
// never has to travel through runtime messages.

import browser from './browser-polyfill';
import {
	OutlineApiError,
	OutlineCollection,
	OutlineConfig,
	OutlineErrorKind,
	createOutlineDocument,
	getOutlineAuthInfo,
	getOutlineDocumentUrl,
	listOutlineCollections,
} from './outline-client';
import { OUTLINE_API_KEY_STORAGE_KEY, sanitizeOutlineSettings } from './storage-utils';
import { OutlineSettings } from '../types/types';

export const OUTLINE_ACTIONS = {
	testConnection: 'outlineTestConnection',
	createDocument: 'outlineCreateDocument',
} as const;

export interface OutlineFailure {
	success: false;
	errorKind: OutlineErrorKind;
	error: string;
}

export type OutlineTestConnectionResponse =
	| { success: true; userName: string; teamName: string; collections: OutlineCollection[] }
	| OutlineFailure;

export type OutlineCreateDocumentResponse =
	| { success: true; id: string; title: string; url: string }
	| OutlineFailure;

export interface OutlineCreateDocumentRequest {
	action: typeof OUTLINE_ACTIONS.createDocument;
	title: string;
	text: string;
	/** Overrides the configured default collection */
	collectionId?: string;
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

export async function handleOutlineCreateDocument(request: OutlineCreateDocumentRequest): Promise<OutlineCreateDocumentResponse> {
	try {
		const { settings, config, silentOpen } = await loadOutlineState();
		const document = await createOutlineDocument(config, {
			title: request.title,
			text: request.text,
			collectionId: request.collectionId || settings.collectionId,
			publish: settings.publish,
		});
		const url = getOutlineDocumentUrl(settings.baseUrl, document.url);

		// Mirror the Obsidian flow: open the new note unless "silent open" is enabled
		if (!silentOpen) {
			browser.tabs.create({ url }).catch(error => console.error('Failed to open Outline document:', error));
		}

		return { success: true, id: document.id, title: document.title, url };
	} catch (error) {
		console.error('Failed to create Outline document:', error);
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
		case OUTLINE_ACTIONS.createDocument:
			if (typeof request.title !== 'string' || typeof request.text !== 'string') {
				return Promise.resolve({ success: false, errorKind: 'validation', error: 'Missing title or text' } satisfies OutlineFailure);
			}
			return handleOutlineCreateDocument(request as unknown as OutlineCreateDocumentRequest);
		default:
			return null;
	}
}
