/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import * as ts from 'typescript';
import { installVscodeShim, Uri } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { ThemeProvider } from '../ui/tokens/ThemeProvider';
import { WelcomeModal } from '../ui/onboarding/WelcomeModal';
import { ChartWebview } from '../views/chart/ChartWebview';
import { ActionWebview } from '../views/action/ActionWebview';
import { QuantLabHome } from '../auth/QuantLabHome';
import { buildHtml as buildDashboardHtml } from '../panels/dashboard/DashboardWebviewPanel';
import { getNonce } from '../utils/webview';

// F-QL-WEBVIEW-NONCE-1: a B5 policy is only as strong as its nonce. Every webview nonce comes from getNonce() in
// utils/webview.ts, which encodes 16 bytes of crypto.randomBytes as base64url; none comes from Math.random. Provenance is
// checked on the value, not the text: every nonce a source file writes (`'nonce-${x}'`, `nonce="${x}"`) must resolve,
// through consts and parameters (every call site), to a direct call of that getNonce; any other expression, and any nonce written as literal text, fails.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(EXTENSION_ROOT, 'src');
const HELPER = path.join(SRC, 'utils', 'webview.ts');

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

/** A program over the extension's src/ files, read through this module's `fs` (so a harness can substitute contents). */
function sourceProgram(): ts.Program {
	const config = ts.getParsedCommandLineOfConfigFile(path.join(EXTENSION_ROOT, 'tsconfig.json'), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: d => { throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`); },
	});
	if (config === undefined || config.errors.length > 0) {
		throw new Error(`tsconfig.json does not parse: ${config?.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
	}
	const host = ts.createCompilerHost(config.options, true);
	host.getSourceFile = (fileName, languageVersion) => fs.existsSync(fileName)
		? ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), languageVersion, true)
		: undefined;
	const roots = config.fileNames.filter(f => path.resolve(f).startsWith(SRC + path.sep) || f.endsWith('/vscode.d.ts'));
	return ts.createProgram(roots, config.options, host);
}

const NONCE_SLOT = /'nonce-$|\bnonce="$/;
const NONCE_TEXT = /'nonce-|\bnonce="/;

/** Every nonce each source file writes, with the named failures of those whose value is not a direct getNonce() call. */
function nonceProvenance(program: ts.Program): { bindings: Map<string, number>; failures: string[] } {
	const checker = program.getTypeChecker();
	const testRoot = path.join(SRC, 'test') + path.sep;
	const files = program.getSourceFiles().filter(f => {
		const p = path.resolve(f.fileName);
		return !f.isDeclarationFile && p.startsWith(SRC + path.sep) && !p.startsWith(testRoot);
	});
	const helperFile = files.find(f => path.resolve(f.fileName) === HELPER);
	const helper = helperFile?.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'getNonce');
	const bindings = new Map<string, number>();
	const failures: string[] = [];
	if (helper === undefined) {
		return { bindings, failures: ['utils/webview.ts declares no function getNonce'] };
	}
	const where = (node: ts.Node) => {
		const file = node.getSourceFile();
		const rel = path.relative(SRC, path.resolve(file.fileName)).split(path.sep).join('/');
		return `${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
	};
	const declarationOf = (node: ts.Node) => {
		const symbol = checker.getSymbolAtLocation(node);
		return (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration;
	};
	const fromHelper = (expression: ts.Expression, depth: number): string | undefined => {
		let e = expression;
		while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
			e = e.expression;
		}
		if (depth > 8) {
			return `${where(e)}: the nonce is not resolved within 8 steps`;
		}
		if (ts.isCallExpression(e)) {
			return e.arguments.length === 0 && declarationOf(ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression) === helper
				? undefined
				: `${where(e)}: the nonce is \`${e.getText()}\`, not a direct call of getNonce() from utils/webview`;
		}
		if (ts.isIdentifier(e)) {
			const declaration = declarationOf(e);
			if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
				&& (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
				return fromHelper(declaration.initializer, depth + 1);
			}
			if (declaration !== undefined && ts.isParameter(declaration)) {
				return fromCallers(declaration, depth);
			}
			return `${where(e)}: the nonce \`${e.text}\` is neither a const with an initializer nor a parameter`;
		}
		return `${where(e)}: the nonce is a ${ts.SyntaxKind[e.kind]} (\`${e.getText()}\`), not a direct call of getNonce() from utils/webview`;
	};
	// A parameter's nonce is the argument at every call site; a function referenced other than by a direct call fails.
	const fromCallers = (parameter: ts.ParameterDeclaration, depth: number): string | undefined => {
		const fn = parameter.parent;
		const index = fn.parameters.indexOf(parameter);
		if (!ts.isFunctionDeclaration(fn) || fn.name === undefined || parameter.dotDotDotToken !== undefined) {
			return `${where(parameter)}: the nonce is a parameter of a function this check cannot find the callers of`;
		}
		const references: ts.Identifier[] = [];
		const collect = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && node !== fn.name && declarationOf(node) === fn) {
				references.push(node);
			}
			ts.forEachChild(node, collect);
		};
		files.forEach(collect);
		if (references.length === 0) {
			return `${where(parameter)}: ${fn.name.text} has no call site in the source`;
		}
		for (const reference of references) {
			const call = reference.parent;
			if (!ts.isCallExpression(call) || call.expression !== reference || call.arguments.length <= index
				|| call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) {
				return `${where(reference)}: ${fn.name.text} is referenced other than by a direct call passing the nonce`;
			}
			const failure = fromHelper(call.arguments[index], depth + 1);
			if (failure !== undefined) {
				return failure;
			}
		}
		return undefined;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isTemplateExpression(node)) {
			const texts = [node.head, ...node.templateSpans.map(s => s.literal)];
			node.templateSpans.forEach((span, i) => {
				if (NONCE_SLOT.test(texts[i].text)) {
					const rel = where(span).split(':')[0];
					bindings.set(rel, (bindings.get(rel) ?? 0) + 1);
					const failure = fromHelper(span.expression, 0);
					if (failure !== undefined) {
						failures.push(failure);
					}
				}
			});
			texts.forEach((t, i) => {
				const body = i < node.templateSpans.length ? t.text.replace(NONCE_SLOT, '') : t.text;
				if (NONCE_TEXT.test(body)) {
					failures.push(`${where(t)}: a nonce is written as literal text`);
				}
			});
		} else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && NONCE_TEXT.test(node.text)) {
			failures.push(`${where(node)}: a nonce is written as literal text`);
		}
		ts.forEachChild(node, visit);
	};
	files.forEach(visit);
	return { bindings, failures };
}

// The builders that write a webview's html (the CSP-1 inventory); each writes its nonce into the policy and at least one element.
const NONCE_BUILDERS = [
	'auth/QuantLabHome.ts', 'panels/dashboard/DashboardWebviewPanel.ts', 'panels/resources/ResourcesWebviewProvider.ts',
	'quantbook/bench/renderBenchPanel.ts', 'quantbook/cellGrid/cellGridPanel.ts', 'quantbook/shell/SqlQueryViewProvider.ts',
	'ui/onboarding/WelcomeModal.ts', 'views/action/ActionWebview.ts', 'views/chart/ChartWebview.ts', 'views/stats/StatsViewProvider.ts',
	'views/visualise/VisualiseDataProvider.ts', 'views/visualise/VisualiseSpecProvider.ts',
];

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

	test('the helper encodes exactly the 16 bytes it draws from crypto.randomBytes, as base64url', () => {
		const target = crypto as unknown as { randomBytes: (size: number) => Buffer };
		const randomBytes = target.randomBytes;
		const drawn = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 62, 63, 128, 64, 32, 16]);
		const sizes: number[] = [];
		target.randomBytes = (size: number) => { sizes.push(size); return drawn; };
		let nonce: string;
		try {
			nonce = getNonce();
		} finally {
			target.randomBytes = randomBytes;
		}
		assert.deepStrictEqual(sizes, [16], 'getNonce must draw once, 16 bytes');
		assert.strictEqual(nonce, drawn.toString('base64url'));
	});

	test('every nonce a source file writes is a direct getNonce() call from utils/webview; a nonce in literal text fails', () => {
		const { bindings, failures } = nonceProvenance(sourceProgram());
		assert.deepStrictEqual(failures, []);
		const thin = NONCE_BUILDERS.filter(f => (bindings.get(f) ?? 0) < 2).map(f => `${f}: ${bindings.get(f) ?? 0} nonce bindings`);
		assert.deepStrictEqual(thin, [], 'each builder writes its nonce into the policy and at least one element');
	});
});
