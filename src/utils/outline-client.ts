// Minimal client for the Outline API (https://www.getoutline.com/developers).
// All endpoints are `POST {baseUrl}/api/:method` with a JSON body and a
// Bearer API key. `fetch` is injectable so the client can be unit tested.

export interface OutlineConfig {
	baseUrl: string;
	apiKey: string;
}

export interface OutlineCollection {
	id: string;
	name: string;
}

export interface OutlineDocument {
	id: string;
	title: string;
	url: string;
	/** Markdown as stored by Outline, when the response includes it */
	text?: string;
}

export interface OutlineAuthInfo {
	userName: string;
	teamName: string;
}

export type OutlineErrorKind =
	| 'config'
	| 'network'
	| 'unauthorized'
	| 'forbidden'
	| 'notFound'
	| 'validation'
	| 'rateLimited'
	| 'server';

export class OutlineApiError extends Error {
	constructor(
		public readonly kind: OutlineErrorKind,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'OutlineApiError';
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OutlineRequestOptions {
	fetchImpl?: FetchLike;
	/** Number of retries on HTTP 429. */
	maxRetries?: number;
	/** Upper bound for honouring Retry-After, in seconds. */
	maxRetryDelaySeconds?: number;
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const COLLECTIONS_PAGE_SIZE = 100;
const COLLECTIONS_MAX_PAGES = 20;

/**
 * Normalizes a user-entered Outline URL to its origin + path prefix, without a
 * trailing slash or `/api` suffix. Throws OutlineApiError('config') if invalid.
 */
export function normalizeOutlineBaseUrl(rawUrl: string): string {
	const trimmed = (rawUrl || '').trim();
	if (!trimmed) {
		throw new OutlineApiError('config', 'Outline URL is not configured');
	}
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		throw new OutlineApiError('config', `Invalid Outline URL: ${trimmed}`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new OutlineApiError('config', `Unsupported protocol: ${url.protocol}`);
	}
	const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
	return `${url.origin}${path}`;
}

/** Builds an absolute link to a document from the relative `url` returned by the API. */
export function getOutlineDocumentUrl(baseUrl: string, documentPath: string): string {
	if (/^https?:\/\//i.test(documentPath)) return documentPath;
	const base = normalizeOutlineBaseUrl(baseUrl);
	return `${base}${documentPath.startsWith('/') ? '' : '/'}${documentPath}`;
}

/** Maps an error kind to its i18n message key. */
export function getOutlineErrorMessageKey(kind: OutlineErrorKind | undefined): string {
	switch (kind) {
		case 'config': return 'outlineErrorConfig';
		case 'network': return 'outlineErrorNetwork';
		case 'unauthorized': return 'outlineErrorUnauthorized';
		case 'forbidden': return 'outlineErrorForbidden';
		case 'notFound': return 'outlineErrorNotFound';
		case 'rateLimited': return 'outlineErrorRateLimited';
		default: return 'outlineErrorGeneric';
	}
}

function kindForStatus(status: number): OutlineErrorKind {
	if (status === 401) return 'unauthorized';
	if (status === 403) return 'forbidden';
	if (status === 404) return 'notFound';
	if (status === 400) return 'validation';
	if (status === 429) return 'rateLimited';
	return 'server';
}

function parseRetryAfter(header: string | null): number {
	if (!header) return 1;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const date = Date.parse(header);
	if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
	return 1;
}

export async function outlineRequest<T = any>(
	config: OutlineConfig,
	method: string,
	body: Record<string, unknown> = {},
	options: OutlineRequestOptions = {},
): Promise<T> {
	const {
		fetchImpl = (input, init) => fetch(input, init),
		maxRetries = 1,
		maxRetryDelaySeconds = 10,
		sleep = DEFAULT_SLEEP,
	} = options;

	if (!config.apiKey || !config.apiKey.trim()) {
		throw new OutlineApiError('config', 'Outline API key is not configured');
	}
	const endpoint = `${normalizeOutlineBaseUrl(config.baseUrl)}/api/${method}`;

	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetchImpl(endpoint, {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${config.apiKey.trim()}`,
				},
				body: JSON.stringify(body),
			});
		} catch (error) {
			throw new OutlineApiError('network', error instanceof Error ? error.message : String(error));
		}

		if (response.status === 429 && attempt < maxRetries) {
			const delay = Math.min(parseRetryAfter(response.headers.get('Retry-After')), maxRetryDelaySeconds);
			await sleep(delay * 1000);
			continue;
		}

		const rawText = await response.text();
		let payload: any = null;
		try {
			payload = rawText ? JSON.parse(rawText) : null;
		} catch {
			payload = null;
		}

		if (!response.ok) {
			const message = payload?.message || payload?.error || rawText || response.statusText || `HTTP ${response.status}`;
			throw new OutlineApiError(kindForStatus(response.status), String(message).slice(0, 500), response.status);
		}
		if (payload === null) {
			throw new OutlineApiError('server', 'Invalid JSON response from Outline', response.status);
		}
		return payload as T;
	}
}

export async function getOutlineAuthInfo(config: OutlineConfig, options?: OutlineRequestOptions): Promise<OutlineAuthInfo> {
	const result = await outlineRequest<{ data?: { user?: { name?: string }; team?: { name?: string } } }>(config, 'auth.info', {}, options);
	return {
		userName: result.data?.user?.name ?? '',
		teamName: result.data?.team?.name ?? '',
	};
}

export async function listOutlineCollections(config: OutlineConfig, options?: OutlineRequestOptions): Promise<OutlineCollection[]> {
	const collections: OutlineCollection[] = [];
	for (let page = 0; page < COLLECTIONS_MAX_PAGES; page++) {
		const result = await outlineRequest<{ data?: Array<{ id: string; name: string }> }>(
			config,
			'collections.list',
			{ limit: COLLECTIONS_PAGE_SIZE, offset: page * COLLECTIONS_PAGE_SIZE },
			options,
		);
		const items = Array.isArray(result.data) ? result.data : [];
		for (const item of items) {
			if (item && typeof item.id === 'string') {
				collections.push({ id: item.id, name: String(item.name ?? '') });
			}
		}
		if (items.length < COLLECTIONS_PAGE_SIZE) break;
	}
	return collections;
}

export interface CreateOutlineDocumentParams {
	title: string;
	text: string;
	collectionId: string;
	publish: boolean;
	/** Nest under this document */
	parentDocumentId?: string;
	/** ISO date to backdate the document's creation date */
	createdAt?: string;
}

export async function createOutlineDocument(
	config: OutlineConfig,
	params: CreateOutlineDocumentParams,
	options?: OutlineRequestOptions,
): Promise<OutlineDocument> {
	if (!params.collectionId) {
		throw new OutlineApiError('config', 'No Outline collection selected');
	}
	const result = await outlineRequest<{ data?: { id: string; title: string; url: string; text?: string } }>(
		config,
		'documents.create',
		{
			title: params.title,
			text: params.text,
			collectionId: params.collectionId,
			publish: params.publish,
			...(params.parentDocumentId ? { parentDocumentId: params.parentDocumentId } : {}),
			...(params.createdAt ? { createdAt: params.createdAt } : {}),
		},
		options,
	);
	if (!result.data || typeof result.data.id !== 'string') {
		throw new OutlineApiError('server', 'Unexpected response from documents.create');
	}
	const document: OutlineDocument = { id: result.data.id, title: result.data.title, url: result.data.url };
	if (typeof result.data.text === 'string') document.text = result.data.text;
	return document;
}

interface RawOutlineDocument {
	id: string;
	title: string;
	url: string;
	collectionId?: string | null;
	archivedAt?: string | null;
	deletedAt?: string | null;
}

function toOutlineDocument(raw: RawOutlineDocument): OutlineDocument {
	return { id: raw.id, title: raw.title, url: raw.url };
}

function isLiveDocument(raw: RawOutlineDocument | undefined | null): raw is RawOutlineDocument {
	return Boolean(raw && typeof raw.id === 'string' && !raw.archivedAt && !raw.deletedAt);
}

/**
 * Fetches a document by id. Returns null when it no longer exists or has been
 * archived/deleted, so callers can fall back to creating a new one.
 */
export async function getOutlineDocument(
	config: OutlineConfig,
	id: string,
	options?: OutlineRequestOptions,
): Promise<OutlineDocument | null> {
	try {
		const result = await outlineRequest<{ data?: RawOutlineDocument }>(config, 'documents.info', { id }, options);
		return isLiveDocument(result.data) ? toOutlineDocument(result.data) : null;
	} catch (error) {
		// 403 covers documents that were moved somewhere the key can't see
		if (error instanceof OutlineApiError && (error.kind === 'notFound' || error.kind === 'forbidden')) {
			return null;
		}
		throw error;
	}
}

/** Finds a document in a collection whose title matches exactly (case-insensitive). */
export async function findOutlineDocumentByTitle(
	config: OutlineConfig,
	title: string,
	collectionId: string,
	options?: OutlineRequestOptions,
): Promise<OutlineDocument | null> {
	const wanted = title.trim().toLowerCase();
	if (!wanted) return null;
	const result = await outlineRequest<{ data?: RawOutlineDocument[] }>(
		config,
		'documents.search_titles',
		{ query: title.trim(), collectionId, limit: 25 },
		options,
	);
	const match = (Array.isArray(result.data) ? result.data : []).find(doc =>
		isLiveDocument(doc)
		&& (!doc.collectionId || doc.collectionId === collectionId)
		&& String(doc.title ?? '').trim().toLowerCase() === wanted
	);
	return match ? toOutlineDocument(match) : null;
}

export type OutlineEditMode = 'replace' | 'append' | 'prepend';

export interface UpdateOutlineDocumentParams {
	id: string;
	text: string;
	editMode: OutlineEditMode;
	/** Only applied for `replace` */
	title?: string;
}

export async function updateOutlineDocument(
	config: OutlineConfig,
	params: UpdateOutlineDocumentParams,
	options?: OutlineRequestOptions,
): Promise<OutlineDocument> {
	const body: Record<string, unknown> = { id: params.id };
	if (params.editMode === 'replace') {
		// Omitting editMode replaces the text, which also works on older servers
		body.text = params.text;
		if (params.title) body.title = params.title;
	} else {
		// Keep appended/prepended clips visually separate from existing content
		body.text = params.editMode === 'append' ? `\n\n${params.text}` : `${params.text}\n\n`;
		body.editMode = params.editMode;
	}
	const result = await outlineRequest<{ data?: RawOutlineDocument }>(config, 'documents.update', body, options);
	if (!result.data || typeof result.data.id !== 'string') {
		throw new OutlineApiError('server', 'Unexpected response from documents.update');
	}
	return toOutlineDocument(result.data);
}

/**
 * Asks Outline to download a remote file and store it as an attachment of the
 * document. Returns the attachment URL to use in the document markdown.
 *
 * Outline can answer 200 with an empty attachment (size 0) when its own
 * download or file storage failed. That URL would render as a broken image, so
 * it's treated as a failure and the empty attachment is deleted.
 */
export async function createOutlineAttachmentFromUrl(
	config: OutlineConfig,
	url: string,
	documentId: string,
	options?: OutlineRequestOptions,
): Promise<string> {
	const result = await outlineRequest<{ data?: { id?: string; url?: string; size?: string | number | null } }>(
		config,
		'attachments.createFromUrl',
		{ url, documentId },
		options,
	);
	const attachment = result.data;
	if (!attachment || typeof attachment.url !== 'string' || !attachment.url) {
		throw new OutlineApiError('server', 'Unexpected response from attachments.createFromUrl');
	}
	// Size comes back as a string; only reject an explicit zero so servers that omit it still work
	const size = attachment.size === undefined || attachment.size === null ? NaN : Number(attachment.size);
	if (size === 0) {
		if (typeof attachment.id === 'string') {
			await outlineRequest(config, 'attachments.delete', { id: attachment.id }, options)
				.catch(error => console.warn('Failed to delete empty Outline attachment:', error));
		}
		throw new OutlineApiError('server', 'Outline stored an empty attachment (server-side download or file storage failed)');
	}
	return attachment.url;
}

export interface CreateOutlineCommentParams {
	documentId: string;
	/** Comment body in markdown (max 10,000 characters) */
	text: string;
	anchorText?: string;
	anchorPrefix?: string;
	anchorSuffix?: string;
}

export async function createOutlineComment(
	config: OutlineConfig,
	params: CreateOutlineCommentParams,
	options?: OutlineRequestOptions,
): Promise<string> {
	const body: Record<string, unknown> = { documentId: params.documentId, text: params.text };
	if (params.anchorText) {
		body.anchorText = params.anchorText;
		if (params.anchorPrefix) body.anchorPrefix = params.anchorPrefix;
		if (params.anchorSuffix) body.anchorSuffix = params.anchorSuffix;
	}
	const result = await outlineRequest<{ data?: { id?: string } }>(config, 'comments.create', body, options);
	if (!result.data || typeof result.data.id !== 'string') {
		throw new OutlineApiError('server', 'Unexpected response from comments.create');
	}
	return result.data.id;
}

/** Deletes a comment. Returns false when it was already gone or is inaccessible. */
export async function deleteOutlineComment(
	config: OutlineConfig,
	id: string,
	options?: OutlineRequestOptions,
): Promise<boolean> {
	try {
		await outlineRequest(config, 'comments.delete', { id }, options);
		return true;
	} catch (error) {
		if (error instanceof OutlineApiError && (error.kind === 'notFound' || error.kind === 'forbidden')) {
			return false;
		}
		throw error;
	}
}

export interface OutlineNavigationNode {
	id: string;
	title: string;
	children: OutlineNavigationNode[];
}

function toNavigationNodes(value: unknown): OutlineNavigationNode[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((node): node is Record<string, unknown> => Boolean(node) && typeof (node as any).id === 'string')
		.map(node => ({
			id: node.id as string,
			title: String(node.title ?? ''),
			children: toNavigationNodes(node.children),
		}));
}

/** Published document tree of a collection. */
export async function getOutlineCollectionTree(
	config: OutlineConfig,
	collectionId: string,
	options?: OutlineRequestOptions,
): Promise<OutlineNavigationNode[]> {
	const result = await outlineRequest<{ data?: unknown }>(config, 'collections.documents', { id: collectionId }, options);
	return toNavigationNodes(result.data);
}

/** Splits a note location like "Clippings/Tech/" into path segments. */
export function splitOutlinePath(path: string): string[] {
	return path.split('/').map(segment => segment.trim()).filter(Boolean);
}

/**
 * Returns the id of the document at `segments` inside the collection, creating
 * missing levels. Folder documents are always published: drafts don't appear
 * in the collection tree, so they couldn't be found again.
 */
export async function ensureOutlineDocumentPath(
	config: OutlineConfig,
	collectionId: string,
	segments: string[],
	options?: OutlineRequestOptions,
): Promise<string | undefined> {
	if (segments.length === 0) return undefined;
	let level = await getOutlineCollectionTree(config, collectionId, options);
	let parentId: string | undefined;
	for (const segment of segments) {
		const wanted = segment.toLowerCase();
		const existing = level.find(node => node.title.trim().toLowerCase() === wanted);
		if (existing) {
			parentId = existing.id;
			level = existing.children;
			continue;
		}
		const created = await createOutlineDocument(config, {
			title: segment,
			text: '',
			collectionId,
			publish: true,
			parentDocumentId: parentId,
		}, options);
		parentId = created.id;
		level = [];
	}
	return parentId;
}

/**
 * Finds a document in the collection that was clipped from `sourceUrl` (its
 * text contains the URL), e.g. on another device without the local mapping.
 */
export async function findOutlineDocumentBySource(
	config: OutlineConfig,
	sourceUrl: string,
	collectionId: string,
	options?: OutlineRequestOptions,
): Promise<OutlineDocument | null> {
	if (!sourceUrl) return null;
	const result = await outlineRequest<{ data?: Array<{ document?: RawOutlineDocument & { text?: string } }> }>(
		config,
		'documents.search',
		{ query: `"${sourceUrl}"`, collectionId, limit: 10 },
		options,
	);
	const documents = (Array.isArray(result.data) ? result.data : [])
		.map(item => item?.document)
		.filter((doc): doc is RawOutlineDocument & { text?: string } => isLiveDocument(doc))
		.filter(doc => !doc.collectionId || doc.collectionId === collectionId);

	for (const doc of documents.slice(0, 5)) {
		let text = doc.text;
		if (typeof text !== 'string') {
			const info = await outlineRequest<{ data?: { text?: string } }>(config, 'documents.info', { id: doc.id }, options);
			text = info.data?.text ?? '';
		}
		if (text.includes(sourceUrl)) return toOutlineDocument(doc);
	}
	return null;
}
