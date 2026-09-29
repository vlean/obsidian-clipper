// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import {
	createAiSummaryTemplate,
	buildSummaryNoteContentFormat,
	summaryPromptText,
} from './ai-summary-template';
import { collectPromptVariables } from './interpreter';
import { convertMarkdownForOutline } from './outline-markdown';

describe('createAiSummaryTemplate', () => {
	test('is a new template with default properties and a summary + content body', () => {
		const template = createAiSummaryTemplate([]);
		expect(template.name).toBeTruthy();
		// Inherits the default template's properties
		expect(template.properties.map(p => p.name)).toContain('title');
		expect(template.properties.map(p => p.name)).toContain('source');
		// Content: an interpreter prompt callout above {{content}}
		expect(template.noteContentFormat).toContain('|callout:(');
		expect(template.noteContentFormat.trim().endsWith('{{content}}')).toBe(true);
		// A blank line separates the callout from the content
		expect(template.noteContentFormat).toContain('\n\n{{content}}');
	});

	test('gives the template a unique name when the base name is taken', () => {
		const first = createAiSummaryTemplate([]);
		const second = createAiSummaryTemplate([first.name]);
		expect(second.name).not.toBe(first.name);
	});

	test('the prompt variable is recognized by the interpreter prompt collector', () => {
		const template = createAiSummaryTemplate([]);
		const prompts = collectPromptVariables(template);
		expect(prompts).toHaveLength(1);
		// The collected prompt carries the callout filter chain
		expect(prompts[0].filters).toContain('callout');
		expect(prompts[0].prompt).toContain(summaryPromptText(false).replace(/"/g, ''));
	});

	test('a sample model output converts to an Outline notice containing the bullets', () => {
		// Simulate what the interpreter produces: the model output wrapped by the
		// `callout` filter, followed by a blank line and the page content.
		const summaryCallout = [
			'> [!summary]+ Summary',
			'> - First key point',
			'> - Second key point',
			'> - Third key point',
		].join('\n');
		const compiled = `${summaryCallout}\n\n# Article\n\nBody text.`;

		const outline = convertMarkdownForOutline(compiled);
		// Summary callout becomes an Outline notice (info)
		expect(outline).toContain(':::info');
		expect(outline).toContain('First key point');
		expect(outline).toContain('Second key point');
		expect(outline).toContain('Third key point');
		// The content survives outside the notice
		expect(outline).toContain('# Article');
		expect(outline).toContain('Body text.');
	});
});

describe('summaryPromptText', () => {
	test('is English by default and Chinese when requested', () => {
		expect(summaryPromptText(false).toLowerCase()).toContain('bullet');
		expect(summaryPromptText(true)).toContain('简体中文');
	});
});

describe('buildSummaryNoteContentFormat', () => {
	test('produces valid {{"prompt"|callout:(...)}} syntax', () => {
		const format = buildSummaryNoteContentFormat(false);
		expect(format).toMatch(/^\{\{".*"\|callout:\("summary",".*",false\)\}\}/);
	});
});
