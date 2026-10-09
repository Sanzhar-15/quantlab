/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim, Uri } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { ThemeProvider } from '../ui/tokens/ThemeProvider';
import { WelcomeModal } from '../ui/onboarding/WelcomeModal';
import { ChartWebview } from '../views/chart/ChartWebview';
import { ActionWebview } from '../views/action/ActionWebview';
import { QuantLabHome } from '../auth/QuantLabHome';
import { buildHtml as buildDashboardHtml } from '../panels/dashboard/DashboardWebviewPanel';

// F-QL-WEBVIEW-NONCE-1: a B5 policy is only as strong as its nonce. Every webview nonce comes from getNonce() in
// utils/webview.ts (crypto.randomBytes); none comes from Math.random.

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

const webview = {
	cspSource: 'https://webview.example',
	asWebviewUri: (uri: vscode.Uri) => uri,
} as unknown as vscode.Webview;
const extensionUri = Uri.file('/extension') as unknown as vscode.Uri;

// The five builders that generated their own nonce with Math.random before this fold, each rendered with its dependencies stubbed.
const BUILDERS: [string, () => string][] = [
	['WelcomeModal', () => (WelcomeModal as unknown as { buildHtml(w: vscode.Webview, u: vscode.Uri): string }).buildHtml(webview, extensionUri)],
	['ChartWebview', () => ChartWebview.buildHtml(webview, extensionUri)],
	['ActionWebview', () => ActionWebview.buildHtml(webview, extensionUri)],
	['QuantLabHome', () => (QuantLabHome as unknown as {
		_buildHtml(w: vscode.Webview, t: vscode.Uri, s: vscode.Uri, theme: string, user: { name: string; email: string }): string;
	})._buildHtml(webview, extensionUri, extensionUri, '', { name: 'Ada Lovelace', email: 'ada@example.com' })],
	['DashboardWebviewPanel', () => buildDashboardHtml(webview.cspSource, extensionUri, '', 'Dashboard', '<p>body</p>')],
];

/** Renders with Math.random throwing and the theme stubbed; both restored afterwards. */
function renderWithoutMathRandom(build: () => string): string {
	const random = Math.random;
	const theme = ThemeProvider as unknown as { instance: unknown };
	const instance = theme.instance;
	Math.random = () => { throw new Error('Math.random called while rendering a webview'); };
	theme.instance = { getInlineStyles: () => '<style>/* theme */</style>' };
	try {
		return build();
	} finally {
		Math.random = random;
		theme.instance = instance;
	}
}

/** The policy's nonce and every nonce attribute of the document. */
function noncesOf(html: string): { policy: string[]; attributes: string[] } {
	const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
	assert.ok(meta !== null, 'no Content-Security-Policy meta');
	return {
		policy: [...meta[1].matchAll(/'nonce-([^']*)'/g)].map(m => m[1]),
		attributes: [...html.matchAll(/\snonce="([^"]*)"/g)].map(m => m[1]),
	};
}

function codeLines(source: string): string {
	return source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
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

suite('webview nonces (CSPRNG only)', () => {
	for (const [name, build] of BUILDERS) {
		test(`${name}: renders with Math.random unavailable; one non-empty nonce, the policy's, on every nonce attribute`, () => {
			const { policy, attributes } = noncesOf(renderWithoutMathRandom(build));
			assert.strictEqual(policy.length, 1, `${name}: the policy carries ${policy.length} nonces`);
			assert.ok(policy[0] !== '', `${name}: the policy nonce is empty`);
			assert.ok(attributes.length > 0, `${name}: no element carries a nonce`);
			assert.deepStrictEqual(attributes.filter(a => a !== policy[0]), [], `${name}: a nonce attribute differs from the policy's`);
		});
		test(`${name}: two renders carry different nonces`, () => {
			assert.notStrictEqual(noncesOf(renderWithoutMathRandom(build)).policy[0], noncesOf(renderWithoutMathRandom(build)).policy[0]);
		});
	}

	test('the helper draws from crypto.randomBytes and never Math.random', () => {
		const helper = /export function getNonce\(\): string \{([\s\S]*?)\n\}/.exec(fs.readFileSync(path.join(SRC, 'utils', 'webview.ts'), 'utf8'));
		assert.ok(helper !== null, 'utils/webview.ts: no `export function getNonce(): string`');
		assert.ok(/crypto\.randomBytes\(/.test(helper[1]), `getNonce does not call crypto.randomBytes:${helper[1]}`);
		assert.ok(!/Math\.random/.test(helper[1]), `getNonce calls Math.random:${helper[1]}`);
	});

	test('every source file that builds a nonce policy takes its nonce from utils/webview and never calls Math.random', () => {
		const builders = sourceFiles(SRC).filter(p => /'nonce-\$\{/.test(fs.readFileSync(p, 'utf8')));
		assert.ok(builders.length >= 12, `only ${builders.length} files build a nonce policy (the survey counts 12)`);
		const failures: string[] = [];
		for (const p of builders) {
			const rel = path.relative(SRC, p).split(path.sep).join('/');
			const code = codeLines(fs.readFileSync(p, 'utf8'));
			if (/Math\.random/.test(code)) {
				failures.push(`${rel}: calls Math.random`);
			}
			if (!/import \{[^}]*\bgetNonce\b[^}]*\} from '(\.\.\/)+utils\/webview'/.test(code)) {
				failures.push(`${rel}: does not import getNonce from utils/webview`);
			}
		}
		assert.deepStrictEqual(failures, []);
	});
});
