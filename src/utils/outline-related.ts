// Pure helper that turns a page title into a search query for finding related
// documents in an Outline workspace. Page titles are noisy: they carry site
// suffixes ("… | Hacker News", "… - The Verge"), social-notification prefixes
// ("(5) Someone posted on X"), and trailing separators. This strips that noise
// and keeps up to a handful of meaningful words so the Postgres full-text search
// has something focused to match on.

const MAX_QUERY_WORDS = 8;

// Common "leading noise" patterns, e.g. unread counts like "(5) " that some
// sites (X/Twitter, LinkedIn) prepend to the tab title.
const LEADING_NOISE_RE = /^\s*\(\d+\+?\)\s*/;

// Separators used between the article title and the site name. We keep the
// longest (first) segment, which is almost always the actual title.
const SITE_SUFFIX_SEPARATORS = [' | ', ' - ', ' – ', ' — ', ' :: ', ' • ', ' · ', '｜', ' » '];

// Words that carry no search signal on their own. Kept deliberately small so we
// don't accidentally drop meaningful terms in other languages.
const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'is', 'are',
]);

/** Removes leading notification noise like "(5) ". */
function stripLeadingNoise(title: string): string {
	let result = title;
	// Apply repeatedly in case of stacked prefixes
	while (LEADING_NOISE_RE.test(result)) {
		result = result.replace(LEADING_NOISE_RE, '');
	}
	return result;
}

/**
 * Drops a trailing site name after the last separator, but only when the title
 * part before it is substantial (so we don't gut short titles that merely
 * contain a dash).
 */
function stripSiteSuffix(title: string): string {
	let result = title;
	for (const separator of SITE_SUFFIX_SEPARATORS) {
		const index = result.lastIndexOf(separator);
		if (index <= 0) continue;
		const head = result.slice(0, index).trim();
		const tail = result.slice(index + separator.length).trim();
		// Only strip when the head keeps most of the meaning and the tail looks
		// like a site name (short-ish, no sentence punctuation).
		if (head.length >= 3 && tail.length > 0 && tail.length <= 40) {
			result = head;
		}
	}
	return result;
}

/**
 * Builds a search query from a page title. Returns an empty string when the
 * title yields no meaningful words (the caller should then skip the search).
 */
export function buildRelatedDocumentsQuery(rawTitle: string): string {
	if (typeof rawTitle !== 'string') return '';
	let title = stripLeadingNoise(rawTitle.trim());
	title = stripSiteSuffix(title);

	// Split into words, dropping punctuation-only tokens
	const words = title
		.split(/\s+/)
		.map(word => word.replace(/^[^\p{L}\p{N}#@]+|[^\p{L}\p{N}]+$/gu, ''))
		.filter(Boolean);

	// Drop stop words, but never end up empty because of it
	const meaningful = words.filter(word => !STOP_WORDS.has(word.toLowerCase()));
	const chosen = (meaningful.length > 0 ? meaningful : words).slice(0, MAX_QUERY_WORDS);
	return chosen.join(' ').trim();
}
