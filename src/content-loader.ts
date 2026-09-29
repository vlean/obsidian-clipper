import { hasStoredHighlights } from './utils/url-utils';

// Keep the declarative content script intentionally small. The background
// checks whether this URL has saved highlights and injects the full content
// script only when they need to be rendered. It also wakes the full content
// script on demand when the user finishes a text selection and the in-page
// selection toolbar is enabled — so the toolbar never costs anything on pages
// where the user never selects text.
try {
	type StorageChange = { newValue?: unknown };
	type ExtensionApi = {
		runtime: {
			sendMessage(message: unknown): Promise<unknown> | undefined;
		};
		storage: {
			sync?: { get(keys: string | string[]): Promise<Record<string, unknown>> };
			onChanged: {
				addListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void;
			};
		};
	};

	const extensionApi = (typeof browser !== 'undefined' ? browser : chrome) as unknown as ExtensionApi;
	// Once the full content script is loaded it tracks highlight changes itself.
	let contentScriptLoaded = false;
	const requestContentScript = () => {
		const request = extensionApi.runtime.sendMessage({
			action: 'loadContentScriptForHighlights',
			url: window.location.href,
		});
		request?.then((response) => {
			if ((response as { loaded?: boolean } | undefined)?.loaded) {
				contentScriptLoaded = true;
			}
		}).catch(() => {
			// The extension may have been updated while this page was open.
		});
	};

	requestContentScript();

	// If another tab or extension page creates the first highlight for this
	// page, wake the full content script so cross-tab updates remain live.
	extensionApi.storage.onChanged.addListener((changes, areaName) => {
		if (!contentScriptLoaded && areaName === 'local' && changes.highlights
			&& hasStoredHighlights(changes.highlights.newValue, window.location.href)) {
			requestContentScript();
		}
		if (areaName === 'sync' && changes.highlighter_settings) {
			applyToolbarSetting(changes.highlighter_settings.newValue);
		}
	});

	// --- Selection toolbar detection (Feature C1) ---
	//
	// A text selection that just settled outside editable regions wakes the
	// full content script and asks it to render the toolbar. All the visual
	// work and the full guard set live in the content script; here we only do
	// the cheapest possible pre-check so idle pages pay nothing.
	let toolbarEnabled = true; // default on; corrected once settings load

	const applyToolbarSetting = (value: unknown) => {
		const s = (value && typeof value === 'object' ? value : {}) as {
			highlighterEnabled?: boolean;
			selectionToolbar?: boolean;
		};
		toolbarEnabled = s.highlighterEnabled !== false && s.selectionToolbar !== false;
	};

	const isEditableTarget = (node: Node | null): boolean => {
		let el: Element | null = node && node.nodeType === Node.ELEMENT_NODE
			? (node as Element)
			: node?.parentElement ?? null;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
		if ((el as HTMLElement).isContentEditable) return true;
		return Boolean(el.closest('[contenteditable=""], [contenteditable="true"]'));
	};

	const requestToolbar = () => {
		if (!toolbarEnabled) return;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;
		const text = selection.toString();
		if (!text || text.trim().length === 0) return;
		if (isEditableTarget(selection.focusNode ?? selection.anchorNode)) return;
		// Wake the content script (if needed) and ask it to render the toolbar.
		// The content script re-validates every guard before showing anything.
		const req = extensionApi.runtime.sendMessage({ action: 'requestSelectionToolbar' });
		req?.then(() => { contentScriptLoaded = true; }).catch(() => { /* ignore */ });
	};

	// Selections settle on mouseup/touchend/keyup (Shift+arrows). A tiny delay
	// lets the selection finalize before we read it. Registered before the
	// settings read so a missing storage API can't stop the listeners.
	const scheduleRequest = () => setTimeout(requestToolbar, 0);
	document.addEventListener('mouseup', scheduleRequest, true);
	document.addEventListener('touchend', scheduleRequest, true);
	document.addEventListener('keyup', (e) => {
		if (e.shiftKey || e.key === 'Shift' || e.key.startsWith('Arrow')) scheduleRequest();
	}, true);

	// Read the current toolbar setting once (kept updated via storage.onChanged
	// above). Guarded so environments without storage.sync don't abort.
	try {
		extensionApi.storage.sync?.get('highlighter_settings')
			?.then((data) => applyToolbarSetting(data.highlighter_settings))
			.catch(() => { /* keep default */ });
	} catch {
		// keep default (enabled)
	}
} catch {
	// The extension may have been updated while this page was open.
}
