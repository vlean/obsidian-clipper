// Shared helpers for building Outline save requests from the popup and the
// reader view.

import { getMessage } from './i18n';
import { OutlineTextOptions } from './outline-markdown';
import { OutlineSettings } from '../types/types';

export function getOutlineTextOptions(settings: OutlineSettings): OutlineTextOptions {
	return {
		frontmatterStyle: settings.frontmatterStyle,
		propertyLabels: { name: getMessage('outlinePropertyName'), value: getMessage('outlinePropertyValue') },
		paragraphSpacing: settings.paragraphSpacing,
		bilingualLayout: settings.bilingualLayout,
	};
}

/** The `published` property value, used to backdate new documents when enabled. */
export function getPublishedDate(
	settings: OutlineSettings,
	properties: Array<{ name: string; value: string }>,
): string | undefined {
	if (!settings.usePublishedDate) return undefined;
	const value = properties.find(p => p.name.trim().toLowerCase() === 'published')?.value?.trim();
	return value || undefined;
}
