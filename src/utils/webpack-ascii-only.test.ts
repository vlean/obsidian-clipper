import { describe, expect, it } from 'vitest';

// Regression guard for the Terser `ascii_only` setting.
//
// content.js, content-extract.js and reader-script.js are injected into pages
// by PATH via chrome.scripting.executeScript({ files: [...] }). Chrome's file
// loader rejects any script file containing 4-byte UTF-8 sequences (Unicode
// code points > U+FFFF — e.g. the mathematical-script letters 𝒜𝒞… pulled in by
// defuddle/highlight.js) with the error "Could not load file … It isn't UTF-8
// encoded.", which silently breaks reader mode and page-content extraction.
//
// Setting Terser's format.ascii_only = true escapes every non-ASCII character
// as \uXXXX, keeping the emitted files pure ASCII so every browser accepts
// them. If someone flips this back to false, the extension builds fine but
// breaks at runtime in a way unit tests of the source can't otherwise catch —
// so we assert the build config directly.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpackConfigFactory = require('../../webpack.config.js');

function terserFormatOptions(mode: 'production' | 'development') {
	const configs = webpackConfigFactory({ BROWSER: 'chrome' }, { mode });
	const main = Array.isArray(configs) ? configs[0] : configs;
	const minimizers = main.optimization?.minimizer ?? [];
	// TerserPlugin stores the resolved terserOptions at
	// plugin.options.minimizer.options.
	const terser = minimizers.find((m: any) => m?.options?.minimizer?.options?.format);
	expect(terser, 'expected a TerserPlugin with terserOptions in optimization.minimizer').toBeTruthy();
	return terser.options.minimizer.options.format;
}

describe('webpack Terser output encoding (Chrome executeScript UTF-8 safety)', () => {
	it('keeps ascii_only:true in production so injected bundles stay pure ASCII', () => {
		const format = terserFormatOptions('production');
		expect(format.ascii_only).toBe(true);
	});

	it('keeps ascii_only:true in development too', () => {
		const format = terserFormatOptions('development');
		expect(format.ascii_only).toBe(true);
	});
});
