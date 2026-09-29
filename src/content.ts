import browser from './utils/browser-polyfill';
import * as highlighter from './utils/highlighter';
import { removeExistingHighlights } from './utils/highlighter-overlays';
import { loadSettings, generalSettings } from './utils/storage-utils';
import { extractContentBySelector as extractContentBySelectorShared } from './utils/shared';
import { debugLog } from './utils/debug';
import { updateSidebarWidth, addResizeHandle, cleanupResizeHandlers } from './utils/iframe-resize';
import { showPageToast } from './utils/page-toast';
import {
	maybeShowSelectionToolbar,
	renderNoteBubbles,
	updateSelectionToolbarSettings,
	setOutlineConfiguredForToolbar,
} from './utils/selection-toolbar-ui';
import { registerHighlightRenderHook } from './utils/highlighter-overlays';
import { isOutlineConfigured } from './utils/outline-service';
import { OUTLINE_API_KEY_STORAGE_KEY } from './utils/storage-utils';
import { initializeI18n } from './utils/i18n';

declare global {
	interface Window {
		obsidianClipperGeneration?: number;
	}
}

// IIFE to scope variables and allow safe re-execution
(function() {
	// Bump the generation counter on every injection. Older listeners close
	// over their own generation value and bail out when they see a newer one,
	// so a zombie content script (runtime invalidated after extension update)
	// will silently yield to the freshly-injected instance.
	window.obsidianClipperGeneration = (window.obsidianClipperGeneration ?? 0) + 1;
	const myGeneration = window.obsidianClipperGeneration;

	debugLog('Clipper', 'Initializing content script, generation', myGeneration);

	let isHighlighterMode = false;
	const iframeId = 'obsidian-clipper-iframe';
	const containerId = 'obsidian-clipper-container';

	function removeContainer(container: HTMLElement) {
		container.classList.add('is-closing');
		updateSidebarWidth(document, null);
		cleanupResizeHandlers(document);
		container.addEventListener('animationend', () => {
			container.remove();
			highlighter.repositionHighlights();
		}, { once: true });
	}

	async function toggleIframe() {
		const existingContainer = document.getElementById(containerId);
		if (existingContainer) {
			removeContainer(existingContainer);
			return;
		}

		await ensureHighlighterCSS();

		const container = document.createElement('div');
		container.id = containerId;
		container.classList.add('is-open');

		const { clipperIframeWidth, clipperIframeHeight } = await browser.storage.local.get(['clipperIframeWidth', 'clipperIframeHeight']);
		if (clipperIframeWidth) {
			container.style.width = `${clipperIframeWidth}px`;
		}
		if (clipperIframeHeight) {
			container.style.height = `${clipperIframeHeight}px`;
		}

		const iframe = document.createElement('iframe');
		iframe.id = iframeId;
		iframe.allow = 'clipboard-write; web-share';
		iframe.src = browser.runtime.getURL('side-panel.html?context=iframe');
		container.appendChild(iframe);

		const resizeCallbacks = {
			onResize: () => highlighter.repositionHighlights(),
			onResizeEnd: () => highlighter.repositionHighlights(),
		};
		addResizeHandle(document, container, 'w', resizeCallbacks);
		addResizeHandle(document, container, 's', resizeCallbacks);
		addResizeHandle(document, container, 'sw', resizeCallbacks);

		document.body.appendChild(container);
		updateSidebarWidth(document, container);
		container.addEventListener('animationend', () => highlighter.repositionHighlights(), { once: true });
	}

	// Firefox
	browser.runtime.sendMessage({ action: "contentScriptLoaded" });

	let initializationPromise: Promise<void> = Promise.resolve();

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		// If a newer generation of this content script has been injected,
		// yield to it rather than responding from a potentially stale context.
		if (window.obsidianClipperGeneration !== myGeneration) {
			return;
		}

		// These actions are owned by the on-demand extraction bundle
		// (content-extract.js), which the background injects before sending
		// them. Yield (return undefined, don't hold the channel) so the extract
		// listener answers them instead of this core script.
		if (
			request.action === "getPageContent" ||
			request.action === "copyMarkdownToClipboard" ||
			request.action === "saveMarkdownToFile" ||
			request.action === "getSelectionMarkdown" ||
			request.action === "pingExtract"
		) {
			return undefined;
		}

		if (request.action === "ping") {
			initializationPromise.then(() => sendResponse({}));
			return true;
		}

		if (request.action === "toggle-iframe") {
			toggleIframe().then(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "close-iframe") {
			const existingContainer = document.getElementById(containerId);
			if (existingContainer) {
				removeContainer(existingContainer);
			}
			return;
		}

		if (request.action === "copy-text-to-clipboard") {
			const textArea = document.createElement("textarea");
			textArea.value = request.text;
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				sendResponse({success: true});
			} catch (err) {
				sendResponse({success: false});
			}
			document.body.removeChild(textArea);
			return true;
		}

		if (request.action === "showPageToast") {
			try {
				showPageToast(String(request.message ?? ''), {
					variant: request.variant === 'error' ? 'error' : 'info',
					duration: typeof request.duration === 'number' ? request.duration : undefined,
				});
				sendResponse({ success: true });
			} catch (err) {
				console.error('Failed to show page toast:', err);
				sendResponse({ success: false, error: (err as Error).message });
			}
			return true;
		}

		if (request.action === "showSelectionToolbar") {
			ensureHighlighterCSS().then(() => {
				maybeShowSelectionToolbar();
			});
			sendResponse({ success: true });
			return true;
		}

		if (request.action === "extractContent") {
			const content = extractContentBySelector(request.selector, request.attribute, request.extractHtml);
			sendResponse({ content: content });
		} else if (request.action === "paintHighlights") {
			ensureHighlighterCSS().then(() => highlighter.loadHighlights()).then(() => {
				if (generalSettings.alwaysShowHighlights) {
					highlighter.applyHighlights();
				}
				sendResponse({ success: true });
			});
			return true;
		} else if (request.action === "setHighlighterMode") {
			isHighlighterMode = request.isActive;
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(isHighlighterMode);
			updateHasHighlights();
			sendResponse({ success: true });
			return true;
		} else if (request.action === "getHighlighterMode") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" }).then(sendResponse);
			return true;
		} else if (request.action === "toggleHighlighter") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightSelection") {
			ensureHighlighterCSS();
			// keepMenuState lets the background add a highlight (e.g. after an
			// Outline excerpt) without turning the highlighter menu/mode on.
			if (!request.keepMenuState) {
				highlighter.toggleHighlighterMenu(request.isActive);
			}
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				highlighter.handleTextSelection(selection);
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightElement") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			if (request.targetElementInfo) {
				const { mediaType, srcUrl, pageUrl } = request.targetElementInfo;
				
				let elementToHighlight: Element | null = null;

				// Function to compare URLs, handling both absolute and relative paths
				const urlMatches = (elementSrc: string, targetSrc: string) => {
					const elementUrl = new URL(elementSrc, pageUrl);
					const targetUrl = new URL(targetSrc, pageUrl);
					return elementUrl.href === targetUrl.href;
				};

				// Try to find the element using the src attribute
				elementToHighlight = document.querySelector(`${mediaType}[src="${srcUrl}"]`);

				// If not found, try with relative URL
				if (!elementToHighlight) {
					const relativeSrc = new URL(srcUrl).pathname;
					elementToHighlight = document.querySelector(`${mediaType}[src="${relativeSrc}"]`);
				}

				// If still not found, iterate through all elements of the media type
				if (!elementToHighlight) {
					const elements = Array.from(document.getElementsByTagName(mediaType));
					for (const el of elements) {
						if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
							if (urlMatches(el.src, srcUrl)) {
								elementToHighlight = el;
								break;
							}
						}
					}
				}

				if (elementToHighlight) {
					highlighter.highlightElement(elementToHighlight);
				} else {
					console.warn('Could not find element to highlight. Info:', request.targetElementInfo);
				}
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "clearHighlights") {
			highlighter.clearHighlights();
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "getHighlighterState") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" })
				.then(response => {
					sendResponse(response);
				})
				.catch(error => {
					console.error("Error getting highlighter mode:", error);
					sendResponse({ isActive: false });
				});
			return true;
		} else if (request.action === "getReaderModeState") {
			sendResponse({ isActive: document.documentElement.classList.contains('obsidian-reader-active') });
			return true;
		}
		return true;
	});

	function extractContentBySelector(selector: string, attribute?: string, extractHtml: boolean = false): string | string[] {
		return extractContentBySelectorShared(document, selector, attribute, extractHtml);
	}

	function updateHasHighlights() {
		const hasHighlights = highlighter.getHighlights().length > 0;
		browser.runtime.sendMessage({ action: "updateHasHighlights", hasHighlights });
	}

	let highlighterCSSPromise: Promise<void> | null = null;
	function ensureHighlighterCSS(): Promise<void> {
		if (!highlighterCSSPromise) {
			highlighterCSSPromise = new Promise<void>((resolve) => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = browser.runtime.getURL('highlighter.css');
				link.onload = () => resolve();
				link.onerror = () => resolve();
				(document.head || document.documentElement).appendChild(link);
			});
		}
		return highlighterCSSPromise;
	}

	async function initializeHighlighter() {
		// Load UI translations before rendering any toolbar/overlay/toast text.
		// In a content script this asks the background page for the locale JSON
		// (see getLocaleMessages). Failures fall back to English/native strings
		// inside getMessage, so this must never throw.
		await initializeI18n().catch((error) => {
			console.debug('[Obsidian Clipper] i18n init failed, using fallback strings:', error);
		});

		await loadSettings();

		if (generalSettings.alwaysShowHighlights) {
			const result = await browser.storage.local.get('highlights');
			const allHighlights = (result.highlights || {}) as Record<string, unknown>;
			if (allHighlights[window.location.href]) {
				await ensureHighlighterCSS();
			}
		}

		await highlighter.loadHighlights();
		highlighter.setPageTitle(document.title);
		updateHasHighlights();

		// Selection toolbar (C1) + visible note bubbles (C2) configuration.
		await refreshToolbarConfig();
		// Redraw note bubbles whenever highlights render or reposition.
		registerHighlightRenderHook(() => renderNoteBubbles());
		renderNoteBubbles();
	}

	// Mirror the toolbar-relevant settings from sync storage and detect whether
	// Outline is configured (so the excerpt button only appears when usable).
	async function refreshToolbarConfig() {
		try {
			const syncData = await browser.storage.sync.get('highlighter_settings');
			const hs = (syncData.highlighter_settings || {}) as {
				highlighterEnabled?: boolean;
				selectionToolbar?: boolean;
				showHighlightNotes?: boolean;
			};
			updateSelectionToolbarSettings({
				highlighterEnabled: hs.highlighterEnabled,
				selectionToolbar: hs.selectionToolbar,
				showHighlightNotes: hs.showHighlightNotes,
			});
		} catch { /* keep defaults */ }
		try {
			const apiKeyResult = await browser.storage.local.get(OUTLINE_API_KEY_STORAGE_KEY);
			const apiKey = apiKeyResult[OUTLINE_API_KEY_STORAGE_KEY] as string | undefined;
			setOutlineConfiguredForToolbar(isOutlineConfigured(generalSettings.outline, apiKey));
		} catch { /* leave as-is */ }
	}

	// React to settings changes (toolbar/notes toggles, Outline config) live.
	browser.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === 'sync' && (changes.highlighter_settings || changes.outline_settings)) {
			// generalSettings.outline is refreshed via loadSettings elsewhere;
			// re-read here so the excerpt button and bubbles reflect changes.
			loadSettings().then(() => refreshToolbarConfig()).then(() => renderNoteBubbles());
		}
		if (areaName === 'local' && changes[OUTLINE_API_KEY_STORAGE_KEY]) {
			refreshToolbarConfig();
		}
	});

	// A ping should only report ready after settings and saved highlights have
	// finished loading. This keeps the first lazy-loaded action from racing
	// content-script initialization.
	initializationPromise = initializeHighlighter().catch((error) => {
		console.error('[Obsidian Clipper] Failed to initialize highlighter:', error);
	});

	// Expose highlighter API on window so reader-script.js (a separate
	// webpack bundle injected when reader mode activates) can delegate
	// all state operations to this single module instance. Without this,
	// both bundles own a copy of highlighter.ts with independent mutable
	// state — the bridge ensures one source of truth per tab.
	window.__obsidianHighlighter = {
		toggleHighlighterMenu: highlighter.toggleHighlighterMenu,
		handleTextSelection: highlighter.handleTextSelection,
		highlightElement: highlighter.highlightElement,
		applyHighlights: highlighter.applyHighlights,
		loadHighlights: highlighter.loadHighlights,
		invalidateHighlightCache: highlighter.invalidateHighlightCache,
		repositionHighlights: highlighter.repositionHighlights,
		getHighlights: highlighter.getHighlights,
		getHighlightRecords: highlighter.getHighlightRecords,
		setPageUrl: highlighter.setPageUrl,
		setPageTitle: highlighter.setPageTitle,
		updatePageDomainSettings: highlighter.updatePageDomainSettings,
		clearHighlights: highlighter.clearHighlights,
		saveHighlights: highlighter.saveHighlights,
		updateHighlighterMenu: highlighter.updateHighlighterMenu,
		removeExistingHighlights,
		ensureHighlighterCSS: () => { ensureHighlighterCSS(); },
	} satisfies highlighter.HighlighterAPI;

	// Call updateHasHighlights when the page loads
	window.addEventListener('load', updateHasHighlights);

	// Deactivate highlighter mode on unload
	function handlePageUnload() {
		if (isHighlighterMode) {
			highlighter.toggleHighlighterMenu(false);
			browser.runtime.sendMessage({ action: "highlighterModeChanged", isActive: false });
			browser.storage.local.set({ isHighlighterMode: false });
		}
	}

	window.addEventListener('beforeunload', handlePageUnload);

	// Listen for custom events from the reader script
	document.addEventListener('obsidian-reader-init', async () => {
		// Find the highlighter button
		const button = document.querySelector('[data-action="toggle-highlighter"]');
		if (button) {
			// Handle highlighter button clicks
			button.addEventListener('click', async (e) => {
				try {
					// First try to get the tab ID from the background script
					const response = await browser.runtime.sendMessage({ action: "ensureContentScriptLoaded" });
					
					let tabId: number | undefined;
					if (response && typeof response === 'object') {
						tabId = (response as { tabId: number }).tabId;
					}

					// If we didn't get a tab ID, try to get it from the background script
					if (!tabId) {
						try {
							const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
							if (response && !response.error && response.tabId) {
								tabId = response.tabId;
							}
						} catch (error) {
							console.error('[Content] Failed to get tab ID from background script:', error);
						}
					}

					if (tabId) {
						await browser.runtime.sendMessage({ action: "toggleHighlighterMode", tabId });
					} else {
						console.error('[Content]','Could not determine tab ID');
					}
				} catch (error) {
					console.error('[Content]','Error in toggle flow:', error);
				}
			});
		}
	});

})();
