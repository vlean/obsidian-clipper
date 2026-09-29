// Shared "ensure a script is present in a tab" algorithm, factored out of
// background.ts so it can be unit-tested without loading the whole background
// (which registers listeners and runs side effects on import).
//
// The pattern is identical for the core content script and the on-demand
// extraction bundle: ping the tab; if nothing answers, inject the file and
// poll until it responds. This module captures that flow plus the per-tab
// in-flight de-duplication (idempotency) and an optional prerequisite step
// (used so the extraction bundle only loads AFTER the core script that owns
// the window.__obsidianHighlighter bridge it reads).

export interface EnsureInjectedDeps {
	/** Send a message to the tab; rejects if no listener answers. */
	sendMessage(tabId: number, message: unknown): Promise<unknown>;
	/** Inject the given file into the tab. */
	injectFile(tabId: number, file: string): Promise<void>;
	/** Sleep helper (injected so tests don't wait on real timers). */
	sleep(ms: number): Promise<void>;
}

export interface EnsureInjectedOptions {
	tabId: number;
	/** File to inject when the ping fails, e.g. 'content.js'. */
	file: string;
	/** Ping action this script answers, e.g. 'ping' or 'pingExtract'. */
	pingAction: string;
	/**
	 * Optional step that must complete BEFORE injection/ping. Used to guarantee
	 * ordering: the extraction bundle ensures the core script first.
	 */
	prerequisite?: () => Promise<void>;
	/** Poll attempts after injection before giving up (default 8). */
	pollAttempts?: number;
	/** Delay between poll attempts, ms (default 50). */
	pollDelayMs?: number;
	/** Human label for error messages (default = file). */
	label?: string;
}

// Inject the file, then poll the ping action until the freshly-injected script
// answers. Throws if it never becomes ready.
export async function injectAndConfirm(
	deps: EnsureInjectedDeps,
	options: EnsureInjectedOptions,
): Promise<void> {
	const { tabId, file, pingAction } = options;
	const attempts = options.pollAttempts ?? 8;
	const delay = options.pollDelayMs ?? 50;
	const label = options.label ?? file;

	await deps.injectFile(tabId, file);

	for (let i = 0; i < attempts; i++) {
		try {
			await deps.sendMessage(tabId, { action: pingAction });
			return;
		} catch {
			// Not ready yet.
		}
		await deps.sleep(delay);
	}
	throw new Error(`${label} did not respond after injection`);
}

// Ensure the script is present: run any prerequisite, ping, and inject on miss.
// Callers wrap this with per-tab in-flight de-duplication (see makeEnsureLoader).
export async function ensureInjected(
	deps: EnsureInjectedDeps,
	options: EnsureInjectedOptions,
): Promise<void> {
	if (options.prerequisite) {
		await options.prerequisite();
	}
	try {
		await deps.sendMessage(options.tabId, { action: options.pingAction });
		return;
	} catch {
		// No listener; inject and confirm readiness.
	}
	await injectAndConfirm(deps, options);
}

export interface LoadEntry {
	url: string;
	promise: Promise<void>;
}

/**
 * Build an idempotent per-tab loader around {@link ensureInjected}. Concurrent
 * calls for the same tab+url share a single in-flight promise; a URL change
 * starts a fresh load. Mirrors ensureContentScriptLoadedInBackground so the
 * two behave identically.
 */
export function makeEnsureLoader(
	loads: Map<number, LoadEntry>,
	getUrl: (tabId: number) => Promise<string>,
	run: (tabId: number) => Promise<void>,
): (tabId: number) => Promise<void> {
	return async (tabId: number) => {
		const url = await getUrl(tabId);
		const existing = loads.get(tabId);
		if (existing?.url === url) {
			return existing.promise;
		}
		const promise = run(tabId);
		const entry: LoadEntry = { url, promise };
		loads.set(tabId, entry);
		try {
			await promise;
		} finally {
			if (loads.get(tabId) === entry) {
				loads.delete(tabId);
			}
		}
	};
}
