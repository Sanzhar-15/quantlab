/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// F-QL-WEBVIEW-CSP-1: every QuantLab webview ships the B5 policy (hub folds/HOST/DRIVER1-HOST-ANSWERS.md, "B5 mechanism"):
// default-src 'none'; scripts by nonce only (no 'unsafe-inline', no host source, the effective script-src-elem and
// script-src-attr included); no 'unsafe-eval' in any directive; connect-src the webview's cspSource only. A webview with no
// policy fails. No vscode runtime: the TypeScript checker reads the source. Every write to a property named `html` is a site,
// whatever the object is called, and so is a computed write whose key may be `html` into a receiver that may be a webview; the
// value each site assigns is traced (consts, calls, parameters through every call site, structural and untyped ones included)
// to the HTML literal it is. That document's policy meta must be active (only the doctype, <html>, <head> and plain metas
// before it), and each interpolation in the policy is judged by its binding: a Webview's cspSource or a generated nonce.
// Anything the trace cannot account for is a named failure.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(EXTENSION_ROOT, 'src');

// Every source file that writes a webview's html, with its number of writes, as of the fold. A new site fails until listed.
const WEBVIEW_HTML_ASSIGNMENTS: Record<string, number> = {
	'auth/QuantLabHome.ts': 1,
	'panels/dashboard/DashboardWebviewPanel.ts': 3,
	'panels/resources/ResourcesWebviewProvider.ts': 1,
	'quantbook/bench/renderBenchPanel.ts': 1,
	'quantbook/cellGrid/cellGridPanel.ts': 1,
	'quantbook/shell/SqlQueryViewProvider.ts': 1,
	'ui/onboarding/WelcomeModal.ts': 1,
	'views/action/ActionWebview.ts': 1,
	'views/chart/ChartWebview.ts': 1,
	'views/stats/StatsViewProvider.ts': 1,
	'views/visualise/VisualiseDataProvider.ts': 1,
	'views/visualise/VisualiseSpecProvider.ts': 1,
};

const CSP_SOURCE = 'CSP-SOURCE';
const NONCE = 'NONCE';
const MAX_TRACE_DEPTH = 12;

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

/** One write to an `html` property: where it is, the policies of the documents it assigns, and what could not be accounted for. */
export interface HtmlSite {
	readonly file: string;
	readonly where: string;
	readonly policies: string[];
	readonly failures: string[];
}

/** Every `html` write in the source files under `srcRoot` (its `test` directory excluded), each traced and judged for accounting. */
export class WebviewHtmlAnalysis {
	readonly sites: HtmlSite[] = [];
	private readonly checker: ts.TypeChecker;
	private readonly files: ts.SourceFile[];
	private references: Map<ts.Symbol, ts.Node[]> | undefined;
	private untypedMembers: Map<string, ts.Node[]> | undefined;

	constructor(program: ts.Program, private readonly srcRoot: string) {
		this.checker = program.getTypeChecker();
		const testRoot = path.join(srcRoot, 'test') + path.sep;
		this.files = program.getSourceFiles().filter(f => {
			const p = path.resolve(f.fileName);
			return !f.isDeclarationFile && p.startsWith(srcRoot + path.sep) && !p.startsWith(testRoot);
		});
		for (const file of this.files) {
			this.collect(file);
		}
	}

	private relative(node: ts.Node): string {
		return path.relative(this.srcRoot, path.resolve(node.getSourceFile().fileName)).split(path.sep).join('/');
	}

	private where(node: ts.Node): string {
		const file = node.getSourceFile();
		return `${this.relative(node)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
	}

	private collect(node: ts.Node): void {
		if (isHtmlTarget(node)) {
			this.htmlSite(node, assignmentTarget(node));
		} else if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(skipOuter(node.argumentExpression))) {
			const target = assignmentTarget(node);
			if (target?.kind !== 'read' && this.mayBeHtmlKey(node.argumentExpression) && this.mayHoldWebview(node.expression, 0)) {
				this.htmlSite(node, target);
			} else if (this.isWebview(node.expression)) {
				this.unaccounted(node, 'a Webview member is accessed by a computed key');
			}
		} else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && this.isWebview(node.expression) && !this.isWebview(node)) {
			this.unaccounted(node, 'a Webview is cast to another type');
		} else if (ts.isCallExpression(node) && isReflectiveWrite(node)
			&& node.arguments.some((a, i) => this.isWebview(a) || carriesHtmlKey(a) || (i === 0 && this.mayHoldWebview(a, 0)))) {
			this.unaccounted(node, 'a Webview, a receiver that may be one, or an `html` key, is passed to a reflective write');
		}
		ts.forEachChild(node, child => this.collect(child));
	}

	/** A write that may set a webview's html: a plain `=` is traced and its documents judged; any other write fails by name. */
	private htmlSite(node: ts.Expression, target: ReturnType<typeof assignmentTarget>): void {
		const failures: string[] = [];
		const policies: string[] = [];
		if (target === undefined) {
			failures.push(`${this.where(node)}: an html property is written other than by a plain \`=\` (${short(node.parent)})`);
		} else if (target.kind === 'assign') {
			const documents = new Set<ts.Node>();
			this.trace(target.value, 0, documents, failures);
			if (documents.size === 0 && failures.length === 0) {
				failures.push(`${this.where(node)}: the assigned value resolves to no HTML document`);
			}
			for (const document of documents) {
				policies.push(...this.policiesOfDocument(document, failures));
			}
		}
		if (target === undefined || target.kind === 'assign') {
			this.sites.push({ file: this.relative(node), where: this.where(node), policies, failures });
		}
	}

	/** A computed key whose type admits the string `html` (string, any, unknown, a template type, or a union with 'html'). */
	private mayBeHtmlKey(key: ts.Expression): boolean {
		const type = this.checker.getTypeAtLocation(key);
		return [type, ...(type.isUnion() ? type.types : [])].some(t =>
			(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) !== 0
			|| (t.isStringLiteral() && t.value === 'html'));
	}

	/**
	 * A receiver that may be a webview: a Webview, any or unknown, a type with an `html` property, or a cast or const alias of such
	 * a value. (A Webview is an interface, so it reaches an index-signature type only through a cast, which is followed here and
	 * reported by name in `collect`.)
	 */
	private mayHoldWebview(receiver: ts.Expression, depth: number): boolean {
		let e = receiver;
		while (ts.isParenthesizedExpression(e)) {
			e = e.expression;
		}
		if (this.isWebview(e)) {
			return true;
		}
		const type = this.checker.getTypeAtLocation(e);
		if ([type, ...(type.isUnionOrIntersection() ? type.types : [])].some(t => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
			|| this.checker.getPropertyOfType(this.checker.getApparentType(t), 'html') !== undefined)) {
			return true;
		}
		if (depth > MAX_TRACE_DEPTH) {
			return true;
		}
		if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
			return this.mayHoldWebview(e.expression, depth + 1);
		}
		const declaration = ts.isIdentifier(e) ? this.symbolOf(e)?.valueDeclaration : undefined;
		return declaration !== undefined && isConstWithInitializer(declaration) && this.mayHoldWebview(declaration.initializer, depth + 1);
	}

	private unaccounted(node: ts.Node, what: string): void {
		this.sites.push({ file: this.relative(node), where: this.where(node), policies: [], failures: [`${this.where(node)}: ${what} (${short(node)})`] });
	}

	private isWebview(expression: ts.Expression): boolean {
		const type = this.checker.getTypeAtLocation(expression);
		return [type, ...(type.isUnionOrIntersection() ? type.types : [])].some(t => t.getSymbol()?.declarations?.some(isVscodeWebviewInterface) === true);
	}

	/** The HTML documents an expression evaluates to, or a named failure for each path that cannot be accounted for. */
	private trace(expression: ts.Expression, depth: number, documents: Set<ts.Node>, failures: string[]): void {
		const e = skipOuter(expression);
		if (depth > MAX_TRACE_DEPTH) {
			failures.push(`${this.where(e)}: the assigned HTML is not resolved within ${MAX_TRACE_DEPTH} steps`);
		} else if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) {
			documents.add(e);
		} else if (ts.isConditionalExpression(e)) {
			this.trace(e.whenTrue, depth + 1, documents, failures);
			this.trace(e.whenFalse, depth + 1, documents, failures);
		} else if (ts.isIdentifier(e)) {
			const declaration = this.symbolOf(e)?.valueDeclaration;
			if (declaration !== undefined && isConstWithInitializer(declaration)) {
				this.trace(declaration.initializer, depth + 1, documents, failures);
			} else if (declaration !== undefined && ts.isParameter(declaration)) {
				for (const argument of this.argumentsFor(declaration, failures)) {
					this.trace(argument, depth + 1, documents, failures);
				}
			} else {
				failures.push(`${this.where(e)}: \`${e.text}\` is neither a const with an initializer nor a parameter, so the HTML it carries cannot be accounted for`);
			}
		} else if (ts.isCallExpression(e)) {
			const callee = this.checker.getResolvedSignature(e)?.declaration;
			if (callee === undefined || !isTraceableFunction(callee) || !this.inSource(callee)) {
				failures.push(`${this.where(e)}: the assigned HTML comes from a call whose body is not in the source (${short(e.expression)})`);
				return;
			}
			const results = ts.isBlock(callee.body) ? returnsOf(callee.body) : [callee.body];
			if (results.length === 0) {
				failures.push(`${this.where(callee)}: ${short(e.expression)} returns no value`);
			}
			for (const result of results) {
				if (result === undefined) {
					failures.push(`${this.where(callee)}: ${short(e.expression)} has a bare return`);
				} else {
					this.trace(result, depth + 1, documents, failures);
				}
			}
		} else {
			failures.push(`${this.where(e)}: the assigned HTML is a ${ts.SyntaxKind[e.kind]} (${short(e)}), which this check cannot account for`);
		}
	}

	/** The argument every call site passes for a parameter; a function referenced other than by a direct call is a failure. */
	private argumentsFor(parameter: ts.ParameterDeclaration, failures: string[]): ts.Expression[] {
		const fn = parameter.parent;
		const name = ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) ? fn.name
			: (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined;
		const index = fn.parameters.indexOf(parameter);
		if (name === undefined || parameter.dotDotDotToken !== undefined) {
			failures.push(`${this.where(parameter)}: the HTML is a parameter of a function this check cannot find the callers of`);
			return [];
		}
		if (ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent) && (fn.parent.heritageClauses?.length ?? 0) > 0) {
			failures.push(`${this.where(parameter)}: the HTML is a method parameter of a class with heritage clauses (callers through a base type are not traced)`);
			return [];
		}
		const symbol = this.checker.getSymbolAtLocation(name);
		const references = symbol === undefined ? [] : (this.referenceIndex().get(symbol) ?? []).filter(r => r !== name);
		if (references.length === 0) {
			failures.push(`${this.where(parameter)}: ${name.getText()} has no call site in the source`);
		}
		const out: ts.Expression[] = [];
		const take = (call: ts.CallExpression): void => {
			if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement) || call.arguments.length <= index) {
				failures.push(`${this.where(call)}: the call passes no plain argument for ${parameter.name.getText()}`);
			} else {
				out.push(call.arguments[index]);
			}
		};
		for (const reference of references) {
			const call = calleeCall(reference);
			if (call === undefined || this.checker.getResolvedSignature(call)?.declaration !== fn) {
				failures.push(`${this.where(reference)}: ${name.getText()} is referenced other than by a direct call (${short(reference.parent)})`);
			} else {
				take(call);
			}
		}
		// A method is also reachable through any structural type (an interface or type-literal member of the same name) and
		// through an untyped receiver: each such call's argument is traced, and any other reference to such a member fails.
		if (ts.isMethodDeclaration(fn) && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) {
			const member = fn.name.text;
			for (const [other, otherReferences] of this.referenceIndex()) {
				if (other === symbol || other.name !== member || !other.declarations?.some(d => ts.isMethodSignature(d) || ts.isPropertySignature(d))) {
					continue;
				}
				for (const reference of otherReferences) {
					if ((ts.isMethodSignature(reference.parent) || ts.isPropertySignature(reference.parent)) && reference.parent.name === reference) {
						continue;
					}
					const call = calleeCall(reference);
					if (call === undefined) {
						failures.push(`${this.where(reference)}: ${member} is reached through a structural type other than by a direct call (${short(reference.parent)})`);
					} else {
						take(call);
					}
				}
			}
			for (const reference of this.untypedMemberIndex().get(member) ?? []) {
				const call = calleeCall(reference);
				if (call === undefined) {
					failures.push(`${this.where(reference)}: ${member} is reached through an untyped receiver other than by a direct call (${short(reference.parent)})`);
				} else {
					take(call);
				}
			}
		}
		return out;
	}

	/** Member names accessed on a receiver the checker cannot type (`x.name` with no symbol, as through `any`). */
	private untypedMemberIndex(): Map<string, ts.Node[]> {
		if (this.untypedMembers === undefined) {
			const index = new Map<string, ts.Node[]>();
			const visit = (node: ts.Node): void => {
				if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && this.symbolOf(node) === undefined) {
					index.set(node.text, [...(index.get(node.text) ?? []), node]);
				}
				ts.forEachChild(node, visit);
			};
			this.files.forEach(visit);
			this.untypedMembers = index;
		}
		return this.untypedMembers;
	}

	private referenceIndex(): Map<ts.Symbol, ts.Node[]> {
		if (this.references === undefined) {
			const index = new Map<ts.Symbol, ts.Node[]>();
			const visit = (node: ts.Node): void => {
				if (ts.isIdentifier(node) || (ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) {
					const symbol = this.symbolOf(node);
					if (symbol !== undefined) {
						index.set(symbol, [...(index.get(symbol) ?? []), node]);
					}
				}
				ts.forEachChild(node, visit);
			};
			this.files.forEach(visit);
			this.references = index;
		}
		return this.references;
	}

	private symbolOf(node: ts.Node): ts.Symbol | undefined {
		const symbol = this.checker.getSymbolAtLocation(node);
		return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(symbol) : symbol;
	}

	private inSource(node: ts.Node): boolean {
		return this.files.includes(node.getSourceFile());
	}

	/**
	 * The policies of one HTML document. Its first Content-Security-Policy meta must be active and first: before it the document
	 * may hold only the doctype, <html>, <head> and plain charset or name/content metas (no comment, other element
	 * or interpolation).
	 */
	private policiesOfDocument(document: ts.Node, failures: string[]): string[] {
		const { text, spans } = templateParts(document);
		const metas = [...text.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
		if (metas.length === 0) {
			failures.push(`${this.where(document)}: the assigned HTML has no Content-Security-Policy meta`);
			return [];
		}
		const before = text.slice(0, metas[0].index);
		if (!ACTIVE_META_PREFIX.test(before)) {
			failures.push(`${this.where(document)}: the Content-Security-Policy meta is not active: only the doctype, <html>, <head> and plain charset or name/content metas may precede it (${JSON.stringify(before.slice(-60))})`);
		}
		const policies: string[] = [];
		for (const meta of metas) {
			const single = /^\u0000(\d+)\u0000$/.exec(meta[1].trim());
			const policy = single !== null
				? this.policyOfExpression(spans[Number(single[1])], 0, failures)
				: this.resolveInterpolations(meta[1], spans, this.where(document), failures);
			if (policy !== undefined) {
				policies.push(policy);
			}
		}
		return policies;
	}

	/** A policy given as an expression: a const, a literal, or `[literal, ...].join('<separator>')`; any other form is a named error. */
	private policyOfExpression(expression: ts.Expression, depth: number, failures: string[]): string | undefined {
		const e = skipOuter(expression);
		if (depth > MAX_TRACE_DEPTH) {
			failures.push(`${this.where(e)}: the policy is not resolved within ${MAX_TRACE_DEPTH} steps`);
			return undefined;
		}
		if (ts.isIdentifier(e)) {
			const declaration = this.symbolOf(e)?.valueDeclaration;
			if (declaration !== undefined && isConstWithInitializer(declaration)) {
				return this.policyOfExpression(declaration.initializer, depth + 1, failures);
			}
			failures.push(`${this.where(e)}: the policy \`${e.text}\` is not a const with an initializer`);
			return undefined;
		}
		if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) {
			const { text, spans } = templateParts(e);
			return this.resolveInterpolations(text, spans, this.where(e), failures);
		}
		const join = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'join' ? e.expression : undefined;
		const array = join !== undefined ? skipOuter(join.expression) : undefined;
		if (join !== undefined && array !== undefined && ts.isArrayLiteralExpression(array) && ts.isCallExpression(e)
			&& e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0])) {
			const parts: string[] = [];
			let complete = true;
			for (const element of array.elements) {
				if (ts.isStringLiteralLike(element) || ts.isTemplateExpression(element)) {
					const { text, spans } = templateParts(element);
					const part = this.resolveInterpolations(text, spans, this.where(element), failures);
					complete = complete && part !== undefined;
					parts.push(part ?? '');
				} else {
					failures.push(`${this.where(element)}: unsupported CSP array element, a ${ts.SyntaxKind[element.kind]} (${short(element)}); every element must be a string or template literal`);
					complete = false;
				}
			}
			return complete ? parts.join(e.arguments[0].text) : undefined;
		}
		failures.push(`${this.where(e)}: unsupported CSP expression, a ${ts.SyntaxKind[e.kind]} (${short(e)})`);
		return undefined;
	}

	/** Replaces each interpolation by what its binding is (a Webview's cspSource, a generated nonce); anything else fails by name. */
	private resolveInterpolations(text: string, spans: ts.Expression[], where: string, failures: string[]): string | undefined {
		let complete = true;
		const resolved = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
			const span = spans[Number(index)];
			const terminals: ts.Expression[] = [];
			const problems: string[] = [];
			this.terminals(span, 0, terminals, problems);
			if (problems.length === 0 && terminals.length > 0 && terminals.every(t => this.isWebviewCspSource(t))) {
				return CSP_SOURCE;
			}
			if (problems.length === 0 && terminals.length > 0 && terminals.every(t => this.isGeneratedNonce(t))) {
				return NONCE;
			}
			const why = problems.length > 0 ? problems.join('; ') : `its value is neither a Webview's cspSource nor a generated nonce: ${terminals.map(short).join(', ')}`;
			failures.push(`${where}: the policy interpolates \${${span.getText().trim()}}, which this check cannot resolve (${why})`);
			complete = false;
			return '';
		});
		return complete ? resolved : undefined;
	}

	/** The expressions a value comes from: through consts, and through parameters at every call site. */
	private terminals(expression: ts.Expression, depth: number, out: ts.Expression[], problems: string[]): void {
		const e = skipOuter(expression);
		if (depth > MAX_TRACE_DEPTH) {
			problems.push(`not resolved within ${MAX_TRACE_DEPTH} steps`);
		} else if (ts.isIdentifier(e)) {
			const declaration = this.symbolOf(e)?.valueDeclaration;
			if (declaration !== undefined && isConstWithInitializer(declaration)) {
				this.terminals(declaration.initializer, depth + 1, out, problems);
			} else if (declaration !== undefined && ts.isParameter(declaration)) {
				for (const argument of this.argumentsFor(declaration, problems)) {
					this.terminals(argument, depth + 1, out, problems);
				}
			} else {
				problems.push(`\`${e.text}\` is neither a const with an initializer nor a parameter`);
			}
		} else {
			out.push(e);
		}
	}

	/** `<x>.cspSource` where the member is vscode's Webview.cspSource. */
	private isWebviewCspSource(e: ts.Expression): boolean {
		return ts.isPropertyAccessExpression(e) && this.symbolOf(e.name)?.declarations?.some(d =>
			ts.isPropertySignature(d) && d.name.getText() === 'cspSource' && isVscodeWebviewInterface(d.parent as ts.Declaration)) === true;
	}

	/** A call, with no arguments, of an in-source function with no parameters whose returns are all computed (no string literal). */
	private isGeneratedNonce(e: ts.Expression): boolean {
		if (!ts.isCallExpression(e) || e.arguments.length !== 0) {
			return false;
		}
		const callee = this.checker.getResolvedSignature(e)?.declaration;
		if (callee === undefined || !isTraceableFunction(callee) || !this.inSource(callee) || callee.parameters.length !== 0) {
			return false;
		}
		const results = ts.isBlock(callee.body) ? returnsOf(callee.body) : [callee.body];
		return results.length > 0 && results.every(r => r !== undefined && !ts.isStringLiteralLike(skipOuter(r)) && !ts.isTemplateExpression(skipOuter(r)));
	}
}

// Before an active policy meta: the doctype, <html>, <head>, and plain charset or name/content metas (literal attribute values),
// nothing else: no comment, no other element, no interpolation.
const ACTIVE_META_PREFIX = /^\s*(<!DOCTYPE html>\s*)?<html(\s+lang="[A-Za-z-]+")?\s*>\s*<head>\s*(<meta\s+(charset="[A-Za-z0-9-]+"|name="[A-Za-z-]+"\s+content="[^"<>\u0000]*")\s*\/?>\s*)*$/i;

/** A literal's text with each interpolation replaced by the placeholder \u0000<index>\u0000; the interpolated expressions. */
function templateParts(node: ts.Node): { text: string; spans: ts.Expression[] } {
	if (ts.isTemplateExpression(node)) {
		return {
			text: node.head.text + node.templateSpans.map((s, i) => `\u0000${i}\u0000${s.literal.text}`).join(''),
			spans: node.templateSpans.map(s => s.expression),
		};
	}
	if (ts.isStringLiteralLike(node)) {
		return { text: node.text, spans: [] };
	}
	throw new Error(`templateParts: a ${ts.SyntaxKind[node.kind]} is not a literal`);
}

function skipOuter(expression: ts.Expression): ts.Expression {
	let e = expression;
	while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
		e = e.expression;
	}
	return e;
}

function short(node: ts.Node): string {
	const text = node.getText().replace(/\s+/g, ' ');
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** A property named `html` read or written: `x.html`, `x['html']`. */
function isHtmlTarget(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
	return (ts.isPropertyAccessExpression(node) && node.name.text === 'html')
		|| (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(skipOuter(node.argumentExpression)) && (skipOuter(node.argumentExpression) as ts.StringLiteralLike).text === 'html');
}

/** `assign` for the left side of a plain `=`, `read` for a read, undefined for any other write (compound, ++, destructuring, for-of). */
function assignmentTarget(node: ts.Expression): { kind: 'assign'; value: ts.Expression } | { kind: 'read' } | undefined {
	let child: ts.Node = node;
	let parent = node.parent;
	while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) {
		child = parent;
		parent = parent.parent;
	}
	if (ts.isBinaryExpression(parent) && parent.left === child) {
		const operator = parent.operatorToken.kind;
		if (operator === ts.SyntaxKind.EqualsToken) {
			return { kind: 'assign', value: parent.right };
		}
		return operator >= ts.SyntaxKind.FirstCompoundAssignment && operator <= ts.SyntaxKind.LastCompoundAssignment ? undefined : { kind: 'read' };
	}
	if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
		&& (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
		return undefined;
	}
	if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) {
		return undefined;
	}
	if (ts.isArrayLiteralExpression(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)
		|| ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
		let pattern: ts.Node = parent;
		while (ts.isArrayLiteralExpression(pattern.parent) || ts.isObjectLiteralExpression(pattern.parent) || ts.isPropertyAssignment(pattern.parent)
			|| ts.isSpreadElement(pattern.parent) || ts.isSpreadAssignment(pattern.parent)) {
			pattern = pattern.parent;
		}
		const holder = pattern.parent;
		if ((ts.isBinaryExpression(holder) && holder.left === pattern && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken)
			|| (ts.isForOfStatement(holder) && holder.initializer === pattern)) {
			return undefined;
		}
	}
	return { kind: 'read' };
}

function isReflectiveWrite(call: ts.CallExpression): boolean {
	return ['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set', 'Reflect.defineProperty'].includes(call.expression.getText());
}

function carriesHtmlKey(argument: ts.Expression): boolean {
	const a = skipOuter(argument);
	return (ts.isStringLiteralLike(a) && a.text === 'html')
		|| (ts.isObjectLiteralExpression(a) && a.properties.some(p => !ts.isSpreadAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === 'html'));
}

function isConstWithInitializer(declaration: ts.Declaration): declaration is ts.VariableDeclaration & { initializer: ts.Expression } {
	return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
		&& (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

function isTraceableFunction(declaration: ts.Declaration): declaration is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
	return (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
		&& declaration.body !== undefined && declaration.asteriskToken === undefined
		&& !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async);
}

/** The expressions a function body returns (nested functions excluded); undefined for a bare `return`. */
function returnsOf(body: ts.Block): (ts.Expression | undefined)[] {
	const out: (ts.Expression | undefined)[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isReturnStatement(node)) {
			out.push(node.expression);
		} else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) {
			ts.forEachChild(node, visit);
		}
	};
	ts.forEachChild(body, visit);
	return out;
}

/** The call whose callee is this reference (`f(...)`, `x.f(...)`, `x['f'](...)`), or undefined. */
function calleeCall(reference: ts.Node): ts.CallExpression | undefined {
	const parent = reference.parent;
	if (ts.isCallExpression(parent) && parent.expression === reference) {
		return parent;
	}
	if ((ts.isPropertyAccessExpression(parent) && parent.name === reference) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === reference)) {
		return ts.isCallExpression(parent.parent) && parent.parent.expression === parent ? parent.parent : undefined;
	}
	return undefined;
}

function isVscodeWebviewInterface(declaration: ts.Declaration): boolean {
	if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== 'Webview') {
		return false;
	}
	for (let n: ts.Node = declaration.parent; n !== undefined; n = n.parent) {
		if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name) && n.name.text === 'vscode') {
			return true;
		}
	}
	return false;
}

/** A program whose source files are read through this module's `fs` (so a harness can substitute file contents). */
function programOf(rootNames: string[], options: ts.CompilerOptions): ts.Program {
	const host = ts.createCompilerHost(options, true);
	host.getSourceFile = (fileName, languageVersion) => fs.existsSync(fileName)
		? ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), languageVersion, true)
		: undefined;
	return ts.createProgram(rootNames, options, host);
}

let extensionAnalysis: WebviewHtmlAnalysis | undefined;
/** The extension's own analysis: its tsconfig's options, the source files under src/ and the vscode API declaration. */
function analyseExtension(): WebviewHtmlAnalysis {
	if (extensionAnalysis === undefined) {
		const config = ts.getParsedCommandLineOfConfigFile(path.join(EXTENSION_ROOT, 'tsconfig.json'), {}, {
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: d => { throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`); },
		});
		if (config === undefined || config.errors.length > 0) {
			throw new Error(`tsconfig.json does not parse: ${config?.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
		}
		const roots = config.fileNames.filter(f => path.resolve(f).startsWith(SRC + path.sep) || f.endsWith('/vscode.d.ts'));
		extensionAnalysis = new WebviewHtmlAnalysis(programOf(roots, config.options), SRC);
	}
	return extensionAnalysis;
}

// In-memory fixtures for the analysis: a minimal vscode declaration and global types, under a virtual /fixture/src.
const FIXTURE_ROOT = '/fixture/src';
const FIXTURE_DECLARATIONS = `
interface Array<T> { join(separator: string): string; }
interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {} interface IArguments {}
interface Number {} interface Object {} interface RegExp {} interface String {}
declare var Object: { assign(target: unknown, ...sources: unknown[]): unknown };
declare module 'vscode' {
	export interface Webview { html: string; readonly cspSource: string; }
	export interface WebviewPanel { readonly webview: Webview; }
}`;

function analyseFixture(source: string): WebviewHtmlAnalysis {
	const files = new Map([[`${FIXTURE_ROOT}/globals.d.ts`, FIXTURE_DECLARATIONS], [`${FIXTURE_ROOT}/panel.ts`, `import * as vscode from 'vscode';\n${source}`]]);
	const options: ts.CompilerOptions = { noLib: true, types: [], strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
	const host = ts.createCompilerHost(options, true);
	host.getSourceFile = (fileName, languageVersion) => {
		const text = files.get(fileName);
		return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
	};
	host.fileExists = fileName => files.has(fileName);
	host.readFile = fileName => files.get(fileName);
	return new WebviewHtmlAnalysis(ts.createProgram([...files.keys()], options, host), FIXTURE_ROOT);
}

/** Every named failure of a fixture: its accounting failures and its policies' B5 failures. */
function fixtureFailures(source: string): string[] {
	const sites = analyseFixture(source).sites;
	assert.ok(sites.length > 0, `the fixture has no html site:\n${source}`);
	return sites.flatMap(s => [...s.failures, ...s.policies.flatMap(judgePolicy)]);
}

// A nonce generator the binding check accepts: an in-source function with no parameters whose return is computed.
const NONCE_SOURCE = `declare function randomText(): string;
function makeNonce(): string { return randomText(); }`;
const GOOD_DOCUMENT = '`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script nonce="${nonce}"></script></body></html>`';
const arrayPolicyFixture = (element: string, declarations: string) => `${NONCE_SOURCE}
export function show(panel: vscode.WebviewPanel): void {
	const nonce = makeNonce();
	${declarations}
	const csp = [\`default-src 'none'\`, \`script-src 'nonce-\${nonce}'\`, ${element}].join('; ');
	panel.webview.html = ${GOOD_DOCUMENT};
}`;
const GOOD_BUILDER = `${NONCE_SOURCE}
function build(webview: vscode.Webview, nonce: string): string {
	const csp = \`default-src 'none'; style-src \${webview.cspSource} 'unsafe-inline'; script-src 'nonce-\${nonce}'\`;
	return ${GOOD_DOCUMENT};
}`;

function assertFails(source: string, reason: string): void {
	const failures = fixtureFailures(source);
	assert.ok(failures.some(f => f.includes(reason)), `expected "${reason}", got ${JSON.stringify(failures)}\n${source}`);
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

	test('the policy extraction reads every CSP array element; an element it cannot read fails by name', () => {
		assert.deepStrictEqual(fixtureFailures(arrayPolicyFixture('`img-src data:`', '')), []);
		assertFails(arrayPolicyFixture('"connect-src *"', ''), 'connect-src allows a source other than the webview cspSource');
		assertFails(arrayPolicyFixture(`'script-src-elem https://cdn.example'`, ''), 'script-src-elem is not nonce-only');
		assertFails(arrayPolicyFixture('extra', 'const extra = "connect-src *";'), 'unsupported CSP array element, a Identifier');
		assertFails(arrayPolicyFixture('String(1)', ''), 'unsupported CSP array element, a CallExpression');
		assertFails(arrayPolicyFixture('...[`connect-src *`]', ''), 'unsupported CSP array element, a SpreadElement');
		assertFails(arrayPolicyFixture('`connect-src ${other}`', 'const other = "*";'), 'the policy interpolates ${other}, which this check cannot resolve');
		assertFails(`export function show(panel: vscode.WebviewPanel, nonce: string, csp: string): void { panel.webview.html = ${GOOD_DOCUMENT}; }`,
			'the policy `csp` is not a const with an initializer');
	});

	test('the inventory follows the value each html write assigns, whatever the names; what it cannot account for fails by name', () => {
		assert.deepStrictEqual(fixtureFailures(`${GOOD_BUILDER}\nexport function show(panel: vscode.WebviewPanel): void { panel.webview.html = build(panel.webview, makeNonce()); }`), []);
		const traced = `${GOOD_BUILDER}
class Holder { constructor(private readonly panel: vscode.WebviewPanel) { } initialize(html: string): void { this.panel.webview.html = html; } }
export function show(panel: vscode.WebviewPanel): void { const html = build(panel.webview, makeNonce()); new Holder(panel).initialize(html); }`;
		assert.deepStrictEqual(fixtureFailures(traced), []);
		const plain = '"<html><body>plain</body></html>"';
		assertFails(`export function show(panel: vscode.WebviewPanel): void { const view = panel.webview; view.html = ${plain}; }`, 'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`export function show(target: { webview: { html: string } }): void { target.webview.html = ${plain}; }`, 'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`export function show(panel: vscode.WebviewPanel): void { panel.webview['html'] = ${plain}; }`, 'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`${traced}\nexport function other(panel: vscode.WebviewPanel): void { new Holder(panel).initialize(${plain}); }`, 'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`${GOOD_BUILDER}\nexport function show(panel: vscode.WebviewPanel, ok: boolean): void { panel.webview.html = ok ? build(panel.webview, makeNonce()) : ${plain}; }`,
			'the assigned HTML has no Content-Security-Policy meta');
		const policyAfter = (prefix: string) => `${NONCE_SOURCE}
export function show(panel: vscode.WebviewPanel, title: string): void {
	const nonce = makeNonce();
	const csp = \`default-src 'none'; script-src 'nonce-\${nonce}'\`;
	panel.webview.html = \`<html><head>${prefix}<meta http-equiv="Content-Security-Policy" content="\${csp}"></head></html>\`;
}`;
		assert.deepStrictEqual(fixtureFailures(policyAfter('<meta charset="UTF-8">')), []);
		assertFails(policyAfter('<script>x</script>'), 'the Content-Security-Policy meta is not active');
		assertFails(policyAfter('<title>${title}</title>'), 'the Content-Security-Policy meta is not active');
		assertFails(`${GOOD_BUILDER}\nexport function show(panel: vscode.WebviewPanel): void { panel.webview.html = \`<p>\${build(panel.webview, makeNonce())}</p>\`; }`,
			'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`declare function external(): string;\nexport function show(panel: vscode.WebviewPanel): void { panel.webview.html = external(); }`,
			'the assigned HTML comes from a call whose body is not in the source');
		assertFails(`${GOOD_BUILDER}\nexport function show(panel: vscode.WebviewPanel): void { let html = build(panel.webview, makeNonce()); html = ${plain}; panel.webview.html = html; }`,
			'`html` is neither a const with an initializer nor a parameter');
		assertFails(`export function show(panel: vscode.WebviewPanel): void { panel.webview.html += '<p>x</p>'; }`, 'an html property is written other than by a plain `=`');
		assertFails(`export function show(panel: vscode.WebviewPanel, v: string): void { [panel.webview.html] = [v]; }`, 'an html property is written other than by a plain `=`');
		assertFails(`export function show(panel: vscode.WebviewPanel, key: 'html'): void { panel.webview[key] = ''; }`, 'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`export function show(panel: vscode.WebviewPanel, key: 'cspSource'): string { return panel.webview[key]; }`, 'a Webview member is accessed by a computed key');
		assertFails(`export function show(panel: vscode.WebviewPanel): void { Object.assign(panel.webview, { html: '' }); }`, 'a Webview, a receiver that may be one, or an `html` key, is passed to a reflective write');
		assertFails(`export function show(panel: vscode.WebviewPanel, patch: { title: string }): void { const target: any = panel.webview; Object.assign(target, patch); }`,
			'a Webview, a receiver that may be one, or an `html` key, is passed to a reflective write');
		assertFails(`${traced}\nexport function leak(panel: vscode.WebviewPanel): (h: string) => void { const h = new Holder(panel); return h.initialize; }`,
			'initialize is referenced other than by a direct call');
	});

	test('c2 classes: structural and untyped calls, computed writes through aliases, interpolation bindings, inactive metas', () => {
		const plain = '"<html><body>plain</body></html>"';
		const traced = `${GOOD_BUILDER}
class Holder { constructor(private readonly panel: vscode.WebviewPanel) { } initialize(html: string): void { this.panel.webview.html = html; } }
export function show(panel: vscode.WebviewPanel): void { const html = build(panel.webview, makeNonce()); new Holder(panel).initialize(html); }`;
		// calls that lose the implementation's identity
		assertFails(`${traced}\nexport function other(panel: vscode.WebviewPanel): void { const h: { initialize(html: string): void } = new Holder(panel); h.initialize(${plain}); }`,
			'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`${traced}\nexport function other(panel: vscode.WebviewPanel): void { const h: { initialize(html: string): void } = new Holder(panel); const f = h.initialize; f(${plain}); }`,
			'initialize is reached through a structural type other than by a direct call');
		assertFails(`${traced}\nexport function other(panel: vscode.WebviewPanel): void { const h: any = new Holder(panel); h.initialize(${plain}); }`,
			'the assigned HTML has no Content-Security-Policy meta');
		// computed writes through aliases, and the controls that stay out of the inventory
		assertFails(`export function show(panel: vscode.WebviewPanel): void { const t: { html: string } = panel.webview; const key: 'html' = 'html'; t[key] = ${plain}; }`,
			'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`export function show(panel: vscode.WebviewPanel, key: string): void { const t: any = panel.webview; t[key] = ${plain}; }`,
			'the assigned HTML has no Content-Security-Policy meta');
		assertFails(`export function show(panel: vscode.WebviewPanel, key: string): void { const t = panel.webview as unknown as { [k: string]: string }; t[key] = ${plain}; }`,
			'a Webview is cast to another type');
		assertFails(`export function show(panel: vscode.WebviewPanel, key: string): void { const t = panel.webview as unknown as { [k: string]: string }; t[key] = ${plain}; }`,
			'the assigned HTML has no Content-Security-Policy meta');
		assert.deepStrictEqual(fixtureFailures(`${traced}\nexport function count(values: string[], key: number, map: { [k: string]: number }, name: string): void { values[key] = 'x'; map[name] = 1; }`), []);
		// interpolations judged by their binding
		const rebound = (declarations: string, directive: string) => `${NONCE_SOURCE}
export function show(panel: vscode.WebviewPanel): void {
	const nonce = makeNonce();
	${declarations}
	const csp = [\`default-src 'none'\`, \`script-src 'nonce-\${nonce}'\`, ${directive}].join('; ');
	panel.webview.html = ${GOOD_DOCUMENT};
}`;
		assert.deepStrictEqual(fixtureFailures(rebound('const cspSource = panel.webview.cspSource;', '`connect-src ${cspSource}`')), []);
		assertFails(rebound('const cspSource = "*";', '`connect-src ${cspSource}`'), 'the policy interpolates ${cspSource}, which this check cannot resolve');
		assertFails(`export function show(panel: vscode.WebviewPanel): void {
	const nonce = "x' 'unsafe-inline";
	const csp = \`default-src 'none'; script-src 'nonce-\${nonce}'\`;
	panel.webview.html = ${GOOD_DOCUMENT};
}`, 'the policy interpolates ${nonce}, which this check cannot resolve');
		// policy text that the browser does not apply
		const inactive = (wrap: (meta: string) => string) => `${NONCE_SOURCE}
export function show(panel: vscode.WebviewPanel): void {
	const nonce = makeNonce();
	const csp = \`default-src 'none'; script-src 'nonce-\${nonce}'\`;
	panel.webview.html = \`<!DOCTYPE html><html><head>${wrap('<meta http-equiv="Content-Security-Policy" content="${csp}">')}</head><body></body></html>\`;
}`;
		assert.deepStrictEqual(fixtureFailures(inactive(m => m)), []);
		assertFails(inactive(m => `<!-- ${m} -->`), 'the Content-Security-Policy meta is not active');
		assertFails(inactive(m => `<title>${m}</title>`), 'the Content-Security-Policy meta is not active');
	});

	test('every source file that writes a webview html is listed, with its number of writes', () => {
		const counts: Record<string, number> = {};
		for (const site of analyseExtension().sites) {
			counts[site.file] = (counts[site.file] ?? 0) + 1;
		}
		assert.deepStrictEqual(counts, WEBVIEW_HTML_ASSIGNMENTS);
	});

	test('every html write outside the listed files is accounted for and meets B5', () => {
		const listed = new Set(Object.keys(WEBVIEW_HTML_ASSIGNMENTS));
		const unlisted = analyseExtension().sites.filter(s => !listed.has(s.file));
		assert.deepStrictEqual(unlisted.flatMap(s => [...s.failures, ...s.policies.flatMap(p => judgePolicy(p).map(f => `${s.where}: ${f}`))]), []);
	});

	for (const rel of Object.keys(WEBVIEW_HTML_ASSIGNMENTS)) {
		test(`${rel}: the HTML every write assigns is accounted for, and its policy meets B5`, () => {
			const sites = analyseExtension().sites.filter(s => s.file === rel);
			assert.ok(sites.length > 0, `${rel}: no html write found`);
			for (const site of sites) {
				assert.deepStrictEqual(site.failures, [], site.failures.join(' | '));
				assert.ok(site.policies.length > 0, `${site.where}: no policy`);
				for (const policy of site.policies) {
					assert.deepStrictEqual(judgePolicy(policy), [], `${site.where}: ${policy}`);
				}
			}
		});
		test(`${rel}: every policy admits the webview host's inline styles`, () => {
			for (const site of analyseExtension().sites.filter(s => s.file === rel)) {
				for (const policy of site.policies) {
					assert.deepStrictEqual(judgeHostStyles(policy), [], `${site.where}: ${policy}`);
				}
			}
		});
	}
});
