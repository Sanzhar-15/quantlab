/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//  Design-token contract tests (megaudit 2026-06-11 W3: H51/H52/H54/H55/H74/M9/M104).
//
//  The light-theme break class of bug: a panel references var(--ql-X, #<dark hex>)
//  where --ql-X is not defined anywhere, so the fixed dark fallback always wins and
//  the panel renders dark-on-light. These tests pin the contract:
//    1. every --ql-* token referenced by the Home/dashboard inline CSS is DEFINED
//       in media/tokens.css (and tokens.css itself has no dangling chains);
//    2. no inline CSS in those panels carries a fixed-hex var() fallback;
//    3. the webview CSS files keep --ql-accent on the canonical
//       --vscode-quantlabAccent chain instead of clobbering it with a plain hex.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// out/src/test -> extension root
const extensionRoot = path.resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
	return fs.readFileSync(path.join(extensionRoot, relPath), 'utf8');
}

/** All --ql-* property NAMES defined (i.e. assigned) in a CSS text. */
function definedTokens(css: string): Set<string> {
	const out = new Set<string>();
	for (const m of css.matchAll(/(--ql-[\w-]+)\s*:/g)) {
		out.add(m[1]);
	}
	return out;
}

/** All --ql-* tokens consumed via var(...) in a text. */
function referencedTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/var\(\s*(--ql-[\w-]+)/g)) {
		out.add(m[1]);
	}
	return out;
}

suite('design tokens (tokens.css contract)', () => {
	const tokensCss = read('media/tokens.css');
	const tokens = definedTokens(tokensCss);

	test('tokens.css defines the surface tokens used by Home + dashboards', () => {
		for (const required of [
			'--ql-base', '--ql-surface', '--ql-hover', '--ql-inset', '--ql-error',
			'--ql-bg', '--ql-fg', '--ql-muted', '--ql-border', '--ql-card-bg',
			'--ql-accent', '--ql-accent-fg', '--ql-accent-foreground',
		]) {
			assert.ok(tokens.has(required), `tokens.css must define ${required}`);
		}
	});

	test('tokens.css has no dangling internal --ql-* chains', () => {
		for (const ref of referencedTokens(tokensCss)) {
			assert.ok(tokens.has(ref), `tokens.css references ${ref} but never defines it`);
		}
	});

	test('tokens.css keeps --ql-accent on the --vscode-quantlabAccent chain', () => {
		assert.match(tokensCss, /--ql-accent:\s*var\(--vscode-quantlabAccent,\s*#FF7331\)/);
	});

	for (const panelSource of [
		'src/auth/QuantLabHome.ts',
		'src/panels/dashboard/DashboardWebviewPanel.ts',
	]) {
		test(`${panelSource}: every var(--ql-*) resolves via tokens.css`, () => {
			const source = read(panelSource);
			const refs = referencedTokens(source);
			assert.ok(refs.size > 0, 'expected the panel inline CSS to use --ql-* tokens');
			for (const ref of refs) {
				assert.ok(tokens.has(ref), `${panelSource} references ${ref} which tokens.css does not define`);
			}
		});

		test(`${panelSource}: no fixed-hex var() fallbacks (light-theme break class)`, () => {
			const source = read(panelSource);
			const offenders = [...source.matchAll(/var\(\s*--ql-[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g)].map(m => m[0]);
			assert.deepStrictEqual(offenders, [], `fixed-hex fallbacks defeat theming: ${offenders.join(', ')}`);
		});

		test(`${panelSource}: no hex-concat alpha on var() output (invalid CSS)`, () => {
			const source = read(panelSource);
			const offenders = [...source.matchAll(/var\([^)]*\)[0-9a-fA-F]{2}\b/g)].map(m => m[0]);
			assert.deepStrictEqual(offenders, [], `hex suffix after var() is invalid CSS: ${offenders.join(', ')}`);
		});
	}
});

suite('design tokens (webview css accent chain)', () => {
	for (const cssFile of [
		'webview/trade/trade.css',
		'webview/action/action.css',
		'webview/stats/stats.css',
		'webview/visualise/visualise.css',
	]) {
		test(`${cssFile}: --ql-accent uses the canonical --vscode-quantlabAccent chain`, () => {
			const css = read(cssFile);
			assert.match(
				css,
				/--ql-accent:\s*var\(--vscode-quantlabAccent,\s*#FF7331\)/,
				`${cssFile} must not clobber --ql-accent with a plain hex`
			);
			assert.doesNotMatch(
				css,
				/--ql-accent:\s*#/,
				`${cssFile} still hardcodes --ql-accent to a literal hex`
			);
		});
	}
});
