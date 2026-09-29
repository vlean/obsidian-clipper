import { describe, expect, test } from 'vitest';
import {
	buildOutlineDocumentText,
	convertMarkdownForOutline,
	frontmatterToCodeBlock,
	mapCalloutType,
	normalizeOutlineTitle,
	OUTLINE_TITLE_MAX_LENGTH,
} from './outline-markdown';
import { generateFrontmatter } from './shared';

describe('frontmatterToCodeBlock', () => {
	test('wraps YAML frontmatter in a yaml code block', () => {
		const frontmatter = '---\ntitle: "Hello"\nsource: "https://example.com"\n---\n';
		expect(frontmatterToCodeBlock(frontmatter)).toBe(
			'```yaml\ntitle: "Hello"\nsource: "https://example.com"\n```\n\n'
		);
	});

	test('returns empty string for empty frontmatter', () => {
		expect(frontmatterToCodeBlock('')).toBe('');
		expect(frontmatterToCodeBlock('---\n---\n')).toBe('');
	});

	test('uses a longer fence when YAML contains backticks', () => {
		const result = frontmatterToCodeBlock('---\ncode: "```js```"\n---\n');
		expect(result.startsWith('````yaml\n')).toBe(true);
		expect(result.endsWith('\n````\n\n')).toBe(true);
	});

	test('preserves all properties produced by generateFrontmatter', () => {
		const frontmatter = generateFrontmatter([
			{ name: 'title', value: 'My page' },
			{ name: 'tags', value: 'clippings, web', type: 'multitext' },
			{ name: 'author', value: '[[Jane Doe]]', type: 'multitext' },
		]);
		const block = frontmatterToCodeBlock(frontmatter);
		const inner = frontmatter.replace(/^---\n/, '').replace(/---\n$/, '').trim();
		expect(block).toBe('```yaml\n' + inner + '\n```\n\n');
		// Wikilinks inside frontmatter are preserved verbatim
		expect(block).toContain('[[Jane Doe]]');
	});
});

describe('convertMarkdownForOutline', () => {
	test('converts wikilinks to plain text', () => {
		expect(convertMarkdownForOutline('By [[Jane Doe]] and [[John|Johnny]]'))
			.toBe('By Jane Doe and Johnny');
	});

	test('converts heading and block links', () => {
		expect(convertMarkdownForOutline('See [[Note#Section]]')).toBe('See Note > Section');
		expect(convertMarkdownForOutline('See [[Note#^abc123]]')).toBe('See Note > abc123');
	});

	test('converts embeds to plain text', () => {
		expect(convertMarkdownForOutline('![[image.png]]')).toBe('image.png');
		expect(convertMarkdownForOutline('![[image.png|300]]')).toBe('300');
	});

	test('leaves standard markdown links and images alone', () => {
		const md = '[link](https://example.com) ![alt](https://example.com/a.png)';
		expect(convertMarkdownForOutline(md)).toBe(md);
	});

	test('does not touch inline code or fenced code', () => {
		const md = [
			'Use `[[not a link]]` inline',
			'```',
			'[[also not a link]]',
			'> [!note] not a callout',
			'```',
			'after [[Link]]',
		].join('\n');
		expect(convertMarkdownForOutline(md)).toBe([
			'Use `[[not a link]]` inline',
			'```',
			'[[also not a link]]',
			'> [!note] not a callout',
			'```',
			'after Link',
		].join('\n'));
	});

	test('handles tilde fences and longer closing fences', () => {
		const md = '~~~\n[[x]]\n~~~~\n[[y]]';
		expect(convertMarkdownForOutline(md)).toBe('~~~\n[[x]]\n~~~~\ny');
	});

	test('converts callouts to notices', () => {
		const md = '> [!warning] Be careful\n> This is **important**.\n> Second line';
		expect(convertMarkdownForOutline(md)).toBe(
			':::warning\n**Be careful**\n\nThis is **important**.\nSecond line\n:::'
		);
	});

	test('converts callouts without a title or body', () => {
		expect(convertMarkdownForOutline('> [!tip]\n> Body')).toBe(':::tip\nBody\n:::');
		expect(convertMarkdownForOutline('> [!note] Only title')).toBe(':::info\n**Only title**\n:::');
	});

	test('handles foldable callout markers', () => {
		expect(convertMarkdownForOutline('> [!faq]- Question?\n> Answer')).toBe(
			':::warning\n**Question?**\n\nAnswer\n:::'
		);
	});

	test('uses a longer marker for the outer notice when callouts are nested', () => {
		const md = '> [!note] Outer\n> > [!tip] Inner\n> > inner body\n> outer body';
		expect(convertMarkdownForOutline(md)).toBe([
			'::::info',
			'**Outer**',
			'',
			':::tip',
			'**Inner**',
			'',
			'inner body',
			':::',
			'outer body',
			'::::',
		].join('\n'));
	});

	test('leaves regular blockquotes alone', () => {
		const md = '> Just a quote\n> with [[Link]]';
		expect(convertMarkdownForOutline(md)).toBe('> Just a quote\n> with Link');
	});

	test('keeps highlights, tables and task lists', () => {
		const md = '==highlight==\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] todo\n- [x] done';
		expect(convertMarkdownForOutline(md)).toBe(md);
	});

	test('handles CRLF input', () => {
		expect(convertMarkdownForOutline('a [[b]]\r\nc')).toBe('a b\nc');
	});
});

describe('mapCalloutType', () => {
	test('maps known types and falls back to info', () => {
		expect(mapCalloutType('NOTE')).toBe('info');
		expect(mapCalloutType('danger')).toBe('warning');
		expect(mapCalloutType('success')).toBe('success');
		expect(mapCalloutType('tip')).toBe('tip');
		expect(mapCalloutType('custom-type')).toBe('info');
	});
});

describe('buildOutlineDocumentText', () => {
	test('combines frontmatter code block with converted body', () => {
		const text = buildOutlineDocumentText('---\ntitle: "T"\n---\n', 'Body with [[Link]]');
		expect(text).toBe('```yaml\ntitle: "T"\n```\n\nBody with Link');
	});

	test('works without frontmatter', () => {
		expect(buildOutlineDocumentText('', 'Body')).toBe('Body');
	});
});

describe('normalizeOutlineTitle', () => {
	test('collapses whitespace and trims', () => {
		expect(normalizeOutlineTitle('  Hello\n  world  ')).toBe('Hello world');
	});

	test('uses fallback for empty titles', () => {
		expect(normalizeOutlineTitle('   ')).toBe('Untitled');
		expect(normalizeOutlineTitle('', 'Fallback')).toBe('Fallback');
	});

	test('truncates to the Outline title limit', () => {
		const long = 'a'.repeat(250);
		const result = normalizeOutlineTitle(long);
		expect(Array.from(result).length).toBe(OUTLINE_TITLE_MAX_LENGTH);
		expect(result.endsWith('…')).toBe(true);
	});

	test('does not split surrogate pairs when truncating', () => {
		const long = '😀'.repeat(150);
		const result = normalizeOutlineTitle(long);
		expect(Array.from(result).length).toBe(OUTLINE_TITLE_MAX_LENGTH);
		expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	test('leaves titles at the limit untouched', () => {
		const exact = 'b'.repeat(OUTLINE_TITLE_MAX_LENGTH);
		expect(normalizeOutlineTitle(exact)).toBe(exact);
	});
});
