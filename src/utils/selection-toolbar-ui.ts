// In-page selection toolbar (Feature C1) and visible note bubbles (Feature C2).
// This module runs only inside the full content script, so it may import the
// highlighter freely. The tiny detection that decides whether to wake the full
// content script lives in content-loader.ts; everything visual is here.

import browser from './browser-polyfill';
import { getMessage } from './i18n';
import { setElementHTML } from './dom-utils';
import { OUTLINE_ACTIONS } from './outline-service';
import {
	handleTextSelection,
	applyHighlights,
	highlights,
	type AnyHighlightData,
} from './highlighter';
import { openHighlightNoteEditor, getHighlightClientRects } from './highlighter-overlays';
import { getHighlightNoteText } from './highlight-notes';
import {
	SELECTION_TOOLBAR_ID,
	SELECTION_TOOLBAR_CLASS,
	SELECTION_TOOLBAR_BUTTON_CLASS,
	NOTE_BUBBLE_LAYER_ID,
	NOTE_BUBBLE_CLASS,
	shouldShowSelectionToolbar,
	computeToolbarPosition,
	computeNoteBubbleLayout,
	clampNoteText,
	type SelectionToolbarSettings,
	type Rect,
} from './selection-toolbar';

// --- Feature flags mirrored from storage.sync ---

let toolbarSettings: SelectionToolbarSettings & { showHighlightNotes?: boolean } = {};
let outlineConfigured = false;

export function updateSelectionToolbarSettings(
	settings: SelectionToolbarSettings & { showHighlightNotes?: boolean },
): void {
	toolbarSettings = settings;
}

export function setOutlineConfiguredForToolbar(configured: boolean): void {
	outlineConfigured = configured;
}

function isHighlighterModeActive(): boolean {
	return document.body.classList.contains('obsidian-highlighter-active');
}

function isExtensionPage(): boolean {
	return location.protocol === 'chrome-extension:'
		|| location.protocol === 'moz-extension:'
		|| location.protocol === 'safari-web-extension:';
}

// --- Toolbar element ---

let toolbarEl: HTMLDivElement | null = null;
let toolbarVisible = false;

function iconSpan(svg: string): HTMLSpanElement {
	const span = document.createElement('span');
	span.className = 'obsidian-selection-toolbar-icon';
	setElementHTML(span, svg);
	return span;
}

const HIGHLIGHT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>';
const NOTE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
const EXCERPT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';

function makeButton(id: string, icon: string, label: string, onActivate: () => void): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.id = id;
	btn.className = SELECTION_TOOLBAR_BUTTON_CLASS;
	btn.appendChild(iconSpan(icon));
	const text = document.createElement('span');
	text.className = 'obsidian-selection-toolbar-label';
	text.textContent = label;
	btn.appendChild(text);
	btn.setAttribute('aria-label', label);
	// mousedown preventDefault keeps the page selection alive through the click.
	btn.addEventListener('mousedown', (e) => e.preventDefault());
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onActivate();
	});
	return btn;
}

function ensureToolbar(): HTMLDivElement {
	if (toolbarEl) {
		if (!toolbarEl.isConnected) document.body.appendChild(toolbarEl);
		return toolbarEl;
	}
	const el = document.createElement('div');
	el.id = SELECTION_TOOLBAR_ID;
	el.className = SELECTION_TOOLBAR_CLASS;
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', getMessage('selectionToolbar') || 'Selection toolbar');
	el.style.display = 'none';

	el.appendChild(makeButton(
		'obsidian-selection-toolbar-highlight',
		HIGHLIGHT_ICON,
		getMessage('highlight') || 'Highlight',
		() => onHighlight(),
	));
	el.appendChild(makeButton(
		'obsidian-selection-toolbar-annotate',
		NOTE_ICON,
		getMessage('annotate') || 'Annotate',
		() => onAnnotate(),
	));
	// The excerpt button is created lazily/conditionally in showToolbar so it
	// only appears when Outline is configured.

	document.body.appendChild(el);
	toolbarEl = el;
	return el;
}

let excerptButton: HTMLButtonElement | null = null;
function ensureExcerptButton(toolbar: HTMLDivElement): HTMLButtonElement {
	if (excerptButton) {
		if (excerptButton.parentElement !== toolbar) toolbar.appendChild(excerptButton);
		return excerptButton;
	}
	excerptButton = makeButton(
		'obsidian-selection-toolbar-excerpt',
		EXCERPT_ICON,
		getMessage('excerptToDaily') || 'Excerpt to daily note',
		() => onExcerpt(),
	);
	toolbar.appendChild(excerptButton);
	return excerptButton;
}

/** Snapshot the current selection into the shape the pure decision expects. */
function snapshotSelection(): { selection: Selection | null; rect: Rect | null } {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return { selection, rect: null };
	}
	const range = selection.getRangeAt(0);
	const rects = range.getClientRects();
	const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
	const rect: Rect = {
		left: last.left,
		top: last.top,
		right: last.right,
		bottom: last.bottom,
		width: last.width,
		height: last.height,
	};
	return { selection, rect };
}

function selectionAnchorElement(selection: Selection): Element | null {
	const node = selection.focusNode ?? selection.anchorNode;
	if (!node) return null;
	return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Called by the content script when the loader detects a settled selection.
 * Re-validates via the pure decision, then positions and shows the toolbar.
 */
export function maybeShowSelectionToolbar(): void {
	const { selection, rect } = snapshotSelection();
	const anchorElement = selection ? selectionAnchorElement(selection) : null;
	const ok = shouldShowSelectionToolbar({
		selection: {
			isCollapsed: selection?.isCollapsed ?? true,
			text: selection?.toString() ?? '',
			anchorElement,
		},
		highlighterModeActive: isHighlighterModeActive(),
		settings: toolbarSettings,
		isExtensionPage: isExtensionPage(),
	});
	if (!ok || !rect) {
		hideSelectionToolbar();
		return;
	}
	showToolbarAt(rect);
}

function showToolbarAt(selectionRect: Rect): void {
	const toolbar = ensureToolbar();

	// Show/remove the excerpt button based on current Outline configuration.
	if (outlineConfigured) {
		ensureExcerptButton(toolbar);
	} else if (excerptButton && excerptButton.parentElement) {
		excerptButton.remove();
	}

	// Make it measurable before positioning.
	toolbar.style.display = 'inline-flex';
	toolbar.style.visibility = 'hidden';
	toolbar.style.left = '0px';
	toolbar.style.top = '0px';

	const size = { width: toolbar.offsetWidth || 200, height: toolbar.offsetHeight || 36 };
	const pos = computeToolbarPosition(selectionRect, size, {
		width: window.innerWidth,
		height: window.innerHeight,
	});
	toolbar.style.left = `${pos.left + window.scrollX}px`;
	toolbar.style.top = `${pos.top + window.scrollY}px`;
	toolbar.dataset.placement = pos.placement;
	toolbar.style.visibility = 'visible';
	toolbarVisible = true;
	attachDismissListeners();
}

export function hideSelectionToolbar(): void {
	if (toolbarEl) toolbarEl.style.display = 'none';
	if (toolbarVisible) {
		detachDismissListeners();
		toolbarVisible = false;
	}
}

// --- Actions ---

// Create a highlight from the current selection WITHOUT enabling highlighter
// mode (so link clicks stay live). Returns the id of the newly created
// (owner) highlight, or null if nothing was created.
function highlightCurrentSelection(): string | null {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed) return null;
	const before = new Set(highlights.map((h: AnyHighlightData) => h.id));
	// handleTextSelection reuses the full highlight code path (storage, undo,
	// groups, popup sync) and calls applyHighlights + saveHighlights itself.
	handleTextSelection(selection);
	// Identify the new owner highlight: the first id not present before.
	const created = highlights.find((h: AnyHighlightData) => !before.has(h.id));
	// Ensure it renders immediately (handleTextSelection already commits, but a
	// belt-and-suspenders applyHighlights keeps parity with the message path).
	applyHighlights();
	return created?.id ?? null;
}

function onHighlight(): void {
	highlightCurrentSelection();
	hideSelectionToolbar();
}

function onAnnotate(): void {
	const id = highlightCurrentSelection();
	hideSelectionToolbar();
	if (id) {
		// Open the note editor for the freshly created highlight.
		openHighlightNoteEditor(id);
	}
}

function onExcerpt(): void {
	// Delegate to the Stage-1 background action. The background reads the
	// selection/title/url from the sender tab, highlights per excerptHighlight,
	// appends to the daily note, and shows the toast — so we only send.
	hideSelectionToolbar();
	browser.runtime.sendMessage({ action: OUTLINE_ACTIONS.excerptToDaily }).catch((error) => {
		console.error('[Obsidian Clipper] excerpt-to-daily from toolbar failed:', error);
	});
}

// --- Dismiss handling ---

function onDocumentKeyDown(e: KeyboardEvent): void {
	if (e.key === 'Escape') hideSelectionToolbar();
}
function onDocumentScroll(): void { hideSelectionToolbar(); }
function onWindowBlur(): void { hideSelectionToolbar(); }
function onWindowResize(): void { hideSelectionToolbar(); }
function onSelectionChange(): void {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed) hideSelectionToolbar();
}
function onDocumentPointerDown(e: Event): void {
	const target = e.target as Element | null;
	if (target && toolbarEl && (target === toolbarEl || toolbarEl.contains(target))) return;
	hideSelectionToolbar();
}

let dismissAttached = false;
function attachDismissListeners(): void {
	if (dismissAttached) return;
	document.addEventListener('keydown', onDocumentKeyDown, true);
	document.addEventListener('scroll', onDocumentScroll, true);
	document.addEventListener('selectionchange', onSelectionChange);
	document.addEventListener('mousedown', onDocumentPointerDown, true);
	window.addEventListener('blur', onWindowBlur);
	window.addEventListener('resize', onWindowResize);
	dismissAttached = true;
}
function detachDismissListeners(): void {
	if (!dismissAttached) return;
	document.removeEventListener('keydown', onDocumentKeyDown, true);
	document.removeEventListener('scroll', onDocumentScroll, true);
	document.removeEventListener('selectionchange', onSelectionChange);
	document.removeEventListener('mousedown', onDocumentPointerDown, true);
	window.removeEventListener('blur', onWindowBlur);
	window.removeEventListener('resize', onWindowResize);
	dismissAttached = false;
}

// --- Note bubbles (Feature C2) ---

let bubbleLayer: HTMLDivElement | null = null;

function ensureBubbleLayer(): HTMLDivElement {
	if (bubbleLayer) {
		if (!bubbleLayer.isConnected) document.body.appendChild(bubbleLayer);
		return bubbleLayer;
	}
	const layer = document.createElement('div');
	layer.id = NOTE_BUBBLE_LAYER_ID;
	// Absolute overlay that must not affect layout or intercept page clicks
	// (individual bubbles re-enable pointer events).
	layer.style.position = 'absolute';
	layer.style.top = '0';
	layer.style.left = '0';
	layer.style.width = '0';
	layer.style.height = '0';
	layer.style.pointerEvents = 'none';
	document.body.appendChild(layer);
	bubbleLayer = layer;
	return layer;
}

export function removeNoteBubbles(): void {
	if (bubbleLayer) {
		bubbleLayer.textContent = '';
		if (bubbleLayer.isConnected) bubbleLayer.remove();
	}
}

/**
 * Return, per highlight group that has a note, the owner id, the note text,
 * and the group's rendered viewport rects. Uses the group owner (first member)
 * as the anchor id, matching how notes are stored/opened.
 */
function collectGroupsWithNotes(): { id: string; note: string; rects: Rect[] }[] {
	const seenGroups = new Set<string>();
	const out: { id: string; note: string; rects: Rect[] }[] = [];
	for (const h of highlights) {
		const groupKey = h.groupId ?? h.id;
		if (seenGroups.has(groupKey)) continue;
		seenGroups.add(groupKey);
		const note = getHighlightNoteText(highlights, h.id);
		if (!note) continue;
		const rects = collectGroupRects(h);
		if (rects.length === 0) continue;
		out.push({ id: h.id, note, rects });
	}
	return out;
}

// Gather viewport rects for a highlight (and its group members) from the live
// text-highlight ranges or element overlays currently rendered.
function collectGroupRects(owner: AnyHighlightData): Rect[] {
	const members = owner.groupId
		? highlights.filter((h: AnyHighlightData) => h.groupId === owner.groupId)
		: [owner];
	const rects: Rect[] = [];
	for (const m of members) {
		for (const r of getHighlightClientRects(m.id)) {
			// Skip zero-area rects (unrendered / collapsed).
			if (r.width <= 0 && r.height <= 0) continue;
			rects.push(r);
		}
	}
	// Order rects top-to-bottom then left-to-right so "last rect" is the visual
	// end of the highlight (where the bubble anchors).
	rects.sort((a, b) => a.top - b.top || a.left - b.left);
	return rects;
}

/**
 * Render the note bubbles for the current highlights. Called after
 * applyHighlights and on layout changes. No-op when the feature is off.
 */
export function renderNoteBubbles(): void {
	if (toolbarSettings.showHighlightNotes === false) {
		removeNoteBubbles();
		return;
	}
	const groups = collectGroupsWithNotes();
	if (groups.length === 0) {
		removeNoteBubbles();
		return;
	}
	const layer = ensureBubbleLayer();
	layer.textContent = '';

	const placements = computeNoteBubbleLayout(
		groups.map(g => ({ id: g.id, rects: g.rects })),
		{ width: window.innerWidth, height: window.innerHeight },
	);
	const noteById = new Map(groups.map(g => [g.id, g.note]));

	for (const p of placements) {
		const note = noteById.get(p.id) ?? '';
		const { display, full } = clampNoteText(note);
		const bubble = document.createElement('button');
		bubble.type = 'button';
		bubble.className = NOTE_BUBBLE_CLASS;
		bubble.dataset.highlightId = p.id;
		bubble.style.position = 'absolute';
		bubble.style.left = `${p.left + window.scrollX}px`;
		bubble.style.top = `${p.top + window.scrollY}px`;
		bubble.style.pointerEvents = 'auto';
		bubble.textContent = display; // textContent only — never render markup
		bubble.title = full;
		bubble.setAttribute('aria-label', full);
		bubble.addEventListener('mousedown', (e) => e.stopPropagation());
		bubble.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openHighlightNoteEditor(p.id);
		});
		layer.appendChild(bubble);
	}
}
