// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Stand-in for the highlighter module's shared state and persistence
const state = vi.hoisted(() => ({
	highlights: [] as Array<Record<string, any>>,
	saveHighlights: vi.fn(),
	applyHighlights: vi.fn(),
	updateHighlighterMenu: vi.fn(),
}));

vi.mock('./highlighter', () => ({
	get highlights() { return state.highlights; },
	isApplyingHighlights: false,
	BLOCK_HIGHLIGHT_TAGS: [],
	handleTextSelection: vi.fn(),
	highlightElement: vi.fn(),
	sortHighlights: vi.fn(),
	applyHighlights: state.applyHighlights,
	saveHighlights: state.saveHighlights,
	updateHighlighterMenu: state.updateHighlighterMenu,
	updateHighlights: (next: Array<Record<string, any>>) => { state.highlights = next; },
}));

import {
	closeHighlightNoteEditor,
	isHighlightNoteEditorOpen,
	openHighlightNoteEditor,
	planHighlightOverlayRects,
	clearTextHighlights,
	removeExistingHighlights,
} from './highlighter-overlays';

const annotatedRanges: Range[] = [];

beforeAll(() => {
	const registry = new Map<string, { add(r: Range): void }>();
	class MockHighlight {
		priority = 0;
		private ranges: Range[] = [];
		add(range: Range) {
			this.ranges.push(range);
			if (registry.get('obsidian-highlight-annotated') === this) annotatedRanges.push(range);
		}
		clear() {
			this.ranges = [];
			if (registry.get('obsidian-highlight-annotated') === this) annotatedRanges.length = 0;
		}
	}
	(window as unknown as { Highlight: unknown }).Highlight = MockHighlight;
	(globalThis as unknown as { CSS: unknown }).CSS = { highlights: registry };
	// jsdom doesn't implement layout; a zero rect is enough for positioning code
	document.elementFromPoint = () => null;
	Range.prototype.getClientRects = function () {
		return [{ left: 0, right: 50, top: 10, bottom: 20 }] as unknown as DOMRectList;
	};
});

function textHighlight(id: string, extra: Record<string, any> = {}) {
	return { id, type: 'text', xpath: '/html/body/p', startOffset: 0, endOffset: 5, content: 'Hello', ...extra };
}

beforeEach(() => {
	document.body.innerHTML = '<p>Hello world</p>';
	state.highlights = [textHighlight('1')];
	state.saveHighlights.mockClear();
	state.applyHighlights.mockClear();
	clearTextHighlights();
	planHighlightOverlayRects(null, state.highlights[0] as any);
});

afterEach(() => {
	if (isHighlightNoteEditorOpen()) closeHighlightNoteEditor(false);
	removeExistingHighlights();
});

function editor() {
	return document.querySelector('.obsidian-highlight-note-editor') as HTMLDivElement;
}
function textarea() {
	return editor().querySelector('textarea') as HTMLTextAreaElement;
}

describe('highlight note editor', () => {
	test('opens with the current note and saves an edited note', () => {
		state.highlights = [textHighlight('1', { notes: ['old'] })];
		openHighlightNoteEditor('1');
		expect(editor().style.display).toBe('flex');
		expect(textarea().value).toBe('old');
		expect(document.activeElement).toBe(textarea());

		textarea().value = 'new note';
		(editor().querySelector('.obsidian-highlight-note-save') as HTMLButtonElement).click();

		expect(editor().style.display).toBe('none');
		expect(state.highlights[0].notes).toEqual(['new note']);
		expect(state.saveHighlights).toHaveBeenCalledTimes(1);
		expect(state.applyHighlights).toHaveBeenCalledTimes(1);
	});

	test('cancel discards changes', () => {
		openHighlightNoteEditor('1');
		textarea().value = 'draft';
		(editor().querySelector('.obsidian-highlight-note-cancel') as HTMLButtonElement).click();
		expect(state.highlights[0].notes).toBeUndefined();
		expect(state.saveHighlights).not.toHaveBeenCalled();
	});

	test('Escape cancels and Ctrl+Enter saves, without leaking keys to the page', () => {
		const pageKeydown = vi.fn();
		document.addEventListener('keydown', pageKeydown);

		openHighlightNoteEditor('1');
		textarea().value = 'draft';
		textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(isHighlightNoteEditorOpen()).toBe(false);
		expect(state.saveHighlights).not.toHaveBeenCalled();

		openHighlightNoteEditor('1');
		textarea().value = 'saved via keyboard';
		textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
		expect(state.highlights[0].notes).toEqual(['saved via keyboard']);
		expect(pageKeydown).not.toHaveBeenCalled();

		document.removeEventListener('keydown', pageKeydown);
	});

	test('clearing the text removes the note', () => {
		state.highlights = [textHighlight('1', { notes: ['old'] })];
		openHighlightNoteEditor('1');
		textarea().value = '  ';
		closeHighlightNoteEditor(true);
		expect(state.highlights[0]).not.toHaveProperty('notes');
		expect(state.saveHighlights).toHaveBeenCalledTimes(1);
	});

	test('does not save when nothing changed', () => {
		state.highlights = [textHighlight('1', { notes: ['same'] })];
		openHighlightNoteEditor('1');
		closeHighlightNoteEditor(true);
		expect(state.saveHighlights).not.toHaveBeenCalled();
	});

	test('ignores unknown highlights', () => {
		openHighlightNoteEditor('missing');
		expect(isHighlightNoteEditorOpen()).toBe(false);
	});
});

describe('annotated rendering', () => {
	test('text highlights with a note are added to the annotated highlight', () => {
		clearTextHighlights();
		planHighlightOverlayRects(null, textHighlight('1') as any);
		expect(annotatedRanges).toHaveLength(0);

		state.highlights = [textHighlight('1', { notes: ['n'] })];
		clearTextHighlights();
		planHighlightOverlayRects(null, state.highlights[0] as any);
		expect(annotatedRanges).toHaveLength(1);
	});

	test('element overlays with a note get the annotated class', () => {
		const img = document.createElement('img');
		document.body.appendChild(img);
		state.highlights = [{ id: 'e1', type: 'element', xpath: '', content: '', notes: ['n'] }];
		planHighlightOverlayRects(img, state.highlights[0] as any);
		const overlay = document.querySelector('.obsidian-highlight-overlay') as HTMLElement;
		expect(overlay.classList.contains('obsidian-highlight-overlay-annotated')).toBe(true);
	});
});
