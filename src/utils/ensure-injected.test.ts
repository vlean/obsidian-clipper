import { describe, expect, it, vi } from 'vitest';
import {
	ensureInjected,
	injectAndConfirm,
	makeEnsureLoader,
	type EnsureInjectedDeps,
	type LoadEntry,
} from './ensure-injected';

// A fake browser adapter. `answered` controls whether an initial ping/inject
// "listener" answers; `injectMakesReady` flips it true once injectFile runs,
// modelling a script that starts responding after injection.
function makeDeps(opts: {
	answered: boolean;
	injectMakesReady?: boolean;
	injectThrows?: boolean;
} = { answered: false }): {
	deps: EnsureInjectedDeps;
	sendMessage: ReturnType<typeof vi.fn>;
	injectFile: ReturnType<typeof vi.fn>;
	order: string[];
} {
	const order: string[] = [];
	let ready = opts.answered;
	const sendMessage = vi.fn(async (_tabId: number, message: any) => {
		order.push(`send:${message.action}`);
		if (!ready) throw new Error('no listener');
		return { ok: true };
	});
	const injectFile = vi.fn(async (_tabId: number, file: string) => {
		order.push(`inject:${file}`);
		if (opts.injectThrows) throw new Error('inject failed');
		if (opts.injectMakesReady) ready = true;
	});
	const deps: EnsureInjectedDeps = {
		sendMessage,
		injectFile,
		sleep: async () => { /* no real delay in tests */ },
	};
	return { deps, sendMessage, injectFile, order };
}

describe('ensureInjected', () => {
	it('does not inject when the script already answers the ping', async () => {
		const { deps, sendMessage, injectFile } = makeDeps({ answered: true });
		await ensureInjected(deps, { tabId: 1, file: 'content.js', pingAction: 'ping' });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(injectFile).not.toHaveBeenCalled();
	});

	it('injects then confirms readiness when the ping fails', async () => {
		const { deps, sendMessage, injectFile } = makeDeps({ answered: false, injectMakesReady: true });
		await ensureInjected(deps, { tabId: 1, file: 'content.js', pingAction: 'ping' });
		// One failing ping, one inject, one confirming ping.
		expect(injectFile).toHaveBeenCalledWith(1, 'content.js');
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('runs the prerequisite BEFORE pinging/injecting (core → extract ordering)', async () => {
		const { deps, order } = makeDeps({ answered: false, injectMakesReady: true });
		const prerequisite = vi.fn(async () => { order.push('prerequisite'); });
		await ensureInjected(deps, {
			tabId: 1,
			file: 'content-extract.js',
			pingAction: 'pingExtract',
			prerequisite,
		});
		expect(prerequisite).toHaveBeenCalledTimes(1);
		// Prerequisite must be the very first thing to run.
		expect(order[0]).toBe('prerequisite');
		expect(order).toContain('inject:content-extract.js');
	});

	it('throws when the script never responds after injection', async () => {
		const { deps, sendMessage } = makeDeps({ answered: false, injectMakesReady: false });
		await expect(
			ensureInjected(deps, {
				tabId: 1,
				file: 'content-extract.js',
				pingAction: 'pingExtract',
				pollAttempts: 3,
				label: 'Extraction bundle',
			}),
		).rejects.toThrow('Extraction bundle did not respond after injection');
		// Initial ping + 3 confirming polls = 4 sends.
		expect(sendMessage).toHaveBeenCalledTimes(4);
	});

	it('propagates injection failures', async () => {
		const { deps } = makeDeps({ answered: false, injectThrows: true });
		await expect(
			ensureInjected(deps, { tabId: 1, file: 'content.js', pingAction: 'ping' }),
		).rejects.toThrow('inject failed');
	});
});

describe('injectAndConfirm', () => {
	it('polls up to pollAttempts times before throwing', async () => {
		const { deps, sendMessage } = makeDeps({ answered: false, injectMakesReady: false });
		await expect(
			injectAndConfirm(deps, {
				tabId: 7,
				file: 'x.js',
				pingAction: 'pingX',
				pollAttempts: 5,
			}),
		).rejects.toThrow('x.js did not respond after injection');
		expect(sendMessage).toHaveBeenCalledTimes(5);
	});
});

describe('makeEnsureLoader', () => {
	it('shares a single in-flight promise once an entry is registered', async () => {
		const loads = new Map<number, LoadEntry>();
		let runs = 0;
		let resolveRun!: () => void;
		const run = vi.fn(() => {
			runs++;
			return new Promise<void>((resolve) => { resolveRun = resolve; });
		});
		// getUrl resolves synchronously (already-resolved value) so the first
		// call registers its entry before we launch the second.
		const ensure = makeEnsureLoader(loads, () => Promise.resolve('http://a'), run);

		const p1 = ensure(1);
		// Let the first call get past `await getUrl` and store its entry.
		await Promise.resolve();
		await Promise.resolve();
		expect(loads.has(1)).toBe(true);

		const p2 = ensure(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1); // de-duplicated: p2 reuses p1's promise
		expect(runs).toBe(1);

		resolveRun();
		await Promise.all([p1, p2]);
		// Entry cleaned up after completion.
		expect(loads.has(1)).toBe(false);
	});

	it('starts a fresh load when the tab URL changed', async () => {
		const loads = new Map<number, LoadEntry>();
		const urls = ['http://a', 'http://b'];
		let i = 0;
		const run = vi.fn(async () => { /* resolves immediately */ });
		const ensure = makeEnsureLoader(loads, async () => urls[i++], run);

		await ensure(1); // url a
		await ensure(1); // url b — different, so runs again
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('cleans up the entry even when the run rejects', async () => {
		const loads = new Map<number, LoadEntry>();
		const run = vi.fn(async () => { throw new Error('boom'); });
		const ensure = makeEnsureLoader(loads, async () => 'http://a', run);

		await expect(ensure(1)).rejects.toThrow('boom');
		expect(loads.has(1)).toBe(false);
	});
});
