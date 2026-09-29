// Pure helpers for the in-page selection toolbar (Feature C1) and the visible
// note bubbles (Feature C2). Everything here is DOM-light and side-effect free
// so it can be unit-tested under jsdom without the extension environment. The
// rendering that consumes these lives in `selection-toolbar-ui.ts` (loaded only
// in the full content script) and the tiny detection lives in content-loader.

// Unique, page-CSS-proof class/id prefix for every element we inject.
export const SELECTION_TOOLBAR_ID = 'obsidian-selection-toolbar';
export const SELECTION_TOOLBAR_CLASS = 'obsidian-selection-toolbar';
export const SELECTION_TOOLBAR_BUTTON_CLASS = 'obsidian-selection-toolbar-button';
export const NOTE_BUBBLE_LAYER_ID = 'obsidian-note-bubble-layer';
export const NOTE_BUBBLE_CLASS = 'obsidian-note-bubble';

// Elements whose text is being edited must never trigger the toolbar — a
// selection there is the user's own editing, not a highlight target.
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

// Selectors for the extension's own UI. A selection anchored inside any of
// these is the extension itself, not page content.
export const EXTENSION_UI_SELECTOR = [
	'.obsidian-highlighter-menu',
	'.obsidian-reader-settings',
	'.obsidian-highlight-delete',
	'.obsidian-selection-action',
	'.obsidian-highlight-note-editor',
	'.' + SELECTION_TOOLBAR_CLASS,
	'#' + NOTE_BUBBLE_LAYER_ID,
	'#obsidian-clipper-container',
	'#obsidian-clipper-toast-host',
].join(', ');

export interface SelectionToolbarSettings {
	highlighterEnabled?: boolean;
	selectionToolbar?: boolean;
}

/**
 * Is the selection toolbar feature active for these settings? It requires the
 * highlighter to be enabled and the toolbar toggle on (default on when unset).
 */
export function isSelectionToolbarEnabled(settings: SelectionToolbarSettings | null | undefined): boolean {
	if (!settings) return true; // default state before settings load: enabled
	if (settings.highlighterEnabled === false) return false;
	return settings.selectionToolbar !== false;
}

// The minimal, environment-agnostic shape of a selection we need to decide.
export interface SelectionSnapshot {
	isCollapsed: boolean;
	text: string;
	// The element the selection's focus/anchor sits in (deepest element).
	anchorElement: ElementLike | null;
}

// A DOM-Element-like node. Real Elements satisfy this; tests can pass plain
// objects. `closest` matches the extension-UI selector; `isContentEditable`
// and the tag checks catch editable regions.
export interface ElementLike {
	tagName?: string;
	isContentEditable?: boolean;
	closest?: (selector: string) => unknown;
}

export interface ToolbarVisibilityInput {
	selection: SelectionSnapshot;
	highlighterModeActive: boolean;
	settings: SelectionToolbarSettings | null | undefined;
	/** True when running on one of the extension's own pages (chrome-extension://). */
	isExtensionPage: boolean;
}

/**
 * The single source of truth for "should the selection toolbar appear now?".
 * Pure so every guard can be unit-tested. Returns false for: collapsed or
 * whitespace-only selections, editable targets, extension UI, active
 * highlighter mode, the feature turned off, or the extension's own pages.
 */
export function shouldShowSelectionToolbar(input: ToolbarVisibilityInput): boolean {
	const { selection, highlighterModeActive, settings, isExtensionPage } = input;
	if (isExtensionPage) return false;
	if (highlighterModeActive) return false;
	if (!isSelectionToolbarEnabled(settings)) return false;
	if (!selection || selection.isCollapsed) return false;
	if (!selection.text || selection.text.trim().length === 0) return false;
	if (isEditableOrExtensionTarget(selection.anchorElement)) return false;
	return true;
}

/**
 * True when the element is an editable field, a contenteditable region, or
 * lives inside the extension's own UI — any of which should suppress the
 * toolbar. Walks up via `closest` for contenteditable/UI containment.
 */
export function isEditableOrExtensionTarget(element: ElementLike | null | undefined): boolean {
	if (!element) return false;
	const tag = element.tagName?.toUpperCase();
	if (tag && EDITABLE_TAGS.has(tag)) return true;
	if (element.isContentEditable) return true;
	if (typeof element.closest === 'function') {
		if (element.closest(EXTENSION_UI_SELECTOR)) return true;
		// A contenteditable ancestor (e.g. selection inside a rich editor).
		if (element.closest('[contenteditable=""], [contenteditable="true"]')) return true;
	}
	return false;
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface Viewport {
	width: number;
	height: number;
}

export interface ToolbarPosition {
	left: number;
	top: number;
	placement: 'above' | 'below';
}

const TOOLBAR_GAP = 8;
const VIEWPORT_MARGIN = 4;

/**
 * Position the toolbar horizontally centered on the selection's end rect and
 * vertically just above it, flipping below when there isn't room above. The
 * result is clamped so the toolbar stays fully within the viewport. Coordinates
 * are viewport-relative (callers add scroll offsets for absolute positioning).
 */
export function computeToolbarPosition(
	selectionRect: Rect,
	toolbarSize: { width: number; height: number },
	viewport: Viewport,
): ToolbarPosition {
	const centerX = (selectionRect.left + selectionRect.right) / 2;
	let left = centerX - toolbarSize.width / 2;
	left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.width - toolbarSize.width - VIEWPORT_MARGIN));

	const spaceAbove = selectionRect.top;
	const spaceBelow = viewport.height - selectionRect.bottom;
	const needed = toolbarSize.height + TOOLBAR_GAP;

	let placement: 'above' | 'below';
	let top: number;
	if (spaceAbove >= needed || spaceAbove >= spaceBelow) {
		placement = 'above';
		top = selectionRect.top - toolbarSize.height - TOOLBAR_GAP;
	} else {
		placement = 'below';
		top = selectionRect.bottom + TOOLBAR_GAP;
	}
	// Keep it on-screen vertically as a final guard.
	top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.height - toolbarSize.height - VIEWPORT_MARGIN));
	return { left, top, placement };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

// --- Note bubbles (Feature C2) ---

/**
 * Collapse note text to a single trimmed line-source for display. The visible
 * clamp to ~3 lines is done in CSS (-webkit-line-clamp); this only strips the
 * text down to a plain string so the bubble never renders markup and the
 * `title`/full text stays available. Returns both the (possibly truncated)
 * display string and the full text.
 */
export function clampNoteText(note: string, maxChars = 240): { display: string; full: string; truncated: boolean } {
	const full = (note ?? '').toString();
	const normalized = full.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxChars) {
		return { display: normalized, full: normalized, truncated: false };
	}
	// Truncate on a word boundary when possible.
	const slice = normalized.slice(0, maxChars);
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
	return { display: cut + '…', full: normalized, truncated: true };
}

export interface BubbleAnchorInput {
	/** id of the highlight group (owner id). */
	id: string;
	/** Bounding rects of the group's rendered highlight (viewport-relative). */
	rects: Rect[];
}

export interface BubblePlacement {
	id: string;
	left: number;
	top: number;
}

const BUBBLE_WIDTH = 260;
const BUBBLE_GAP = 6; // gap between the highlight end and the bubble
const BUBBLE_VERTICAL_GAP = 4; // min vertical gap between stacked bubbles
const BUBBLE_MIN_HEIGHT = 24;

/**
 * Compute where each note bubble sits. Anchored just after the end of the
 * group's last rect; falls back to the right margin at the first rect's top
 * when there's no room to the right. Bubbles that would vertically overlap are
 * pushed down so they stack instead of colliding. Input order is preserved;
 * placement is done top-to-bottom by anchor Y.
 *
 * `bubbleHeights` optionally supplies a measured height per id (defaults to a
 * min height) so collision math matches what will render.
 */
export function computeNoteBubbleLayout(
	anchors: BubbleAnchorInput[],
	viewport: Viewport,
	bubbleHeights: Record<string, number> = {},
): BubblePlacement[] {
	interface Candidate {
		id: string;
		left: number;
		top: number;
		height: number;
	}
	const candidates: Candidate[] = [];
	for (const anchor of anchors) {
		if (!anchor.rects || anchor.rects.length === 0) continue;
		const last = anchor.rects[anchor.rects.length - 1];
		const first = anchor.rects[0];
		const height = bubbleHeights[anchor.id] ?? BUBBLE_MIN_HEIGHT;

		// Preferred: to the right of the last rect, aligned to its top.
		let left = last.right + BUBBLE_GAP;
		let top = last.top;
		// Fallback: no horizontal room → right margin at the first rect's top.
		if (left + BUBBLE_WIDTH + VIEWPORT_MARGIN > viewport.width) {
			left = Math.max(VIEWPORT_MARGIN, viewport.width - BUBBLE_WIDTH - VIEWPORT_MARGIN);
			top = first.top;
		}
		left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.width - BUBBLE_WIDTH - VIEWPORT_MARGIN));
		candidates.push({ id: anchor.id, left, top, height });
	}

	// Sort by anchor top so stacking pushes later (lower) bubbles down.
	candidates.sort((a, b) => a.top - b.top || a.left - b.left);

	const placed: Candidate[] = [];
	for (const c of candidates) {
		let top = c.top;
		for (const p of placed) {
			// Only stack when they'd horizontally overlap (share the column).
			const horizontallyOverlap = c.left < p.left + BUBBLE_WIDTH && p.left < c.left + BUBBLE_WIDTH;
			if (horizontallyOverlap && top < p.top + p.height + BUBBLE_VERTICAL_GAP) {
				top = p.top + p.height + BUBBLE_VERTICAL_GAP;
			}
		}
		placed.push({ ...c, top });
	}

	return placed.map(p => ({ id: p.id, left: p.left, top: p.top }));
}

export const BUBBLE_LAYOUT_CONSTANTS = {
	BUBBLE_WIDTH,
	BUBBLE_GAP,
	BUBBLE_VERTICAL_GAP,
	BUBBLE_MIN_HEIGHT,
};
