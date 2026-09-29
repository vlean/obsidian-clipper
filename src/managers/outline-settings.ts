import browser from '../utils/browser-polyfill';
import { generalSettings, saveSettings, getOutlineApiKey, setOutlineApiKey } from '../utils/storage-utils';
import { initializeSettingToggle } from '../utils/ui-utils';
import { getMessage } from '../utils/i18n';
import { debounce } from '../utils/debounce';
import { OutlineCollection, getOutlineErrorMessageKey, normalizeOutlineBaseUrl } from '../utils/outline-client';
import { OUTLINE_ACTIONS, OutlineTestConnectionResponse } from '../utils/outline-service';
import { OutlineSettings } from '../types/types';

function saveOutlineSettings(changes: Partial<OutlineSettings>): Promise<void> {
	return saveSettings({ outline: { ...generalSettings.outline, ...changes } });
}

function setStatus(text: string, isError = false): void {
	const status = document.getElementById('outline-connection-status');
	if (!status) return;
	status.textContent = text;
	status.style.color = isError ? 'var(--text-error)' : '';
}

function renderCollectionOptions(select: HTMLSelectElement, collections: OutlineCollection[] | null): void {
	const { collectionId, collectionName } = generalSettings.outline;
	select.textContent = '';

	const addOption = (value: string, label: string, disabled = false) => {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		option.disabled = disabled;
		select.appendChild(option);
	};

	if (collections === null) {
		// Not connected yet: show the saved collection (if any) so the setting is visible
		if (collectionId) {
			addOption(collectionId, collectionName || collectionId);
		} else {
			addOption('', getMessage('outlineConnectToLoad'), true);
		}
	} else if (collections.length === 0) {
		addOption('', getMessage('outlineNoCollections'), true);
	} else {
		if (!collections.some(c => c.id === collectionId)) {
			addOption('', getMessage('outlineSelectCollection'), true);
		}
		for (const collection of collections) {
			addOption(collection.id, collection.name);
		}
	}

	select.value = collections?.some(c => c.id === collectionId) || (collections === null && collectionId) ? collectionId : '';
}

/** Persists the URL field. Returns false if the URL is invalid. */
async function commitBaseUrl(input: HTMLInputElement): Promise<boolean> {
	try {
		const normalized = normalizeOutlineBaseUrl(input.value);
		input.value = normalized;
		if (normalized !== generalSettings.outline.baseUrl) {
			await saveOutlineSettings({ baseUrl: normalized });
		}
		return true;
	} catch {
		setStatus(getMessage('outlineInvalidUrl'), true);
		return false;
	}
}

export async function initializeOutlineSettings(): Promise<void> {
	const baseUrlInput = document.getElementById('outline-base-url') as HTMLInputElement | null;
	const apiKeyInput = document.getElementById('outline-api-key') as HTMLInputElement | null;
	const connectButton = document.getElementById('outline-connect-btn') as HTMLButtonElement | null;
	const collectionSelect = document.getElementById('outline-collection-select') as HTMLSelectElement | null;
	if (!baseUrlInput || !apiKeyInput || !connectButton || !collectionSelect) return;

	baseUrlInput.value = generalSettings.outline.baseUrl;
	apiKeyInput.value = await getOutlineApiKey();
	renderCollectionOptions(collectionSelect, null);

	baseUrlInput.addEventListener('change', () => { commitBaseUrl(baseUrlInput); });
	const saveApiKey = debounce(() => { setOutlineApiKey(apiKeyInput.value); }, 500);
	apiKeyInput.addEventListener('input', saveApiKey);
	apiKeyInput.addEventListener('change', () => { setOutlineApiKey(apiKeyInput.value); });

	// Enter in either field runs the connection test
	for (const input of [baseUrlInput, apiKeyInput]) {
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				connectButton.click();
			}
		});
	}

	collectionSelect.addEventListener('change', () => {
		const selected = collectionSelect.selectedOptions[0];
		saveOutlineSettings({
			collectionId: collectionSelect.value,
			collectionName: selected?.textContent ?? '',
		});
	});

	initializeSettingToggle('outline-publish-toggle', generalSettings.outline.publish, (checked) => {
		saveOutlineSettings({ publish: checked });
	});

	connectButton.addEventListener('click', async () => {
		// Persist the current field values first; the background reads them from storage
		if (!(await commitBaseUrl(baseUrlInput))) return;
		await setOutlineApiKey(apiKeyInput.value);

		connectButton.disabled = true;
		setStatus(getMessage('outlineConnecting'));
		try {
			const response = await browser.runtime.sendMessage({ action: OUTLINE_ACTIONS.testConnection }) as OutlineTestConnectionResponse | undefined;
			if (!response || !response.success) {
				const detail = response?.error ? ` (${response.error})` : '';
				setStatus(`${getMessage(getOutlineErrorMessageKey(response?.errorKind))}${detail}`, true);
				return;
			}

			setStatus(getMessage('outlineConnectedAs', [response.userName, response.teamName]));
			renderCollectionOptions(collectionSelect, response.collections);

			// Keep the cached name in sync, or auto-select when there's only one collection
			const current = response.collections.find(c => c.id === generalSettings.outline.collectionId);
			if (current && current.name !== generalSettings.outline.collectionName) {
				await saveOutlineSettings({ collectionName: current.name });
			} else if (!current && response.collections.length === 1) {
				const only = response.collections[0];
				await saveOutlineSettings({ collectionId: only.id, collectionName: only.name });
				collectionSelect.value = only.id;
			}
		} catch (error) {
			console.error('Outline connection test failed:', error);
			setStatus(getMessage('outlineErrorGeneric'), true);
		} finally {
			connectButton.disabled = false;
		}
	});
}
