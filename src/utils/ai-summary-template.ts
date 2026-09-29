// Builds a ready-to-use template that prepends an AI-generated summary callout
// above the clipped content. The summary is produced by the Interpreter: the
// callout body is a prompt variable filtered through knap's `callout` filter,
// which wraps every line of the model output in a `> ` quote marker so
// multi-line bullet lists stay inside a single Obsidian callout. That callout
// is later converted to an Outline notice by convertMarkdownForOutline().
//
// The helper is pure (aside from reading the current UI language) and returns a
// Template object, so it can be unit tested without touching storage or the DOM.

import { Template } from '../types/types';
import { createDefaultTemplate } from '../managers/template-manager';
import { getMessage, isChineseUILanguage } from './i18n';

/** Localized instruction sent to the model. */
export function summaryPromptText(chinese: boolean): string {
	return chinese
		? '用简体中文总结这篇文章最重要的 3 到 5 个要点，每个要点单独一行，以短横线加空格开头（例如 - 要点），保持精炼，不要添加多余的开场白或结束语。'
		: 'Summarize the most important key points of this article as 3 to 5 concise bullet points in English. Put each point on its own line starting with a dash and a space (for example, - point). Do not add any preamble or closing remarks.';
}

/**
 * The noteContentFormat for the summary template.
 *
 * `{{"<prompt>"|callout:("summary","<label>",false)}}` expands (after the
 * Interpreter runs and the filter is applied to the model output) to:
 *
 *   > [!summary]+ <label>
 *   > - point one
 *   > - point two
 *
 * followed by a blank line and the page content.
 */
export function buildSummaryNoteContentFormat(chinese: boolean): string {
	const label = getMessage('outlineAiSummaryCalloutTitle');
	const prompt = summaryPromptText(chinese);
	// Escape any double quotes so the prompt/label stay inside the {{"..."}} syntax
	const safePrompt = prompt.replace(/"/g, '\\"');
	const safeLabel = label.replace(/"/g, '\\"');
	return `{{"${safePrompt}"|callout:("summary","${safeLabel}",false)}}\n\n{{content}}`;
}

/**
 * Creates a new template (never mutating existing ones) that adds an AI summary
 * callout above the clipped content. `existingNames` is used to keep the name
 * unique; pass the names of the current templates.
 */
export function createAiSummaryTemplate(existingNames: Iterable<string> = []): Template {
	const chinese = isChineseUILanguage();
	const template = createDefaultTemplate();
	template.name = uniqueName(getMessage('outlineAiSummaryTemplateName'), existingNames);
	template.noteContentFormat = buildSummaryNoteContentFormat(chinese);
	return template;
}

function uniqueName(baseName: string, existingNames: Iterable<string>): string {
	const taken = new Set(existingNames);
	if (!taken.has(baseName)) return baseName;
	let counter = 2;
	while (taken.has(`${baseName} ${counter}`)) counter++;
	return `${baseName} ${counter}`;
}
