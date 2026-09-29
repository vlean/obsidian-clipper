import browser from 'webextension-polyfill';
import { detectBrowser } from './utils/browser-detection';
import { updateCurrentActiveTab, isValidUrl, isBlankPage, isNormalPageUrl } from './utils/active-tab-manager';
import { TextHighlightData } from './utils/highlighter';
import { debounce } from './utils/debounce';
import { Settings } from './types/types';
import { debugLog } from './utils/debug';
import { incrementStat, OUTLINE_API_KEY_STORAGE_KEY, sanitizeOutlineSettings } from './utils/storage-utils';
import { hasStoredHighlights } from './utils/url-utils';
import { handleOutlineMessage, OUTLINE_ACTIONS, isOutlineConfigured } from './utils/outline-service';
import { handleOutlineExcerptToDaily, OutlineExcerptRequest, OutlineExcerptResponse } from './utils/outline-excerpt';
import { getOutlineErrorMessageKey } from './utils/outline-client';
import { updateClippedBadgeForTab } from './utils/outline-badge';

const YOUTUBE_EMBED_RULE_ID = 9001;
const YOUTUBE_INNERTUBE_RULE_ID = 9002;

// Chrome: declarativeNetRequest to rewrite Referer on YouTube embeds.
// Safari/Firefox use the native video element instead (see reader.ts).
async function enableYouTubeEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
		addRules: [{
			id: YOUTUBE_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://obsidian.md/'
				}]
			},
			condition: {
				urlFilter: '||youtube.com/embed/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableYouTubeEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID]
	});
}

// Set Origin header on YouTube innertube API requests from the extension.
// YouTube doesn't accept chrome-extension://...
async function enableYouTubeInnertubeRule(): Promise<void> {
	const dnr = (typeof chrome !== 'undefined' && chrome.declarativeNetRequest)
		|| (typeof browser !== 'undefined' && (browser as any).declarativeNetRequest);
	if (!dnr) return;
	try {
		await dnr.updateSessionRules({
			removeRuleIds: [YOUTUBE_INNERTUBE_RULE_ID],
			addRules: [{
				id: YOUTUBE_INNERTUBE_RULE_ID,
				priority: 1,
				action: {
					type: 'modifyHeaders' as any,
					requestHeaders: [
						{ header: 'Origin', operation: 'set' as any, value: 'https://www.youtube.com' },
						{ header: 'Referer', operation: 'set' as any, value: 'https://www.youtube.com/' },
					]
				},
				condition: {
					urlFilter: '||youtube.com/youtubei/',
					resourceTypes: ['xmlhttprequest' as any],
					initiatorDomains: [chrome?.runtime?.id || ''].filter(Boolean),
				}
			}]
		});
	} catch { /* Firefox/Safari use webRequest or native messaging instead */ }
}

// Firefox/Safari: use webRequest.onBeforeSendHeaders to set Origin/Referer on
// YouTube innertube requests. Fallback for browsers where declarativeNetRequest
// doesn't work or isn't supported.
if (typeof browser !== 'undefined' && browser.webRequest?.onBeforeSendHeaders) {
	try {
		browser.webRequest.onBeforeSendHeaders.addListener(
			(details) => {
				// Only modify requests from tabs showing extension pages
				if (details.tabId && details.tabId > 0) {
					// Check asynchronously would be complex — instead check
					// if the request has an extension origin or referer
					const refHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'referer');
					const refValue = refHeader?.value || '';
					const originHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'origin');
					const originValue = originHeader?.value || '';
					const isFromExtension = refValue.startsWith('moz-extension://') || originValue.startsWith('moz-extension://')
						|| refValue.startsWith('safari-web-extension://') || originValue.startsWith('safari-web-extension://');
					if (!isFromExtension) return { requestHeaders: details.requestHeaders };
				}

				const headers = details.requestHeaders || [];
				const setHeader = (name: string, value: string) => {
					const existing = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
					if (existing) {
						existing.value = value;
					} else {
						headers.push({ name, value });
					}
				};
				setHeader('Origin', 'https://www.youtube.com');
				setHeader('Referer', 'https://www.youtube.com/');
				return { requestHeaders: headers };
			},
			{ urls: ['*://www.youtube.com/*'] },
			['blocking', 'requestHeaders']
		);
	} catch { /* webRequest not available */ }
}

let sidePanelOpenWindows: Set<number> = new Set();
let highlighterModeState: { [tabId: number]: boolean } = {};
let readerModeState: { [tabId: number]: boolean } = {};
let hasHighlights = false;
let isContextMenuCreating = false;

// Whether Outline is configured enough to clip to it: an instance URL, a
// default collection, and an API key present in local storage. Cached so the
// context-menu rebuild (which runs often) doesn't hit storage every time; kept
// fresh by the storage.onChanged listener below.
let outlineConfigured = false;

// Reads storage and updates the cached `outlineConfigured` flag. The API key is
// only checked for presence; its value never leaves this function.
async function refreshOutlineConfigured(): Promise<boolean> {
	try {
		const [syncData, localData] = await Promise.all([
			browser.storage.sync.get('outline_settings'),
			browser.storage.local.get(OUTLINE_API_KEY_STORAGE_KEY),
		]);
		const settings = sanitizeOutlineSettings(syncData.outline_settings);
		const apiKey = localData[OUTLINE_API_KEY_STORAGE_KEY];
		outlineConfigured = isOutlineConfigured(settings, typeof apiKey === 'string' ? apiKey : '');
	} catch (error) {
		console.debug('Failed to read Outline configuration:', error);
	}
	return outlineConfigured;
}

let popupPorts: { [tabId: number]: browser.Runtime.Port } = {};
const contentScriptLoads = new Map<number, { url: string; promise: Promise<void> }>();
// Highlighter mode changes wait on lazy injection, so run them one at a time
// per tab. Otherwise two quick toggles both read the same starting state.
const highlighterModeQueues = new Map<number, Promise<unknown>>();

function queueHighlighterModeChange<T>(tabId: number, change: () => Promise<T>): Promise<T> {
	const previous = highlighterModeQueues.get(tabId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(change);
	highlighterModeQueues.set(tabId, next);
	next.catch(() => {}).then(() => {
		if (highlighterModeQueues.get(tabId) === next) {
			highlighterModeQueues.delete(tabId);
		}
	});
	return next;
}

// A reload can replace the document without changing its URL. Invalidate the
// old document's pending load as soon as navigation starts so the replacement
// document can inject independently.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === 'loading') {
		contentScriptLoads.delete(tabId);
	}
});

async function injectContentScript(tabId: number): Promise<void> {
	if (browser.scripting) {
		debugLog('Clipper', 'Using scripting API');
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
	} else {
		debugLog('Clipper', 'Using tabs.executeScript fallback');
		await browser.tabs.executeScript(tabId, { file: 'content.js' });
	}
	debugLog('Clipper', 'Injection completed, waiting for init...');

	// Poll until the content script responds, rather than a fixed delay.
	// Try immediately after injection, then back off with 50ms sleeps.
	let ready = false;
	for (let i = 0; i < 8; i++) {
		try {
			await browser.tabs.sendMessage(tabId, { action: "ping" });
			ready = true;
			break;
		} catch {
			// Not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!ready) {
		throw new Error('Content script did not respond after injection');
	}
	debugLog('Clipper', 'Post-injection ping succeeded');
}

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	// Resolve the current page before reusing an in-flight load. A tab can
	// navigate while injection is pending, and the new document must not reuse
	// work that was started for the previous URL.
	const tab = await browser.tabs.get(tabId);
	if (!tab.url || !isValidUrl(tab.url)) {
		throw new Error('Invalid URL for content script injection');
	}

	const existingLoad = contentScriptLoads.get(tabId);
	if (existingLoad?.url === tab.url) {
		return existingLoad.promise;
	}

	const load = (async () => {
		try {
			// Attempt to send a message to the content script
			await browser.tabs.sendMessage(tabId, { action: "ping" });
			debugLog('Clipper', 'Content script ping succeeded');
		} catch (error) {
			// If the message fails, the content script is not loaded, so inject it
			debugLog('Clipper', 'Ping failed, injecting content script...', error);
			await injectContentScript(tabId);
		}
	})();

	const entry = { url: tab.url, promise: load };
	contentScriptLoads.set(tabId, entry);
	try {
		await load;
	} finally {
		if (contentScriptLoads.get(tabId) === entry) {
			contentScriptLoads.delete(tabId);
		}
	}
}

async function sendMessageToContentScript(tabId: number, message: any): Promise<any> {
	await ensureContentScriptLoadedInBackground(tabId);
	return browser.tabs.sendMessage(tabId, message);
}

async function loadContentScriptForHighlights(tabId: number, rawUrl: string): Promise<boolean> {
	const [syncData, localData] = await Promise.all([
		browser.storage.sync.get('highlighter_settings'),
		browser.storage.local.get('highlights'),
	]);
	const highlighterSettings = syncData.highlighter_settings as { alwaysShowHighlights?: boolean } | undefined;
	if ((highlighterSettings?.alwaysShowHighlights ?? true) === false) {
		return false;
	}

	if (!hasStoredHighlights(localData.highlights, rawUrl)) {
		return false;
	}

	await ensureContentScriptLoadedInBackground(tabId);
	return true;
}

// Route a message to a tab, handling both normal pages (via content script)
// and extension pages like the reader page (via runtime.sendMessage forwarding).
async function routeMessageToTab(tabId: number, message: any): Promise<any> {
	const tab = await browser.tabs.get(tabId);
	if (isNormalPageUrl(tab.url)) {
		return sendMessageToContentScript(tabId, message);
	} else {
		return browser.runtime.sendMessage({
			action: 'extensionPageMessage',
			targetTabId: tabId,
			message
		});
	}
}

function getHighlighterModeForTab(tabId: number): boolean {
	return highlighterModeState[tabId] ?? false;
}

function getReaderModeForTab(tabId: number): boolean {
	return readerModeState[tabId] ?? false;
}

function isReaderPageUrl(url: string | undefined): string | null {
	if (!url) return null;
	const readerPagePrefix = browser.runtime.getURL('reader.html');
	if (url.startsWith(readerPagePrefix)) {
		try {
			const parsed = new URL(url);
			return parsed.searchParams.get('url');
		} catch {}
	}
	return null;
}

async function exitReaderPageIfNeeded(tabId: number, readerUrl?: string): Promise<boolean> {
	let originalUrl: string | null = null;
	try {
		const tab = await browser.tabs.get(tabId);
		originalUrl = isReaderPageUrl(tab.url);
	} catch {}

	// Fallback: the embedded clipper passes the reader URL when
	// tabs.get() can't access the extension page URL
	if (!originalUrl && readerUrl) {
		originalUrl = isReaderPageUrl(readerUrl);
	}

	if (originalUrl) {
		await browser.tabs.update(tabId, { url: originalUrl });
		readerModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		return true;
	}
	return false;
}

async function initialize() {
	try {
		// Set up tab listeners
		await setupTabListeners();

		browser.tabs.onRemoved.addListener((tabId) => {
			delete highlighterModeState[tabId];
			highlighterModeQueues.delete(tabId);
			delete readerModeState[tabId];
			contentScriptLoads.delete(tabId);
		});

		// Keep the "already clipped" toolbar badge in sync with the active tab.
		// Storage reads only; the badge API is guarded for browsers without it.
		browser.tabs.onActivated.addListener(async ({ tabId }) => {
			try {
				const tab = await browser.tabs.get(tabId);
				await updateClippedBadgeForTab(tabId, tab.url);
			} catch {
				// Tab may have closed
			}
		});
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete' || typeof changeInfo.url === 'string') {
				updateClippedBadgeForTab(tabId, changeInfo.url ?? tab.url);
			}
		});
		
		// Initialize context menu
		await debouncedUpdateContextMenu(-1);

		// Enable Origin header for YouTube innertube API requests
		await enableYouTubeInnertubeRule();

		// Set up action popup based on openBehavior setting
		await updateActionPopup();

		debugLog('Clipper', 'Background script initialized successfully');
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

// Check if a popup is open for a given tab
function isPopupOpen(tabId: number): boolean {
	return popupPorts.hasOwnProperty(tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId].postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}



// Safari: route fetch through native messaging (URLSession in Swift).
// Called from the background script where sendNativeMessage works reliably.
async function nativeFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
	try {
		const result = await browser.runtime.sendNativeMessage('application.id', {
			type: 'fetchRequest',
			url,
			method: options?.method || 'GET',
			headers: options?.headers || {},
			body: options?.body || null,
		}) as { ok: boolean; status: number; text: string; error?: string };
		return result || { ok: false, status: 0, text: '', error: 'Empty native response' };
	} catch (err) {
		return { ok: false, status: 0, text: '', error: (err as Error).message };
	}
}

// Fetch proxy for extension pages (reader, highlights).
// Returns a Promise for the webextension-polyfill.
// On Firefox MV3, host_permissions require explicit user grant —
// callers detect CORS_PERMISSION_NEEDED and prompt via permissions.request().
browser.runtime.onMessage.addListener((request: unknown) => {
	if (typeof request !== 'object' || request === null) return;
	if ((request as any).action !== 'fetchProxy') return;
	const { url, options } = request as { url: string; options?: any };
	const fetchOptions: RequestInit = {};
	if (options?.method) fetchOptions.method = options.method;
	if (options?.headers) fetchOptions.headers = options.headers;
	if (options?.body) fetchOptions.body = options.body;
	return fetch(url, fetchOptions)
		.then(async (resp) => {
			const text = await resp.text();
			// If YouTube returns bot-detection HTML, try native messaging (Safari)
			if (!resp.ok && (text.includes('Sorry') || text.includes('<html')) && typeof browser.runtime.sendNativeMessage === 'function') {
				return nativeFetch(url, options);
			}
			return { ok: resp.ok, status: resp.status, text, finalUrl: resp.url };
		})
		.catch(async () => {
			// CORS failure — try native messaging (Safari), else report permission needed
			if (typeof browser.runtime.sendNativeMessage === 'function') {
				return nativeFetch(url, options);
			}
			return { ok: false, status: 0, text: '', error: 'CORS_PERMISSION_NEEDED' };
		});
});

browser.runtime.onMessage.addListener((request: unknown, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void): true | undefined => {
	if (typeof request === 'object' && request !== null) {
		const typedRequest = request as { action: string; isActive?: boolean; hasHighlights?: boolean; tabId?: number; text?: string; section?: string; readerUrl?: string; url?: string };

		const outlineResponse = handleOutlineMessage(request as { action?: string } & Record<string, unknown>);
		if (outlineResponse) {
			outlineResponse.then(sendResponse);
			return true;
		}

		// Excerpt-to-daily needs the sender tab (for selection, highlight, toast),
		// so it is handled here rather than in handleOutlineMessage. Stage 2's
		// in-page toolbar sends this via runtime.sendMessage from the content script.
		if (typedRequest.action === OUTLINE_ACTIONS.excerptToDaily) {
			const excerptRequest = request as OutlineExcerptRequest;
			const tabId = sender.tab?.id ?? typedRequest.tabId;
			if (typeof tabId !== 'number') {
				sendResponse({ success: false, errorKind: 'validation', error: 'No tab for excerpt' });
				return true;
			}
			runOutlineExcerptToDaily(excerptRequest, tabId)
				.then(sendResponse)
				.catch((error) => sendResponse({
					success: false,
					errorKind: 'server',
					error: error instanceof Error ? error.message : String(error),
				}));
			return true;
		}

		if (typedRequest.action === 'loadContentScriptForHighlights') {
			const tabId = sender.tab?.id;
			if (!tabId || !typedRequest.url) {
				sendResponse({ success: false, loaded: false });
				return true;
			}
			loadContentScriptForHighlights(tabId, typedRequest.url)
				.then((loaded) => sendResponse({ success: true, loaded }))
				.catch((error) => sendResponse({
					success: false,
					loaded: false,
					error: error instanceof Error ? error.message : String(error),
				}));
			return true;
		}

		// The content-loader detected a settled text selection and wants the
		// full content script to render the selection toolbar. Ensure the
		// content script is loaded, then forward the request so it re-validates
		// its guards and shows the toolbar.
		if (typedRequest.action === 'requestSelectionToolbar') {
			const tabId = sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false });
				return true;
			}
			ensureContentScriptLoadedInBackground(tabId)
				.then(() => browser.tabs.sendMessage(tabId, { action: 'showSelectionToolbar' }))
				.then(() => sendResponse({ success: true }))
				.catch((error) => sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				}));
			return true;
		}

		if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
			// Use content script to copy to clipboard
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						const response = await routeMessageToTab(currentTab.id, {
							action: 'copy-text-to-clipboard',
							text: typedRequest.text
						});
						if ((response as any) && (response as any).success) {
							sendResponse({success: true});
						} else {
							sendResponse({success: false, error: 'Failed to copy from content script'});
						}
					} catch (err) {
						sendResponse({ success: false, error: (err as Error).message });
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		// fetchProxy is handled by a separate listener below

		if (typedRequest.action === "extractContent" && sender.tab && sender.tab.id) {
			sendMessageToContentScript(sender.tab.id, request).then(sendResponse);
			return true;
		}

		if (typedRequest.action === "ensureContentScriptLoaded") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				ensureContentScriptLoadedInBackground(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ 
						success: false, 
						error: error instanceof Error ? error.message : String(error) 
					}));
				return true;
			} else {
				sendResponse({ success: false, error: 'No tab ID provided' });
				return true;
			}
		}

		if (typedRequest.action === "enableYouTubeEmbedRule") {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableYouTubeEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (typedRequest.action === "disableYouTubeEmbedRule") {
			disableYouTubeEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (typedRequest.action === "sidePanelOpened") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.add(sender.tab.windowId);
				updateCurrentActiveTab(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "sidePanelClosed") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.delete(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "highlighterModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				highlighterModeState[tabId] = typedRequest.isActive;
				sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: typedRequest.isActive });
				debouncedUpdateContextMenu(tabId);
			}
		}

		if (typedRequest.action === "readerModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				readerModeState[tabId] = typedRequest.isActive;
				debouncedUpdateContextMenu(tabId);
			}
			if (typedRequest.isActive === true) {
				incrementStat('readerMode', undefined, undefined, sender.tab.url, sender.tab.title)
					.catch((error) => debugLog('Reader', 'Failed to record reader mode stat:', error));
			}
		}

		if (typedRequest.action === "highlightsCleared" && sender.tab) {
			hasHighlights = false;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "updateHasHighlights" && sender.tab && typedRequest.hasHighlights !== undefined) {
			hasHighlights = typedRequest.hasHighlights;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "getHighlighterMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getHighlighterModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "getReaderMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getReaderModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "toggleHighlighterMode" && typedRequest.tabId) {
			toggleHighlighterMode(typedRequest.tabId)
				.then(newMode => sendResponse({ success: true, isActive: newMode }))
				.catch(error => sendResponse({ success: false, error: error.message }));
			return true;
		}

		if (typedRequest.action === "openPopup") {
			openPopup()
				.then(() => {
					sendResponse({ success: true });
				})
				.catch((error: unknown) => {
					console.error('Error opening popup in background script:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			return true;
		}

		if (typedRequest.action === "toggleReaderMode" && typedRequest.tabId) {
			const tabId = typedRequest.tabId;
			(async () => {
				// Check if the tab is on the extension's reader.html page
				const wasReaderPage = await exitReaderPageIfNeeded(tabId, typedRequest.readerUrl);
				if (wasReaderPage) {
					sendResponse({ success: true, isActive: false });
					return;
				}
				sendResponse(await toggleReaderModeInTab(tabId));
			})().catch(() => {
				// Page may have reloaded before responding (reader restore)
				sendResponse({ success: true, isActive: false });
			});
			return true;
		}

		if (typedRequest.action === "getActiveTabAndToggleIframe") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						await routeMessageToTab(currentTab.id, { action: "toggle-iframe" });
						sendResponse({success: true});
					} catch (error) {
						console.error('Error sending toggle-iframe message:', error);
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "toggleIframe") {
			const tab = sender.tab;
			if (tab?.id) {
				routeMessageToTab(tab.id, { action: "toggle-iframe" })
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('Error toggling iframe:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
			} else {
				sendResponse({ success: false, error: 'Cannot open iframe on this page' });
			}
			return true;
		}

		if (typedRequest.action === "getActiveTab") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				let currentTab = tabs[0];
				// Fallback for when currentWindow has no tabs (e.g., debugging popup in DevTools)
				if (!currentTab || !currentTab.id) {
					const allActiveTabs = await browser.tabs.query({active: true});
					currentTab = allActiveTabs.find(tab =>
						tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('moz-extension://')
					) || allActiveTabs[0];
				}
				if (currentTab && currentTab.id) {
					sendResponse({tabId: currentTab.id});
				} else {
					sendResponse({error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "openOptionsPage") {
			try {
				if (typeof browser.runtime.openOptionsPage === 'function') {
					// Chrome way
					browser.runtime.openOptionsPage();
				} else {
					// Firefox way
					browser.tabs.create({
						url: browser.runtime.getURL('settings.html')
					});
				}
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening options page:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "openHighlights") {
			const domain = (typedRequest as any).domain;
			const query = domain ? `?domain=${encodeURIComponent(domain)}` : '';
			browser.tabs.create({ url: browser.runtime.getURL(`highlights.html${query}`) });
			sendResponse({ success: true });
			return true;
		}

		if (typedRequest.action === "openSettings") {
			try {
				const section = typedRequest.section ? `?section=${typedRequest.section}` : '';
				browser.tabs.create({
					url: browser.runtime.getURL(`settings.html${section}`)
				});
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening settings:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "copyMarkdownToClipboard" || typedRequest.action === "saveMarkdownToFile") {
			if (sender.tab?.id) {
				routeMessageToTab(sender.tab.id, { action: typedRequest.action })
					.then(() => sendResponse({success: true}))
					.catch((error) => sendResponse({success: false, error: error instanceof Error ? error.message : String(error)}));
				return true;
			}
		}

		if (typedRequest.action === "getTabInfo") {
			browser.tabs.get(typedRequest.tabId as number).then((tab) => {
				// For reader page tabs, return the article URL so the
				// clipper treats it as a normal web page
				const url = isReaderPageUrl(tab.url) ?? tab.url;
				sendResponse({
					success: true,
					tab: {
						id: tab.id,
						url: url
					}
				});
			}).catch((error) => {
				console.error('Error getting tab info:', error);
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "forceInjectContentScript") {
			const tabId = typedRequest.tabId;
			if (tabId) {
				injectContentScript(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('[Obsidian Clipper] forceInjectContentScript failed:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			} else {
				sendResponse({ success: false, error: 'Missing tabId' });
				return true;
			}
		}

		if (typedRequest.action === "sendMessageToTab") {
			const tabId = (typedRequest as any).tabId;
			const message = (typedRequest as any).message;
			if (tabId && message) {
				routeMessageToTab(tabId, message).then((response) => {
					sendResponse(response);
				}).catch((error) => {
					console.error('[Obsidian Clipper] Error sending message to tab:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing tabId or message'
				});
				return true;
			}
		}

		if (typedRequest.action === "openReaderPage") {
			const articleUrl = (typedRequest as any).url;
			if (articleUrl && sender.tab?.id) {
				const readerUrl = browser.runtime.getURL('reader.html?url=' + encodeURIComponent(articleUrl));
				browser.tabs.update(sender.tab.id, { url: readerUrl })
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
			} else {
				sendResponse({ success: false, error: 'Missing URL or tab' });
			}
			return true;
		}

		if (typedRequest.action === "openObsidianUrl") {
			const url = (typedRequest as any).url;
			if (url) {
				browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
					const currentTab = tabs[0];
					if (currentTab && currentTab.id) {
						browser.tabs.update(currentTab.id, { url: url }).then(() => {
							sendResponse({ success: true });
						}).catch((error) => {
							console.error('Error opening Obsidian URL:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error)
							});
						});
					} else {
						sendResponse({
							success: false,
							error: 'No active tab found'
						});
					}
				}).catch((error) => {
					console.error('Error querying tabs:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing URL'
				});
				return true;
			}
		}

		// For other actions that use sendResponse
		if (typedRequest.action === "extractContent" ||
			typedRequest.action === "ensureContentScriptLoaded" ||
			typedRequest.action === "getHighlighterMode" ||
			typedRequest.action === "toggleHighlighterMode" ||
			typedRequest.action === "openObsidianUrl") {
			return true;
		}
	}
	return undefined;
});

browser.commands.onCommand.addListener(async (command, tab) => {
	// Some browsers (e.g. Orion) don't pass the tab parameter, so fall back to querying
	if (!tab?.id) {
		const tabs = await browser.tabs.query({active: true, currentWindow: true});
		tab = tabs[0];
	}

	if (command === 'quick_clip') {
		if (tab?.id) {
			openPopupAndTriggerClip();
		}
	}
	if (command === "toggle_highlighter" && tab?.id) {
		await toggleHighlighterMode(tab.id);
	}
	if (command === "copy_to_clipboard" && tab?.id) {
		await sendMessageToContentScript(tab.id, { action: "copyToClipboard" });
	}
	if (command === "toggle_reader" && tab?.id) {
		await toggleReaderModeInTab(tab.id);
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0].id!;
			}
		}

		const isHighlighterMode = getHighlighterModeForTab(currentTabId);
		const isReaderMode = getReaderModeForTab(currentTabId);

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
				{
					id: "open-obsidian-clipper",
					title: "Save this page",
					contexts: ["page", "selection", "image", "video", "audio"]
				},
				{
					id: 'copy-markdown-to-clipboard',
					title: browser.i18n.getMessage('copyToClipboard'),
					contexts: ["page", "selection"]
				},
				{
					id: isReaderMode ? "exit-reader" : "enter-reader",
					title: isReaderMode ? browser.i18n.getMessage('disableReader') : browser.i18n.getMessage('readerOn'),
					contexts: ["page", "selection"]
				},
				{
					id: isHighlighterMode ? "exit-highlighter" : "enter-highlighter",
					title: isHighlighterMode ? browser.i18n.getMessage('disableHighlighter') : browser.i18n.getMessage('highlighterOn'),
					contexts: ["page","image", "video", "audio"]
				},
				{
					id: "highlight-selection",
					title: "Add to highlights",
					contexts: ["selection"]
				},
				{
					id: "highlight-element",
					title: "Add to highlights",
					contexts: ["image", "video", "audio"]
				},
				{
					id: 'open-embedded',
					title: browser.i18n.getMessage('openEmbedded'),
					contexts: ["page", "selection"]
				}
			];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ["page", "selection"]
			});
		}

		// Outline items appear only when Outline is configured (URL + collection + key).
		await refreshOutlineConfigured();
		if (outlineConfigured) {
			menuItems.push({
				id: 'clip-to-outline',
				title: browser.i18n.getMessage('clipToOutline'),
				contexts: ["page", "selection"]
			});
			menuItems.push({
				id: 'excerpt-to-outline-daily',
				title: browser.i18n.getMessage('excerptToOutlineDaily'),
				contexts: ["selection"]
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100); // 100ms debounce time

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "open-obsidian-clipper") {
		openPopup();
	} else if (info.menuItemId === "enter-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, true);
	} else if (info.menuItemId === "exit-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, false);
	} else if (info.menuItemId === "highlight-selection" && tab && tab.id) {
		await highlightSelection(tab.id, info);
	} else if (info.menuItemId === "highlight-element" && tab && tab.id) {
		await highlightElement(tab.id, info);
	} else if ((info.menuItemId === "enter-reader" || info.menuItemId === "exit-reader") && tab && tab.id) {
		await toggleReaderModeInTab(tab.id);
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await sendMessageToContentScript(tab.id, { action: "toggle-iframe" });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	} else if (info.menuItemId === 'copy-markdown-to-clipboard' && tab && tab.id) {
		await sendMessageToContentScript(tab.id, { action: "copyMarkdownToClipboard" });
	} else if (info.menuItemId === 'clip-to-outline') {
		await openPopupAndClipToOutline();
	} else if (info.menuItemId === 'excerpt-to-outline-daily' && tab && tab.id) {
		await runOutlineExcerptToDailyForTab(tab.id, info);
	}
});

/**
 * Opens the popup and asks it to run a clip once it is ready. Sending the
 * message can race the popup's message listener, so instead of a fixed delay we
 * retry a few times until the popup answers (or give up). `target` is passed
 * through so callers can force an Outline clip. openPopup() can reject on
 * browsers where it needs a user gesture or isn't available; that is logged and
 * swallowed so there is no unhandled rejection.
 */
async function openPopupAndTriggerClip(target?: 'outline'): Promise<void> {
	try {
		await openPopup();
	} catch (error) {
		console.error('Failed to open popup for clip:', error);
		return;
	}
	const message = target ? { action: 'triggerQuickClip', target } : { action: 'triggerQuickClip' };
	// Retry until the popup's listener responds. 6 tries × 150ms ≈ 900ms, which
	// comfortably covers the popup's startup while feeling instant when it's fast.
	for (let attempt = 0; attempt < 6; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 150));
		try {
			const response = await browser.runtime.sendMessage(message);
			if (response) return;
		} catch {
			// Popup not listening yet; keep retrying
		}
	}
	console.warn('Quick clip message was not acknowledged by the popup');
}

async function openPopupAndClipToOutline(): Promise<void> {
	await openPopupAndTriggerClip('outline');
}

/**
 * Context-menu entry point for "Excerpt to today's Outline daily note". Reads
 * the current selection from the page (falling back to the menu's
 * `selectionText`), appends it to the daily note, and shows an in-page toast.
 */
async function runOutlineExcerptToDailyForTab(tabId: number, info: browser.Menus.OnClickData): Promise<void> {
	await runOutlineExcerptToDaily({}, tabId, info?.selectionText || '');
}

/**
 * Shared excerpt orchestration, reusable from the context menu and (Stage 2)
 * from a content-script runtime message. Resolves the excerpt payload (asking
 * the content script for the selection as Markdown when not supplied), appends
 * it to the daily note via `handleOutlineExcerptToDaily`, optionally adds a
 * highlight for the same selection (without turning on highlighter mode), and
 * shows a toast with the result. Never throws.
 */
async function runOutlineExcerptToDaily(
	payload: OutlineExcerptRequest,
	tabId: number,
	fallbackSelectionText = '',
): Promise<OutlineExcerptResponse> {
	const settings = sanitizeOutlineSettings((await browser.storage.sync.get('outline_settings')).outline_settings);

	// Resolve the excerpt. Prefer an explicit payload (Stage 2 toolbar); otherwise
	// ask the content script for the current selection as Markdown.
	let selectionMarkdown = payload.selectionMarkdown ?? '';
	let selectionText = payload.selectionText ?? fallbackSelectionText;
	let pageTitle = payload.pageTitle ?? '';
	let pageUrl = payload.pageUrl ?? '';

	if (!selectionMarkdown && !selectionText.trim()) {
		try {
			await ensureContentScriptLoadedInBackground(tabId);
			const result = await browser.tabs.sendMessage(tabId, { action: 'getSelectionMarkdown' }) as {
				success?: boolean; markdown?: string; text?: string; title?: string; url?: string;
			} | undefined;
			if (result?.success) {
				selectionMarkdown = result.markdown || '';
				selectionText = (result.text || selectionText || '').trim();
				pageTitle = pageTitle || result.title || '';
				pageUrl = pageUrl || result.url || '';
			}
		} catch (error) {
			// Restricted pages etc.: fall back to whatever selection text we have
			console.debug('getSelectionMarkdown failed, falling back to selection text:', error);
		}
	}

	// Fill page metadata defaults from the tab when still missing
	if (!pageTitle || !pageUrl) {
		try {
			const tab = await browser.tabs.get(tabId);
			pageTitle = pageTitle || tab.title || '';
			pageUrl = pageUrl || tab.url || '';
		} catch { /* ignore */ }
	}

	const response = await handleOutlineExcerptToDaily({
		selectionMarkdown,
		selectionText,
		pageTitle,
		pageUrl,
		paragraphSpacing: settings.paragraphSpacing,
	});

	if (response.success) {
		// Optionally add a highlight for the same selection, without flipping
		// highlighter mode on (keepMenuState).
		if (settings.excerptHighlight) {
			try {
				await sendMessageToContentScript(tabId, {
					action: 'highlightSelection',
					isActive: false,
					keepMenuState: true,
				});
				hasHighlights = true;
			} catch (error) {
				console.debug('Excerpt highlight failed:', error);
			}
		}
		await showToastInTab(tabId, browser.i18n.getMessage('outlineExcerptSaved', response.dailyTitle) || `${response.dailyTitle}`, 'info');
	} else {
		const key = getOutlineErrorMessageKey(response.errorKind);
		const message = browser.i18n.getMessage(key) || response.error || 'Excerpt failed';
		await showToastInTab(tabId, message, 'error');
	}
	return response;
}

async function showToastInTab(tabId: number, message: string, variant: 'info' | 'error'): Promise<void> {
	try {
		await sendMessageToContentScript(tabId, { action: 'showPageToast', message, variant });
	} catch (error) {
		console.debug('Failed to show page toast:', error);
	}
}

browser.runtime.onInstalled.addListener(() => {
	debouncedUpdateContextMenu(-1); // Use a dummy tabId for initial creation
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

const debouncedPaintHighlights = debounce(async (tabId: number) => {
	if (!getHighlighterModeForTab(tabId)) {
		await setHighlighterMode(tabId, false);
	}
	await paintHighlights(tabId);
}, 250);

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && await isSidePanelOpen(activeInfo.windowId)) {
		updateCurrentActiveTab(activeInfo.windowId);
		await debouncedPaintHighlights(activeInfo.tabId);
	}
}

async function paintHighlights(tabId: number) {
	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		await sendMessageToContentScript(tabId, { action: "paintHighlights" });

	} catch (error) {
		console.error('Error painting highlights:', error);
	}
}

function setHighlighterMode(tabId: number, activate: boolean): Promise<void> {
	return queueHighlighterModeChange(tabId, () => applyHighlighterMode(tabId, activate));
}

async function applyHighlighterMode(tabId: number, activate: boolean) {
	try {
		// First, check if the tab exists
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url) {
			return;
		}

		// Check if the URL is valid and not a blank page
		if (!isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		highlighterModeState[tabId] = activate;
		await sendMessageToContentScript(tabId, { action: "setHighlighterMode", isActive: activate });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: activate });

	} catch (error) {
		console.error('Error setting highlighter mode:', error);
		// If there's an error, assume highlighter mode should be off
		highlighterModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: false });
	}
}

function toggleHighlighterMode(tabId: number): Promise<boolean> {
	return queueHighlighterModeChange(tabId, () => applyHighlighterToggle(tabId));
}

async function applyHighlighterToggle(tabId: number): Promise<boolean> {
	try {
		const currentMode = getHighlighterModeForTab(tabId);
		const newMode = !currentMode;
		await sendMessageToContentScript(tabId, { action: "setHighlighterMode", isActive: newMode });
		highlighterModeState[tabId] = newMode;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: newMode });
		return newMode;
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		throw error;
	}
}

async function highlightSelection(tabId: number, info: browser.Menus.OnClickData) {
	const highlightData: Partial<TextHighlightData> = {
		id: Date.now().toString(),
		type: 'text',
		content: info.selectionText || '',
	};

	await sendMessageToContentScript(tabId, {
		action: "highlightSelection", 
		isActive: true,
		highlightData,
	});
	highlighterModeState[tabId] = true;
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function highlightElement(tabId: number, info: browser.Menus.OnClickData) {
	await sendMessageToContentScript(tabId, {
		action: "highlightElement", 
		isActive: true,
		targetElementInfo: {
			mediaType: info.mediaType === 'image' ? 'img' : info.mediaType,
			srcUrl: info.srcUrl,
			pageUrl: info.pageUrl
		}
	});
	highlighterModeState[tabId] = true;
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function toggleReaderModeInTab(tabId: number): Promise<{ success?: boolean; isActive?: boolean }> {
	await ensureContentScriptLoadedInBackground(tabId);
	await injectReaderScript(tabId);
	const response = await browser.tabs.sendMessage(tabId, { action: "toggleReaderMode" }) as { success?: boolean; isActive?: boolean };
	if (response?.success) {
		readerModeState[tabId] = response.isActive ?? false;
		debouncedUpdateContextMenu(tabId);
	}
	return response;
}

async function injectReaderScript(tabId: number) {
	try {
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['reader.css']
		});
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['highlighter.css']
		}).catch(() => {});

		// Inject scripts in sequence for all browsers
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js']
		});
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js']
		});

		return true;
	} catch (error) {
		console.error('Error injecting reader script:', error);
		return false;
	}
}

// When set to 'reader' or 'embedded', clear the popup so action.onClicked fires
// instead, handling the action directly without briefly opening the popup.
const validOpenBehaviors: Settings['openBehavior'][] = ['popup', 'embedded', 'reader'];

function parseOpenBehavior(raw: string | undefined): Settings['openBehavior'] {
	return validOpenBehaviors.includes(raw as Settings['openBehavior']) ? raw as Settings['openBehavior'] : 'popup';
}

async function updateActionPopup(openBehavior?: Settings['openBehavior']): Promise<void> {
	if (!openBehavior) {
		const data = await browser.storage.sync.get('general_settings');
		openBehavior = parseOpenBehavior((data.general_settings as Record<string, string>)?.openBehavior);
	}
	currentOpenBehavior = openBehavior;
	if (openBehavior === 'reader' || openBehavior === 'embedded') {
		await browser.action.setPopup({ popup: '' });
	} else {
		await browser.action.setPopup({ popup: 'popup.html' });
	}
}

let currentOpenBehavior: Settings['openBehavior'] = 'popup';

// In reader/embedded mode, opens embedded iframe instead of popup.
async function openPopup(): Promise<void> {
	if (currentOpenBehavior === 'reader' || currentOpenBehavior === 'embedded') {
		const tabs = await browser.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0];
		if (tab?.id && tab.url && isValidUrl(tab.url) && !isBlankPage(tab.url)) {
			await sendMessageToContentScript(tab.id, { action: "toggle-iframe" });
			return;
		}
		// Fall through to popup if tab is invalid
	}
	await browser.action.openPopup();
}

browser.action.onClicked.addListener(async (tab) => {
	if (!tab?.id || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) return;

	if (currentOpenBehavior === 'reader') {
		await toggleReaderModeInTab(tab.id);
	} else if (currentOpenBehavior === 'embedded') {
		await sendMessageToContentScript(tab.id, { action: "toggle-iframe" });
	}
});

browser.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync' && changes.general_settings) {
		updateActionPopup(parseOpenBehavior((changes.general_settings.newValue as Record<string, string>)?.openBehavior));
	}
	// Outline config affects which context-menu items are shown. The API key
	// lives in local storage; its settings (URL/collection) live in sync.
	if ((area === 'sync' && changes.outline_settings) || (area === 'local' && changes[OUTLINE_API_KEY_STORAGE_KEY])) {
		refreshOutlineConfigured().then(() => debouncedUpdateContextMenu(-1));
	}
});

// Initialize the extension
initialize().catch(error => {
	console.error('Failed to initialize background script:', error);
});
