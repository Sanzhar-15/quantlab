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
	}
});
