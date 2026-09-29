import { describe, expect, test } from 'vitest';
import { buildRelatedDocumentsQuery } from './outline-related';

describe('buildRelatedDocumentsQuery', () => {
	test('drops a pipe site suffix', () => {
		expect(buildRelatedDocumentsQuery('Deep Modules in Practice | Hacker News'))
			.toBe('Deep Modules Practice');
	});

	test('drops a dash site suffix', () => {
		expect(buildRelatedDocumentsQuery('The Future of TypeScript - The Verge'))
			.toBe('Future TypeScript');
	});

	test('strips leading notification counts', () => {
		expect(buildRelatedDocumentsQuery('(5) Someone posted on X'))
			.toBe('Someone posted X');
	});

	test('keeps at most 8 meaningful words', () => {
		const title = 'one two three four five six seven eight nine ten';
		expect(buildRelatedDocumentsQuery(title).split(' ')).toHaveLength(8);
	});

	test('removes common stop words', () => {
		expect(buildRelatedDocumentsQuery('The State of the Art in Rust'))
			.toBe('State Art Rust');
	});

	test('falls back to raw words when everything is a stop word', () => {
		expect(buildRelatedDocumentsQuery('the and of')).toBe('the and of');
	});

	test('does not gut short titles that merely contain a dash', () => {
		// "Co" before the dash is too short to be a title head, so nothing is stripped
		const result = buildRelatedDocumentsQuery('Co-op');
		expect(result.length).toBeGreaterThan(0);
	});

	test('trims punctuation around words', () => {
		expect(buildRelatedDocumentsQuery('  "Hello", world!  ')).toBe('Hello world');
	});

	test('returns empty for blank or non-string input', () => {
		expect(buildRelatedDocumentsQuery('')).toBe('');
		expect(buildRelatedDocumentsQuery('   ')).toBe('');
		// @ts-expect-error runtime guard for non-string
		expect(buildRelatedDocumentsQuery(undefined)).toBe('');
	});

	test('preserves CJK titles (no ASCII stop-word loss)', () => {
		expect(buildRelatedDocumentsQuery('深入理解 TypeScript 类型系统 | 掘金'))
			.toBe('深入理解 TypeScript 类型系统');
	});
});
