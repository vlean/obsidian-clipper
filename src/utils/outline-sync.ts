// Decides whether a clip creates a new Outline document or updates an existing
// one, mirroring the template "behavior" used for Obsidian:
//
// | behavior               | target document                         | action             |
// |------------------------|-----------------------------------------|--------------------|
// | create                 | document previously clipped from the URL | replace, else new  |
// | overwrite              | same URL, else same title in collection  | replace, else new  |
// | append/prepend-specific| same title in collection                 | append/prepend, else new |
// | append/prepend-daily   | today's date as title in collection      | append/prepend, else new |
//
// `forceCreate` always creates a new document ("Save as new").

import { Template } from '../types/types';
import {
	OutlineConfig,
	OutlineDocument,
	OutlineEditMode,
	OutlineRequestOptions,
	createOutlineDocument,
	findOutlineDocumentByTitle,
	getOutlineDocument,
	updateOutlineDocument,
} from './outline-client';

export type OutlineSaveMode = 'created' | 'updated' | 'appended' | 'prepended';

export interface OutlineSaveInput {
	title: string;
	text: string;
	behavior: Template['behavior'];
	collectionId: string;
	publish: boolean;
	/** Document previously created from the same page URL, if any */
	mappedDocumentId?: string;
	forceCreate?: boolean;
}

export interface OutlineSaveResult {
	document: OutlineDocument;
	mode: OutlineSaveMode;
}

export function isAppendBehavior(behavior: Template['behavior']): boolean {
	return behavior.startsWith('append') || behavior.startsWith('prepend');
}

export function isDailyBehavior(behavior: Template['behavior']): boolean {
	return behavior === 'append-daily' || behavior === 'prepend-daily';
}

/** Whether a clip with this behavior owns its document and should be tracked by URL. */
export function tracksSourceUrl(behavior: Template['behavior']): boolean {
	return !isAppendBehavior(behavior);
}

function editModeFor(behavior: Template['behavior']): OutlineEditMode {
	if (behavior.startsWith('append')) return 'append';
	if (behavior.startsWith('prepend')) return 'prepend';
	return 'replace';
}

const MODE_FOR_EDIT: Record<OutlineEditMode, OutlineSaveMode> = {
	replace: 'updated',
	append: 'appended',
	prepend: 'prepended',
};

export async function saveOutlineDocument(
	config: OutlineConfig,
	input: OutlineSaveInput,
	options?: OutlineRequestOptions,
): Promise<OutlineSaveResult> {
	const create = async (): Promise<OutlineSaveResult> => ({
		document: await createOutlineDocument(config, {
			title: input.title,
			text: input.text,
			collectionId: input.collectionId,
			publish: input.publish,
		}, options),
		mode: 'created',
	});

	if (input.forceCreate) return create();

	let target: OutlineDocument | null = null;
	if (isAppendBehavior(input.behavior)) {
		target = await findOutlineDocumentByTitle(config, input.title, input.collectionId, options);
	} else {
		if (input.mappedDocumentId) {
			target = await getOutlineDocument(config, input.mappedDocumentId, options);
		}
		if (!target && input.behavior === 'overwrite') {
			target = await findOutlineDocumentByTitle(config, input.title, input.collectionId, options);
		}
	}

	if (!target) return create();

	const editMode = editModeFor(input.behavior);
	const document = await updateOutlineDocument(config, {
		id: target.id,
		text: input.text,
		editMode,
		title: input.title,
	}, options);
	return { document, mode: MODE_FOR_EDIT[editMode] };
}
