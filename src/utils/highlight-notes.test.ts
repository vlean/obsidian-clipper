// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { getHighlightNoteText, hasHighlightNotes, setHighlightNoteText, NotableHighlight } from './highlight-notes';
import { collapseGroupsForExport, AnyHighlightData } from './highlighter';

const single: NotableHighlight[] = [
	{ id: '1' },
	{ id: '2', notes: ['existing'] },
];

const grouped: NotableHighlight[] = [
	{ id: '10', groupId: 'g' },
	{ id: '11', groupId: 'g', notes: ['from member'] },
	{ id: '20' },
];

describe('getHighlightNoteText', () => {
	test('returns the note of a single highlight', () => {
		expect(getHighlightNoteText(single, '2')).toBe('existing');
		expect(getHighlightNoteText(single, '1')).toBe('');
	});

	test('merges notes across a group, trimming blanks', () => {
		const data = [
			{ id: 'a', groupId: 'g', notes: [' first ', ''] },
			{ id: 'b', groupId: 'g', notes: ['second'] },
		];
		expect(getHighlightNoteText(data, 'b')).toBe('first\n\nsecond');
	});

	test('returns empty for unknown highlights', () => {
		expect(getHighlightNoteText(single, 'missing')).toBe('');
	});
});

describe('setHighlightNoteText', () => {
	test('sets a trimmed note without mutating the input', () => {
		const next = setHighlightNoteText(single, '1', '  hello  ');
		expect(next[0].notes).toEqual(['hello']);
		expect(single[0].notes).toBeUndefined();
		expect(next[1]).toBe(single[1]);
	});

	test('replaces an existing note', () => {
		expect(setHighlightNoteText(single, '2', 'new')[1].notes).toEqual(['new']);
	});

	test('removes the note when text is empty', () => {
		const next = setHighlightNoteText(single, '2', '   ');
		expect(next[1]).not.toHaveProperty('notes');
	});

	test('stores a group note on the first member and clears the others', () => {
		const next = setHighlightNoteText(grouped, '11', 'group note');
		expect(next[0].notes).toEqual(['group note']);
		expect(next[1]).not.toHaveProperty('notes');
		expect(next[2]).toBe(grouped[2]);
		expect(getHighlightNoteText(next, '10')).toBe('group note');
	});

	test('returns the same array for unknown ids', () => {
		expect(setHighlightNoteText(single, 'missing', 'x')).toBe(single);
	});

	test('notes survive the clip export as one merged entry per group', () => {
		const records = setHighlightNoteText([
			{ id: '1700000000000', type: 'text', xpath: '', content: 'part one', startOffset: 0, endOffset: 8, groupId: 'g' },
			{ id: '1700000000001', type: 'text', xpath: '', content: 'part two', startOffset: 0, endOffset: 8, groupId: 'g' },
		] as AnyHighlightData[], '1700000000001', 'why this matters');
		const exported = collapseGroupsForExport(records);
		expect(exported).toHaveLength(1);
		expect(exported[0]).toMatchObject({ text: 'part one\n\npart two', notes: ['why this matters'] });
	});
});

describe('hasHighlightNotes', () => {
	test('ignores blank notes', () => {
		expect(hasHighlightNotes({ id: '1', notes: [' '] })).toBe(false);
		expect(hasHighlightNotes({ id: '1', notes: ['x'] })).toBe(true);
		expect(hasHighlightNotes({ id: '1' })).toBe(false);
	});
});
