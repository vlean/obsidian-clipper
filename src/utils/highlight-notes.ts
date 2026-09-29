// Pure helpers for reading and writing highlight annotations (`notes`).
//
// A multi-block selection produces several highlights sharing a groupId; they
// act as one logical highlight, so notes are read merged across the group and
// written onto the group's first member (matching collapseGroupsForExport,
// which merges notes across a group).

export interface NotableHighlight {
	id: string;
	groupId?: string;
	notes?: string[];
}

function groupMembers<T extends NotableHighlight>(highlights: T[], id: string): T[] {
	const target = highlights.find(h => h.id === id);
	if (!target) return [];
	return target.groupId ? highlights.filter(h => h.groupId === target.groupId) : [target];
}

/** Notes for a highlight (merged across its group), as editable text. */
export function getHighlightNoteText(highlights: NotableHighlight[], id: string): string {
	return groupMembers(highlights, id)
		.flatMap(h => h.notes ?? [])
		.map(note => note.trim())
		.filter(Boolean)
		.join('\n\n');
}

export function hasHighlightNotes(highlight: NotableHighlight): boolean {
	return Array.isArray(highlight.notes) && highlight.notes.some(note => note.trim().length > 0);
}

/**
 * Returns a new highlights array with the note for `id` (and its group) set to
 * `text`. Empty text removes the note. Returns the input array unchanged when
 * the highlight doesn't exist.
 */
export function setHighlightNoteText<T extends NotableHighlight>(highlights: T[], id: string, text: string): T[] {
	const members = groupMembers(highlights, id);
	if (members.length === 0) return highlights;
	const owner = members[0];
	const memberIds = new Set(members.map(m => m.id));
	const note = text.trim();

	return highlights.map(h => {
		if (!memberIds.has(h.id)) return h;
		const next = { ...h };
		if (h.id === owner.id && note) {
			next.notes = [note];
		} else {
			delete next.notes;
		}
		return next;
	});
}
