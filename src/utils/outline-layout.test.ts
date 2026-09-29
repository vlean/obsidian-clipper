import { describe, expect, test } from 'vitest';
import {
	addParagraphSpacing,
	applyBilingualLayout,
	parseFrontmatterProperties,
	renderFrontmatterProperties,
} from './outline-layout';
import { buildOutlineDocumentText } from './outline-markdown';
import { generateFrontmatter } from './shared';

const labels = { name: '属性', value: '值' };

describe('parseFrontmatterProperties', () => {
	test('parses the YAML produced by generateFrontmatter', () => {
		const frontmatter = generateFrontmatter([
			{ name: 'title', value: 'Say "hi"' },
			{ name: 'source', value: 'https://example.com/a' },
			{ name: 'author', value: '[[Jane Doe]], [[John|Johnny]]', type: 'multitext' },
			{ name: 'published', value: '2026-05-08', type: 'date' },
			{ name: 'description', value: '' },
			{ name: 'my key', value: 'x: y' },
			{ name: 'tags', value: 'clippings', type: 'multitext' },
		], { author: 'multitext', tags: 'multitext', published: 'date' });

		expect(parseFrontmatterProperties(frontmatter)).toEqual([
			{ name: 'title', values: ['Say "hi"'] },
			{ name: 'source', values: ['https://example.com/a'] },
			{ name: 'author', values: ['[[Jane Doe]]', '[[John|Johnny]]'] },
			{ name: 'published', values: ['2026-05-08'] },
			{ name: 'description', values: [] },
			{ name: 'my key', values: ['x: y'] },
			{ name: 'tags', values: ['clippings'] },
		]);
	});

	test('returns nothing for empty input', () => {
		expect(parseFrontmatterProperties('')).toEqual([]);
	});
});

describe('renderFrontmatterProperties', () => {
	const properties = [
		{ name: 'title', values: ['Page'] },
		{ name: 'source', values: ['https://example.com/a'] },
		{ name: 'author', values: ['[[Jane Doe]]', '[[John|Johnny]]'] },
		{ name: 'description', values: [] },
		{ name: 'note', values: ['a | b'] },
	];

	test('renders a table without the title and empty values', () => {
		expect(renderFrontmatterProperties(properties, 'table', labels)).toBe([
			'| 属性 | 值 |',
			'| --- | --- |',
			'| source | [https://example.com/a](https://example.com/a) |',
			'| author | Jane Doe, Johnny |',
			'| note | a \\| b |',
			'', '',
		].join('\n'));
	});

	test('renders a notice', () => {
		expect(renderFrontmatterProperties(properties, 'callout', labels)).toBe(
			':::info\n**source**: [https://example.com/a](https://example.com/a)\n\n**author**: Jane Doe, Johnny\n\n**note**: a | b\n:::\n\n'
		);
	});

	test('renders nothing when all values are empty', () => {
		expect(renderFrontmatterProperties([{ name: 'title', values: ['x'] }], 'table', labels)).toBe('');
	});
});

describe('addParagraphSpacing', () => {
	test('inserts empty paragraphs between paragraphs but not next to headings', () => {
		const md = '# Title\n\nFirst para\nsoft wrapped\n\nSecond para\n\n## Section\n\nThird';
		expect(addParagraphSpacing(md)).toBe(
			'# Title\n\nFirst para\nsoft wrapped\n\n\\\n\nSecond para\n\n## Section\n\nThird'
		);
	});

	test('keeps loose lists, code with blank lines and notices intact', () => {
		const md = [
			'Intro',
			'',
			'- item one',
			'',
			'- item two',
			'  continued',
			'',
			'```js',
			'a();',
			'',
			'b();',
			'```',
			'',
			':::info',
			'line 1',
			'',
			'line 2',
			':::',
			'',
			'After',
		].join('\n');
		expect(addParagraphSpacing(md)).toBe([
			'Intro', '', '\\', '',
			'- item one', '', '- item two', '  continued', '', '\\', '',
			'```js', 'a();', '', 'b();', '```', '', '\\', '',
			':::info', 'line 1', '', 'line 2', ':::', '', '\\', '',
			'After',
		].join('\n'));
	});

	test('does not double existing empty paragraphs', () => {
		expect(addParagraphSpacing('A\n\n\\\n\nB')).toBe('A\n\n\\\n\nB');
	});
});

describe('applyBilingualLayout', () => {
	// Shaped like a real Immersive Translate clip of anthropic.com
	const bilingual = [
		'### Why does agentic misalignment happen?为什么会发生主体错位？',
		'',
		'Last year, we released a case study on [agentic misalignment](https://www.anthropic.com/x). In experimental scenarios, models took misaligned actions.  ',
		'去年，我们发布了一份关于 [智能体错位的](https://www.anthropic.com/x) 案例研究。',
		'',
		'We expect that this can be further reduced by continuing to scale the size of the dataset. 如果拥有一个庞大且结构完善的宪法文件数据集，那么勒索率可以从 65% 降低到 19%。',
		'',
		'When we first published this research, our models were from the Claude 4 family. Claude 4 系列是我们首次在训练过程中进行实时对齐评估的模型。',
		'',
		'- Training on documents about the constitution helps a lot 基于宪法文件的训练帮助很大',
		'',
		'```',
		'code line. 中文注释在代码里',
		'```',
	].join('\n');

	test('separates inline translations and heading translations', () => {
		expect(applyBilingualLayout(bilingual)).toBe([
			'### Why does agentic misalignment happen? / 为什么会发生主体错位？',
			'',
			'Last year, we released a case study on [agentic misalignment](https://www.anthropic.com/x). In experimental scenarios, models took misaligned actions.  ',
			'去年，我们发布了一份关于 [智能体错位的](https://www.anthropic.com/x) 案例研究。',
			'',
			'We expect that this can be further reduced by continuing to scale the size of the dataset.\\',
			'如果拥有一个庞大且结构完善的宪法文件数据集，那么勒索率可以从 65% 降低到 19%。',
			'',
			'When we first published this research, our models were from the Claude 4 family.\\',
			'Claude 4 系列是我们首次在训练过程中进行实时对齐评估的模型。',
			'',
			'- Training on documents about the constitution helps a lot\\',
			'  基于宪法文件的训练帮助很大',
			'',
			'```',
			'code line. 中文注释在代码里',
			'```',
		].join('\n'));
	});

	test('leaves ordinary mixed-language text alone', () => {
		const md = '### 使用 Claude API 的方法\n\n我们用 Claude Code 写了一个 CLI 工具，效果不错。\n\nThis is English only. It mentions nothing else.';
		expect(applyBilingualLayout(md)).toBe(md);
	});

	test('needs more than one bilingual paragraph', () => {
		const md = 'We expect that this can be reduced further over time. 我们预计这一比例还可以进一步降低。\n\nPlain English paragraph here.';
		expect(applyBilingualLayout(md)).toBe(md);
	});
});

describe('buildOutlineDocumentText with layout options', () => {
	test('table frontmatter, bilingual layout and spacing together', () => {
		const frontmatter = '---\ntitle: "T"\nsource: "https://example.com/a"\n---\n';
		const body = 'First paragraph.\n\nSecond paragraph.';
		expect(buildOutlineDocumentText(frontmatter, body, {
			frontmatterStyle: 'table', propertyLabels: labels, paragraphSpacing: true, bilingualLayout: true,
		})).toBe([
			'| 属性 | 值 |',
			'| --- | --- |',
			'| source | [https://example.com/a](https://example.com/a) |',
			'', '\\', '',
			'First paragraph.', '', '\\', '',
			'Second paragraph.',
		].join('\n'));
	});

	test('defaults keep the previous output', () => {
		expect(buildOutlineDocumentText('---\ntitle: "T"\n---\n', 'A\n\nB')).toBe('```yaml\ntitle: "T"\n```\n\nA\n\nB');
	});
});
