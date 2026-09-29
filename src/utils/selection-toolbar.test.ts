// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	shouldShowSelectionToolbar,
	isSelectionToolbarEnabled,
	isEditableOrExtensionTarget,
	computeToolbarPosition,
	clampNoteText,
	computeNoteBubbleLayout,
	BUBBLE_LAYOUT_CONSTANTS,
	type Rect,
	type ElementLike,
} from './selection-toolbar';

function rect(left: number, top: number, width: number, height: number): Rect {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('isSelectionToolbarEnabled', () => {
	it('defaults to enabled when settings are missing', () => {
		expect(isSelectionToolbarEnabled(null)).toBe(true);
		expect(isSelectionToolbarEnabled(undefined)).toBe(true);
		expect(isSelectionToolbarEnabled({})).toBe(true);
	});

	it('is off when the highlighter is disabled', () => {
		expect(isSelectionToolbarEnabled({ highlighterEnabled: false, selectionToolbar: true })).toBe(false);
	});

	it('is off when the toolbar toggle is off', () => {
		expect(isSelectionToolbarEnabled({ highlighterEnabled: true, selectionToolbar: false })).toBe(false);
	});

	it('is on when both are on', () => {
		expect(isSelectionToolbarEnabled({ highlighterEnabled: true, selectionToolbar: true })).toBe(true);
	});
});

describe('isEditableOrExtensionTarget', () => {
	const el = (tag: string, extra: Partial<ElementLike> = {}): ElementLike => ({
		tagName: tag,
		closest: () => null,
		...extra,
	});

	it('flags input/textarea/select/option', () => {
		for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']) {
			expect(isEditableOrExtensionTarget(el(tag))).toBe(true);
		}
	});

	it('flags contenteditable elements', () => {
		expect(isEditableOrExtensionTarget(el('DIV', { isContentEditable: true }))).toBe(true);
	});

	it('flags elements inside the extension UI', () => {
		const target = el('SPAN', { closest: (sel: string) => (sel.includes('obsidian') ? {} : null) });
		expect(isEditableOrExtensionTarget(target)).toBe(true);
	});

	it('flags elements inside a contenteditable ancestor', () => {
		const target = el('SPAN', { closest: (sel: string) => (sel.includes('contenteditable') ? {} : null) });
		expect(isEditableOrExtensionTarget(target)).toBe(true);
	});

	it('passes through a normal paragraph', () => {
		expect(isEditableOrExtensionTarget(el('P'))).toBe(false);
	});

	it('treats null as not editable', () => {
		expect(isEditableOrExtensionTarget(null)).toBe(false);
	});
});

describe('shouldShowSelectionToolbar', () => {
	const base = {
		selection: { isCollapsed: false, text: 'hello world', anchorElement: { tagName: 'P', closest: () => null } as ElementLike },
		highlighterModeActive: false,
		settings: { highlighterEnabled: true, selectionToolbar: true },
		isExtensionPage: false,
	};

	it('shows for a normal non-empty selection', () => {
		expect(shouldShowSelectionToolbar(base)).toBe(true);
	});

	it('hides on the extension own pages', () => {
		expect(shouldShowSelectionToolbar({ ...base, isExtensionPage: true })).toBe(false);
	});

	it('hides when highlighter mode is active', () => {
		expect(shouldShowSelectionToolbar({ ...base, highlighterModeActive: true })).toBe(false);
	});

	it('hides when the feature is off', () => {
		expect(shouldShowSelectionToolbar({ ...base, settings: { highlighterEnabled: true, selectionToolbar: false } })).toBe(false);
	});

	it('hides for a collapsed selection', () => {
		expect(shouldShowSelectionToolbar({ ...base, selection: { ...base.selection, isCollapsed: true } })).toBe(false);
	});

	it('hides for a whitespace-only selection', () => {
		expect(shouldShowSelectionToolbar({ ...base, selection: { ...base.selection, text: '   \n\t ' } })).toBe(false);
	});

	it('hides for an editable target', () => {
		expect(shouldShowSelectionToolbar({
			...base,
			selection: { ...base.selection, anchorElement: { tagName: 'TEXTAREA', closest: () => null } },
		})).toBe(false);
	});
});

describe('computeToolbarPosition', () => {
	const viewport = { width: 1000, height: 800 };
	const size = { width: 200, height: 36 };

	it('centers horizontally on the selection', () => {
		const pos = computeToolbarPosition(rect(400, 300, 100, 20), size, viewport);
		// center of selection = 450, minus half width (100) => 350
		expect(pos.left).toBe(350);
	});

	it('places above when there is room', () => {
		const pos = computeToolbarPosition(rect(400, 300, 100, 20), size, viewport);
		expect(pos.placement).toBe('above');
		expect(pos.top).toBe(300 - 36 - 8);
	});

	it('flips below when there is no room above', () => {
		const pos = computeToolbarPosition(rect(400, 5, 100, 20), size, viewport);
		expect(pos.placement).toBe('below');
		expect(pos.top).toBe(25 + 8);
	});

	it('clamps to the left edge', () => {
		const pos = computeToolbarPosition(rect(0, 300, 20, 20), size, viewport);
		expect(pos.left).toBeGreaterThanOrEqual(4);
	});

	it('clamps to the right edge', () => {
		const pos = computeToolbarPosition(rect(980, 300, 20, 20), size, viewport);
		expect(pos.left).toBeLessThanOrEqual(viewport.width - size.width - 4);
	});
});

describe('clampNoteText', () => {
	it('leaves short text untouched', () => {
		const r = clampNoteText('a short note');
		expect(r.truncated).toBe(false);
		expect(r.display).toBe('a short note');
		expect(r.full).toBe('a short note');
	});

	it('collapses whitespace', () => {
		const r = clampNoteText('  many   spaces\n\there ');
		expect(r.display).toBe('many spaces here');
	});

	it('truncates long text with an ellipsis and keeps the full text', () => {
		const long = 'word '.repeat(100).trim();
		const r = clampNoteText(long, 40);
		expect(r.truncated).toBe(true);
		expect(r.display.endsWith('…')).toBe(true);
		expect(r.display.length).toBeLessThanOrEqual(41);
		expect(r.full).toBe(long.replace(/\s+/g, ' '));
	});

	it('handles empty/nullish input', () => {
		expect(clampNoteText('').display).toBe('');
		// @ts-expect-error testing runtime robustness
		expect(clampNoteText(undefined).display).toBe('');
	});
});

describe('computeNoteBubbleLayout', () => {
	const viewport = { width: 1200, height: 800 };
	const W = BUBBLE_LAYOUT_CONSTANTS.BUBBLE_WIDTH;

	it('anchors to the right of the last rect', () => {
		const placements = computeNoteBubbleLayout(
			[{ id: 'a', rects: [rect(100, 200, 300, 20)] }],
			viewport,
		);
		expect(placements).toHaveLength(1);
		expect(placements[0].left).toBe(400 + BUBBLE_LAYOUT_CONSTANTS.BUBBLE_GAP);
		expect(placements[0].top).toBe(200);
	});

	it('falls back to the right margin when there is no horizontal room', () => {
		// last rect ends near the right edge → not enough room for a 260px bubble
		const placements = computeNoteBubbleLayout(
			[{ id: 'a', rects: [rect(100, 200, 1050, 20)] }],
			viewport,
		);
		expect(placements[0].left).toBe(viewport.width - W - 4);
	});

	it('stacks bubbles vertically when they would collide', () => {
		const placements = computeNoteBubbleLayout(
			[
				{ id: 'a', rects: [rect(100, 200, 100, 20)] },
				{ id: 'b', rects: [rect(100, 205, 100, 20)] }, // nearly same anchor
			],
			viewport,
			{ a: 30, b: 30 },
		);
		const a = placements.find(p => p.id === 'a')!;
		const b = placements.find(p => p.id === 'b')!;
		// same column (both anchored at x=200+gap); b pushed below a
		expect(b.top).toBeGreaterThanOrEqual(a.top + 30 + BUBBLE_LAYOUT_CONSTANTS.BUBBLE_VERTICAL_GAP);
	});

	it('does not stack bubbles in different columns', () => {
		const placements = computeNoteBubbleLayout(
			[
				{ id: 'a', rects: [rect(0, 200, 50, 20)] },       // bubble at x≈56
				{ id: 'b', rects: [rect(800, 205, 50, 20)] },     // bubble at x≈856 (far right, no overlap)
			],
			viewport,
			{ a: 30, b: 30 },
		);
		const a = placements.find(p => p.id === 'a')!;
		const b = placements.find(p => p.id === 'b')!;
		// far apart horizontally → keep their own anchor tops
		expect(a.top).toBe(200);
		expect(b.top).toBe(205);
	});

	it('skips anchors with no rects', () => {
		const placements = computeNoteBubbleLayout(
			[{ id: 'a', rects: [] }],
			viewport,
		);
		expect(placements).toHaveLength(0);
	});
});
