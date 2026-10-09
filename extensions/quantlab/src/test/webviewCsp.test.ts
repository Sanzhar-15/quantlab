/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// F-QL-WEBVIEW-CSP-1: every QuantLab webview ships the B5 policy (hub folds/HOST/DRIVER1-HOST-ANSWERS.md, "B5 mechanism"):
// default-src 'none'; scripts by nonce only (no 'unsafe-inline', no host source, the effective script-src-elem and
// script-src-attr included); no 'unsafe-eval' in any directive; connect-src the webview's cspSource only. A webview with no
// policy fails. Pure file-based checks -- no vscode runtime: the policy is read from the source that assigns `webview.html`.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(EXTENSION_ROOT, 'src');

// Every source file that assigns a webview's html, as of the fold (the survey in its record). A new site fails until listed.
const WEBVIEW_HTML_FILES = [
	'auth/QuantLabHome.ts',
	'panels/dashboard/DashboardWebviewPanel.ts',
	'panels/resources/ResourcesWebviewProvider.ts',
	'quantbook/bench/renderBenchPanel.ts',
	'quantbook/cellGrid/cellGridPanel.ts',
	'quantbook/shell/SqlQueryViewProvider.ts',
	'ui/onboarding/WelcomeModal.ts',
	'views/action/ActionWebview.ts',
	'views/chart/ChartWebview.ts',
	'views/stats/StatsViewProvider.ts',
	'views/visualise/VisualiseDataProvider.ts',
	'views/visualise/VisualiseSpecProvider.ts',
];

const CSP_SOURCE = 'CSP-SOURCE';
const NONCE = 'NONCE';
const CSP_SOURCE_EXPRESSIONS = new Set(['webview.cspSource', 'cspSource']);
const NONCE_EXPRESSIONS = new Set(['nonce', 'n']);

export function parsePolicy(policy: string): Map<string, string[]> {
	const directives = new Map<string, string[]>();
	for (const part of policy.split(';')) {
		const tokens = part.trim().split(/\s+/).filter(t => t !== '');
		if (tokens.length === 0) {
			continue;
		}
		const name = tokens[0].toLowerCase();
		if (!directives.has(name)) {
			directives.set(name, tokens.slice(1));
		}
	}
	return directives;
}

/** The B5 judgement of one policy with its interpolations already resolved: the failures, each naming its directive. */
export function judgePolicy(policy: string): string[] {
	const directives = parsePolicy(policy);
	const failures: string[] = [];
	const effective = (chain: string[]): string[] | undefined => {
		for (const name of chain) {
			const tokens = directives.get(name);
			if (tokens !== undefined) {
				return tokens;
			}
		}
		return undefined;
	};
	const isNone = (t: string) => t.toLowerCase() === `'none'`;
	const isNonce = (t: string) => /^'nonce-[^']+'$/.test(t);
	const defaultSrc = directives.get('default-src');
	if (defaultSrc === undefined || defaultSrc.length !== 1 || !isNone(defaultSrc[0])) {
		failures.push(`default-src is not 'none' (${defaultSrc === undefined ? 'not declared' : defaultSrc.join(' ')})`);
	}
	for (const chain of [['script-src', 'default-src'], ['script-src-elem', 'script-src', 'default-src'], ['script-src-attr', 'script-src', 'default-src']]) {
		const tokens = effective(chain);
		if (tokens === undefined) {
			failures.push(`${chain[0]}: not declared and no fallback`);
		} else if (!tokens.every(t => isNonce(t) || isNone(t))) {
			failures.push(`${chain[0]} is not nonce-only (${tokens.join(' ')})`);
		}
	}
	const connect = effective(['connect-src', 'default-src']);
	if (connect === undefined) {
		failures.push('connect-src: not declared and no fallback');
	} else if (!connect.every(t => isNone(t) || t === CSP_SOURCE)) {
		failures.push(`connect-src allows a source other than the webview cspSource (${connect.join(' ')})`);
	}
	for (const [name, tokens] of directives) {
		if (tokens.some(t => t.toLowerCase() === `'unsafe-eval'`)) {
			failures.push(`${name} carries 'unsafe-eval'`);
		}
	}
	return failures;
}

/**
 * Not B5, the host's need: the webview host (src/vs/workbench/contrib/webview/browser/pre/index.html, toContentHtml) writes the
 * theme's --vscode-* variables as a style attribute on <html> and prepends a <style id="_defaultStyles"> without a nonce. The
 * effective style-src, style-src-elem and style-src-attr must therefore carry 'unsafe-inline' and no nonce or hash (either one
 * makes the browser ignore 'unsafe-inline'). Style is not script: B5's script rules are judged by judgePolicy.
 */
export function judgeHostStyles(policy: string): string[] {
	const directives = parsePolicy(policy);
	const failures: string[] = [];
	for (const chain of [['style-src', 'default-src'], ['style-src-elem', 'style-src', 'default-src'], ['style-src-attr', 'style-src', 'default-src']]) {
		const tokens = chain.map(n => directives.get(n)).find(t => t !== undefined);
		if (tokens === undefined || !tokens.includes(`'unsafe-inline'`)) {
			failures.push(`${chain[0]} does not admit the host's inline styles (${tokens === undefined ? 'not declared' : tokens.join(' ')})`);
		} else if (tokens.some(t => /^'(nonce|sha256|sha384|sha512)-/.test(t))) {
			failures.push(`${chain[0]} carries a nonce or hash, which disables 'unsafe-inline' (${tokens.join(' ')})`);
		}
	}
	return failures;
}

/** Replaces the webview cspSource and nonce interpolations; any other interpolation is an error, not a guess. */
export function resolveInterpolations(template: string, where: string): string {
	return template.replace(/\$\{([^}]*)\}/g, (_match, expression: string) => {
		const e = expression.trim();
		if (CSP_SOURCE_EXPRESSIONS.has(e)) {
			return CSP_SOURCE;
		}
		if (NONCE_EXPRESSIONS.has(e)) {
			return NONCE;
		}
		throw new Error(`${where}: the policy interpolates \${${e}}, which this check cannot resolve`);
	});
}

/** Every Content-Security-Policy of one source file, resolved; a meta whose content is `${csp}` takes the file's one `const csp`. */
export function policiesOf(source: string, where: string): string[] {
	const metas = [...source.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)].map(m => m[1]);
	const out: string[] = [];
	for (const content of metas) {
		if (content.trim() !== '${csp}') {
			out.push(resolveInterpolations(content, where));
			continue;
		}
		const definitions = [...source.matchAll(/\bconst csp = (\[[\s\S]*?\]\.join\('; '\)|`[^`]*`);/g)].map(m => m[1]);
		if (definitions.length !== 1) {
			throw new Error(`${where}: the meta takes \${csp}, and the file has ${definitions.length} \`const csp\` definitions (expected 1)`);
		}
		const definition = definitions[0];
		const parts = definition.startsWith('[') ? [...definition.matchAll(/`([^`]*)`/g)].map(m => m[1]) : [definition.slice(1, -1)];
		out.push(resolveInterpolations(parts.join('; '), where));
	}
	return out;
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (p !== path.join(SRC, 'test')) {
				out.push(...sourceFiles(p));
			}
		} else if (entry.name.endsWith('.ts')) {
			out.push(p);
		}
	}
	return out;
}

function codeLines(source: string): string {
	return source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

suite('webview CSP (B5)', () => {
	test('the judgement: a B5 policy passes; each departure fails by name', () => {
		const good = `default-src 'none'; img-src ${CSP_SOURCE} data:; style-src ${CSP_SOURCE} 'unsafe-inline'; script-src 'nonce-${NONCE}';`;
		assert.deepStrictEqual(judgePolicy(good), []);
		const cases: [string, string][] = [
			[`default-src 'none'; script-src ${CSP_SOURCE} 'nonce-${NONCE}'`, 'script-src is not nonce-only'],
			[`default-src 'none'; script-src 'unsafe-inline' 'nonce-${NONCE}'`, 'script-src is not nonce-only'],
			[`default-src 'none'; script-src 'nonce-${NONCE}'; script-src-elem https://cdn.example`, 'script-src-elem is not nonce-only'],
			[`default-src 'none'; script-src 'nonce-${NONCE}' 'unsafe-eval'`, `script-src carries 'unsafe-eval'`],
			[`default-src 'none'; script-src 'nonce-${NONCE}'; connect-src *`, 'connect-src allows a source other than the webview cspSource'],
			[`script-src 'nonce-${NONCE}'`, `default-src is not 'none'`],
		];
		for (const [policy, reason] of cases) {
			const failures = judgePolicy(policy);
			assert.ok(failures.some(f => f.startsWith(reason)), `${policy} -> ${JSON.stringify(failures)} (expected "${reason}")`);
		}
	});

	test('the host-styles judgement: inline styles admitted passes; absent, or disabled by a nonce or hash, fails by name', () => {
		assert.deepStrictEqual(judgeHostStyles(`default-src 'none'; style-src ${CSP_SOURCE} 'unsafe-inline'; script-src 'nonce-${NONCE}'`), []);
		const cases: [string, string][] = [
			[`default-src 'none'; style-src ${CSP_SOURCE}; script-src 'nonce-${NONCE}'`, `style-src does not admit the host's inline styles`],
			[`default-src 'none'; style-src ${CSP_SOURCE} 'unsafe-inline' 'nonce-${NONCE}'`, 'style-src carries a nonce or hash'],
			[`default-src 'none'; style-src 'unsafe-inline'; style-src-attr 'none'`, `style-src-attr does not admit the host's inline styles`],
		];
		for (const [policy, reason] of cases) {
			const failures = judgeHostStyles(policy);
			assert.ok(failures.some(f => f.startsWith(reason)), `${policy} -> ${JSON.stringify(failures)} (expected "${reason}")`);
		}
	});

	test('every source file that assigns a webview html is listed, and every listed file carries a policy', () => {
		const assigning = sourceFiles(SRC)
			.filter(p => /\bwebview\.html\s*=/.test(codeLines(fs.readFileSync(p, 'utf8'))))
			.map(p => path.relative(SRC, p).split(path.sep).join('/'))
			.sort();
		assert.deepStrictEqual(assigning, [...WEBVIEW_HTML_FILES].sort());
		const withPolicy = sourceFiles(SRC)
			.filter(p => fs.readFileSync(p, 'utf8').includes('Content-Security-Policy'))
			.map(p => path.relative(SRC, p).split(path.sep).join('/'))
			.sort();
		assert.deepStrictEqual(withPolicy, [...WEBVIEW_HTML_FILES].sort());
	});

	for (const rel of WEBVIEW_HTML_FILES) {
		test(`${rel}: every policy meets B5`, () => {
			const policies = policiesOf(fs.readFileSync(path.join(SRC, rel), 'utf8'), rel);
			assert.ok(policies.length > 0, `${rel}: no Content-Security-Policy meta`);
			for (const policy of policies) {
				assert.deepStrictEqual(judgePolicy(policy), [], `${rel}: ${policy}`);
			}
		});
		test(`${rel}: every policy admits the webview host's inline styles`, () => {
			for (const policy of policiesOf(fs.readFileSync(path.join(SRC, rel), 'utf8'), rel)) {
				assert.deepStrictEqual(judgeHostStyles(policy), [], `${rel}: ${policy}`);
			}
		});
	}
});
