// Re-hosts remote images in Outline: finds markdown images, asks Outline to
// fetch each one as an attachment of the document, and rewrites the image URLs.
// Failed uploads keep their original URL, so the document is never worse off.

import { mapOutsideCode } from './outline-markdown';
import {
	OutlineApiError,
	OutlineConfig,
	OutlineRequestOptions,
	createOutlineAttachmentFromUrl,
	normalizeOutlineBaseUrl,
} from './outline-client';

export const OUTLINE_MAX_IMAGES_PER_CLIP = 50;
const DEFAULT_CONCURRENCY = 3;

// ![alt](url "title") / ![alt](<url>) — group 3 is the URL
const IMAGE_RE = /(!\[[^\]\n]*\]\(\s*)(<?)([^\s)<>]+)(>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/g;

export interface OutlineImageStats {
	uploaded: number;
	reused: number;
	failed: number;
	skipped: number;
}

export interface UploadOutlineImagesResult extends OutlineImageStats {
	text: string;
	/** Updated source URL → attachment URL cache for the document */
	attachments: Record<string, string>;
}

/** Unique image URLs referenced by markdown images outside code, in order. */
export function findMarkdownImageUrls(markdown: string): string[] {
	const urls: string[] = [];
	mapOutsideCode(markdown, text => {
		for (const match of text.matchAll(IMAGE_RE)) urls.push(match[3]);
		return text;
	});
	return Array.from(new Set(urls));
}

/** Rewrites markdown image URLs found in `replacements`, leaving code untouched. */
export function replaceMarkdownImageUrls(markdown: string, replacements: Record<string, string>): string {
	return mapOutsideCode(markdown, text =>
		text.replace(IMAGE_RE, (whole, open: string, lt: string, url: string, close: string) => {
			const replacement = replacements[url];
			return replacement ? `${open}${lt}${replacement}${close}` : whole;
		})
	);
}

/** Only public http(s) images that aren't already hosted by this Outline server. */
export function isUploadableImageUrl(url: string, outlineBaseUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	try {
		if (parsed.origin === new URL(normalizeOutlineBaseUrl(outlineBaseUrl)).origin) return false;
	} catch {
		// Invalid base URL: nothing to compare against
	}
	return true;
}

function isFatal(error: unknown): boolean {
	return error instanceof OutlineApiError
		&& (error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'rateLimited' || error.kind === 'config');
}

export async function uploadOutlineImages(
	config: OutlineConfig,
	markdown: string,
	params: {
		documentId: string;
		attachments?: Record<string, string>;
		maxImages?: number;
		concurrency?: number;
	},
	options?: OutlineRequestOptions,
): Promise<UploadOutlineImagesResult> {
	const cache = { ...(params.attachments ?? {}) };
	const maxImages = params.maxImages ?? OUTLINE_MAX_IMAGES_PER_CLIP;
	const stats: OutlineImageStats = { uploaded: 0, reused: 0, failed: 0, skipped: 0 };

	const candidates = findMarkdownImageUrls(markdown).filter(url => isUploadableImageUrl(url, config.baseUrl));
	const replacements: Record<string, string> = {};
	const pending: string[] = [];
	for (const url of candidates) {
		if (cache[url]) {
			replacements[url] = cache[url];
			stats.reused++;
		} else if (pending.length < maxImages) {
			pending.push(url);
		} else {
			stats.skipped++;
		}
	}

	// Small worker pool; stop early on errors that will affect every request
	let aborted = false;
	let cursor = 0;
	const worker = async () => {
		while (cursor < pending.length) {
			const url = pending[cursor++];
			if (aborted) {
				stats.failed++;
				continue;
			}
			try {
				const attachmentUrl = await createOutlineAttachmentFromUrl(config, url, params.documentId, options);
				replacements[url] = attachmentUrl;
				cache[url] = attachmentUrl;
				stats.uploaded++;
			} catch (error) {
				console.warn('Failed to upload image to Outline:', url, error);
				stats.failed++;
				if (isFatal(error)) aborted = true;
			}
		}
	};
	const concurrency = Math.max(1, params.concurrency ?? DEFAULT_CONCURRENCY);
	await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

	return { ...stats, text: replaceMarkdownImageUrls(markdown, replacements), attachments: cache };
}
