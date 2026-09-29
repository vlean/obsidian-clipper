import browser from './utils/browser-polyfill';
import Defuddle from 'defuddle/full';
import { createMarkdownContent } from 'defuddle/full';
import { flattenShadowDom } from './utils/flatten-shadow-dom';
import { serializeChildren } from './utils/dom-utils';
import { saveFile } from './utils/file-utils';
import { getDomain } from './utils/string-utils';
import { parseForClip } from './utils/clip-utils';
import { debugLog } from './utils/debug';
import type { AnyHighlightData, HighlighterAPI } from './utils/highlighter';

// content-extract.js — the on-demand extraction bundle.
//
// This is the ONLY place `defuddle` (content extraction + Markdown
// conversion) is loaded into a web page. The core content script
// (content.js) deliberately excludes it so highlighting, notes, the
// selection toolbar, and toasts cost nothing on pages that never clip.
//
// The background injects this bundle with
// `scripting.executeScript({ files: ['content-extract.js'] })` right
// before it needs to run an extraction action, AFTER content.js is
// present (see ensureExtractionLoaded in background.ts). Both bundles
// run in the same isolated world, so extract reads live highlight state
// through the `window.__obsidianHighlighter` bridge that core exposes,
// rather than importing highlighter.ts a second time (which would give
// this bundle its own, divergent copy of the mutable highlight state).

declare global {
	interface Window {
		obsidianClipperExtractGeneration?: number;
	}
}

interface ContentResponse {
	content: string;
	selectedHtml: string;
	extractedContent: { [key: string]: string };
	schemaOrgData: any;
	fullHtml: string;
	highlights: string[];
	highlightRecords: AnyHighlightData[];
	title: string;
	description: string;
	domain: string;
	favicon: string;
	image: string;
	parseTime: number;
	published: string;
	author: string;
	site: string;
	wordCount: number;
	language: string;
	metaTags: { name?: string | null; property?: string | null; content: string | null }[];
}

(function() {
	// A generation counter, mirroring the core content script, lets a freshly
	// injected extract bundle (e.g. after an extension update) supersede any
	// stale listener still living in the page.
	window.obsidianClipperExtractGeneration = (window.obsidianClipperExtractGeneration ?? 0) + 1;
	const myGeneration = window.obsidianClipperExtractGeneration;

	debugLog('Clipper', 'Initializing content-extract bundle, generation', myGeneration);

	// Read highlight state from the core content script's bridge. Extract never
	// owns highlighter state; if core somehow isn't present the arrays are empty
	// (extraction still succeeds, just without highlight data).
	const hl = (): HighlighterAPI | undefined => window.__obsidianHighlighter;

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		// Yield to a newer generation of this bundle rather than answering from
		// a potentially stale context.
		if (window.obsidianClipperExtractGeneration !== myGeneration) {
			return;
		}

		// Distinct from core's "ping" so the background can confirm the extract
		// bundle specifically is ready without core answering on its behalf.
		if (request.action === "pingExtract") {
			sendResponse({ ready: true });
			return true;
		}

		if (request.action === "copyMarkdownToClipboard") {
			flattenShadowDom(document).then(() => {
				try {
					const defuddled = parseForClip(document);

					// Convert HTML content to markdown
					const markdown = createMarkdownContent(defuddled.content, document.URL);

					// Copy to clipboard
					const textArea = document.createElement("textarea");
					textArea.value = markdown;
					document.body.appendChild(textArea);
					textArea.select();
					document.execCommand('copy');
					document.body.removeChild(textArea);

					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to copy markdown to clipboard:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "getSelectionMarkdown") {
			flattenShadowDom(document).then(() => {
				try {
					const selection = window.getSelection();
					let markdown = '';
					if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
						const div = document.createElement('div');
						for (let i = 0; i < selection.rangeCount; i++) {
							div.appendChild(selection.getRangeAt(i).cloneContents());
						}
						const html = serializeChildren(div);
						markdown = html ? createMarkdownContent(html, document.URL) : '';
					}
					sendResponse({
						success: true,
						markdown: markdown.trim(),
						text: (selection?.toString() ?? '').trim(),
						title: document.title,
						url: location.href,
					});
				} catch (err) {
					console.error('Failed to get selection markdown:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "saveMarkdownToFile") {
			flattenShadowDom(document).then(async () => {
				try {
					const defuddled = parseForClip(document);
					const markdown = createMarkdownContent(defuddled.content, document.URL);
					const title = defuddled.title || document.title || 'Untitled';
					const fileName = title.replace(/[/\\?%*:|"<>]/g, '-');
					await saveFile({
						content: markdown,
						fileName,
						mimeType: 'text/markdown',
					});
					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to save markdown file:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "getPageContent") {
			// Flatten shadow DOM before extraction (async, needs main world)
			const flattenTimeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
			Promise.race([flattenShadowDom(document), flattenTimeout]).then(async () => {
				let selectedHtml = '';
				const selection = window.getSelection();

				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					const clonedSelection = range.cloneContents();
					const div = document.createElement('div');
					div.appendChild(clonedSelection);
					selectedHtml = serializeChildren(div);
				}

				// Use parseAsync to ensure async variables like {{transcript}} are available.
				// If it hangs (e.g. another extension has corrupted fetch), fall back to sync parse.
				const defuddle = new Defuddle(document, { url: document.URL });
				const parseTimeout = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('parseAsync timeout')), 8000)
				);
				const defuddled = await Promise.race([defuddle.parseAsync(), parseTimeout])
					.catch(() => defuddle.parse());
				const extractedContent: { [key: string]: string } = {
					...defuddled.variables,
				};

				// Create a new DOMParser
				const parser = new DOMParser();
				// Parse the document's HTML
				const doc = parser.parseFromString(document.documentElement.outerHTML, 'text/html');

				// Remove all script and style elements
				doc.querySelectorAll('script, style').forEach(el => el.remove());

				// Remove style attributes from all elements
				doc.querySelectorAll('*').forEach(el => el.removeAttribute('style'));

				// Convert all relative URLs to absolute
				doc.querySelectorAll('[src], [href]').forEach(element => {
					['src', 'href', 'srcset'].forEach(attr => {
						const value = element.getAttribute(attr);
						if (!value) return;

						if (attr === 'srcset') {
							const newSrcset = value.split(',').map(src => {
								const [url, size] = src.trim().split(' ');
								try {
									const absoluteUrl = new URL(url, document.baseURI).href;
									return `${absoluteUrl}${size ? ' ' + size : ''}`;
								} catch (e) {
									return src;
								}
							}).join(', ');
							element.setAttribute(attr, newSrcset);
						} else if (!value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('//')) {
							try {
								const absoluteUrl = new URL(value, document.baseURI).href;
								element.setAttribute(attr, absoluteUrl);
							} catch (e) {
								console.warn(`Failed to process ${attr} URL:`, value);
							}
						}
					});
				});

				// Get the modified HTML without scripts, styles, and style attributes
				const cleanedHtml = doc.documentElement.outerHTML;

				const highlighter = hl();
				const response: ContentResponse = {
					author: defuddled.author,
					content: defuddled.content,
					description: defuddled.description,
					domain: getDomain(document.URL),
					extractedContent: extractedContent,
					favicon: defuddled.favicon,
					fullHtml: cleanedHtml,
					highlights: highlighter?.getHighlights() ?? [],
					highlightRecords: highlighter?.getHighlightRecords() ?? [],
					image: defuddled.image,
					language: defuddled.language || '',
					parseTime: defuddled.parseTime,
					published: defuddled.published,
					schemaOrgData: defuddled.schemaOrgData,
					selectedHtml: selectedHtml,
					site: defuddled.site,
					title: defuddled.title,
					wordCount: defuddled.wordCount,
					metaTags: defuddled.metaTags || []
				};
				if (defuddled.title) {
					highlighter?.setPageTitle(defuddled.title);
				}
				highlighter?.updatePageDomainSettings({ site: defuddled.site, favicon: defuddled.favicon });
				sendResponse(response);
			}).catch((error: unknown) => {
				console.error('[Obsidian Clipper] getPageContent error:', error);
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
			});
			return true;
		}

		// Not an extraction action: let other listeners (core content script)
		// handle it. Returning undefined keeps this listener out of the way.
		return undefined;
	});
})();
