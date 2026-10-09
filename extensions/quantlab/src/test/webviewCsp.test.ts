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
	private names: Map<string, ts.Node[]> | undefined;
	private computed: ts.ElementAccessExpression[] | undefined;
	private castList: (ts.AsExpression | ts.TypeAssertion)[] | undefined;

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
		return this.keyAdmits(this.checker.getTypeAtLocation(key), 'html', 0);
	}

	/** A key type that admits the string `name`: string, any, unknown, a template or mapping type, the literal itself, or a union
	 * holding one; a type parameter or other generic type by its constraint, and admitting when it has none. */
	private keyAdmits(type: ts.Type, name: string, depth: number): boolean {
		return [type, ...(type.isUnion() ? type.types : [])].some(t => {
			if ((t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) !== 0
				|| (t.isStringLiteral() && t.value === name)) {
				return true;
			}
			if ((t.flags & ts.TypeFlags.Instantiable) !== 0) {
				const constraint = this.checker.getBaseConstraintOfType(t);
				return constraint === undefined || constraint === t || depth > MAX_TRACE_DEPTH || this.keyAdmits(constraint, name, depth + 1);
			}
			return false;
		});
	}

	/**
	 * A receiver that may be a webview, fail closed. Its provenance is followed through casts, consts and parameters (every call
	 * site's argument): a Webview there means yes, and only a fresh object, array or literal means no. Where provenance stops (a
	 * call, a member, a parameter whose callers cannot all be found or that is written), the declared type decides: any, unknown,
	 * object or {}, a generic type, a type with an \`html\` property, or an index signature whose values admit a string.
	 */
	private mayHoldWebview(receiver: ts.Expression, depth: number): boolean {
		const e = skipOuter(receiver);
		if (this.isWebview(receiver) || this.isWebview(e)) {
			return true;
		}
		if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || ts.isNewExpression(e) || ts.isStringLiteralLike(e)
			|| ts.isTemplateExpression(e) || ts.isNumericLiteral(e)) {
			return false;
		}
		if (depth <= MAX_TRACE_DEPTH && ts.isIdentifier(e)) {
			const declaration = this.symbolOf(e)?.valueDeclaration;
			if (declaration !== undefined && isConstWithInitializer(declaration)) {
				return this.mayHoldWebview(declaration.initializer, depth + 1);
			}
			if (declaration !== undefined && ts.isParameter(declaration)) {
				const problems: string[] = [];
				const args = this.parameterWrite(declaration) === undefined ? this.argumentsFor(declaration, problems) : [];
				if (problems.length === 0 && args.length > 0) {
					return args.some(a => this.mayHoldWebview(a, depth + 1));
				}
			}
		}
		return [receiver, e].some(x => this.typeMayHoldWebview(this.checker.getTypeAtLocation(x)));
	}

	private typeMayHoldWebview(type: ts.Type): boolean {
		return [type, ...(type.isUnionOrIntersection() ? type.types : [])].some(t => {
			if ((t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Instantiable)) !== 0) {
				return true;
			}
			const apparent = this.checker.getApparentType(t);
			if (this.checker.getPropertyOfType(apparent, 'html') !== undefined) {
				return true;
			}
			if ((t.flags & ts.TypeFlags.Object) !== 0 && this.checker.getPropertiesOfType(apparent).length === 0
				&& this.checker.getIndexInfosOfType(apparent).length === 0 && this.checker.getSignaturesOfType(apparent, ts.SignatureKind.Call).length === 0) {
				return true;
			}
			return this.checker.getIndexInfosOfType(apparent).some(info => this.keyAdmits(info.keyType, 'html', 0)
				&& this.checker.isTypeAssignableTo(this.checker.getStringType(), info.type));
		});
	}

	/** The first write to a parameter inside its function (any assignment, ++/--, destructuring or for-in/of target), if any. */
	private parameterWrite(parameter: ts.ParameterDeclaration): ts.Node | undefined {
		const fn = parameter.parent;
		const own = ts.isIdentifier(parameter.name) ? this.checker.getSymbolAtLocation(parameter.name) : undefined;
		const body = (fn as ts.FunctionLikeDeclaration).body;
		if (own === undefined || body === undefined) {
			return own === undefined ? parameter : undefined;
		}
		let written: ts.Node | undefined;
		const visit = (node: ts.Node): void => {
			if (written === undefined && ts.isIdentifier(node) && node !== parameter.name) {
				const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
					? this.checker.getShorthandAssignmentValueSymbol(node.parent)
					: this.checker.getSymbolAtLocation(node);
				if (symbol === own && assignmentTarget(node)?.kind !== 'read') {
					written = node;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(body);
		return written;
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
				const write = this.parameterWrite(declaration);
				if (write !== undefined) {
					failures.push(`${this.where(write)}: the HTML parameter \`${e.text}\` is written inside its function, so its callers' arguments are not what is assigned`);
					return;
				}
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
		// A private method is reachable only from inside its class, never through a base type or an interface.
		const isPrivate = ts.isMethodDeclaration(fn) && (ts.isPrivateIdentifier(fn.name) || (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Private) !== 0);
		if (ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent) && (fn.parent.heritageClauses?.length ?? 0) > 0 && !isPrivate) {
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
		// A method is also reachable through any other member of the same name (structural typing lets any object with that
		// member stand in), through an untyped receiver, and by its name as a string or a computed key. Fail closed: every occurrence
		// of the name is a direct call, whose argument is traced, or a named failure; only a binding that is not a member is skipped.
		if (ts.isMethodDeclaration(fn) && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) {
			const member = fn.name.text;
			const owner = ts.isClassLike(fn.parent) && fn.parent.name !== undefined ? this.checker.getSymbolAtLocation(fn.parent.name) : undefined;
			const instance = owner === undefined ? undefined : this.checker.getDeclaredTypeOfSymbol(owner);
			for (const occurrence of this.nameIndex().get(member) ?? []) {
				if (occurrence === fn.name || references.includes(occurrence)) {
					continue;
				}
				const parent = occurrence.parent;
				if ((ts.isBindingElement(parent) && (parent.propertyName === occurrence || (parent.propertyName === undefined && parent.name === occurrence)))
					|| (ts.isShorthandPropertyAssignment(parent) && parent.name === occurrence && assignmentTarget(parent.name)?.kind !== 'read')) {
					failures.push(`${this.where(occurrence)}: ${member} is destructured, so a call through it is not traced (${short(parent)})`);
					continue;
				}
				if (ts.isStringLiteralLike(occurrence)) {
					const call = ts.isElementAccessExpression(parent) && parent.argumentExpression === occurrence ? calleeCall(occurrence) : undefined;
					if (call === undefined) {
						failures.push(`${this.where(occurrence)}: the name ${member} appears as a string other than a direct call's key, so it may select the method (${short(parent)})`);
					} else {
						take(call);
					}
					continue;
				}
				const found = this.symbolOf(occurrence);
				const isMember = found === undefined
					? ts.isPropertyAccessExpression(parent) && parent.name === occurrence
					: found.declarations?.some(d => ts.isClassElement(d) || ts.isTypeElement(d) || ts.isObjectLiteralElement(d)) === true;
				if (!isMember) {
					continue;
				}
				if ((ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)
					|| ts.isPropertyAssignment(parent)) && parent.name === occurrence) {
					continue;
				}
				// \`C.member(...)\` on a class itself is that class's static member: positively not this method.
				if (ts.isPropertyAccessExpression(parent) && parent.name === occurrence && ts.isIdentifier(parent.expression)
					&& ((this.symbolOf(parent.expression)?.flags ?? 0) & ts.SymbolFlags.Class) !== 0) {
					continue;
				}
				// A typed receiver that an instance of this class is not assignable to holds one only through a cast (failed below).
				if (found !== undefined && instance !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === occurrence
					&& !this.checker.isTypeAssignableTo(instance, this.checker.getTypeAtLocation(parent.expression))) {
					continue;
				}
				const call = calleeCall(occurrence);
				if (call === undefined) {
					failures.push(`${this.where(occurrence)}: ${member} is reached through ${found === undefined ? 'an untyped receiver' : 'another member of that name'} other than by a direct call (${short(parent)})`);
				} else {
					take(call);
				}
			}
			if (instance !== undefined) {
				for (const cast of this.casts()) {
					if (this.checker.getTypeAtLocation(cast.expression).getSymbol() === instance.getSymbol() && this.checker.getTypeAtLocation(cast).getSymbol() !== instance.getSymbol()) {
						failures.push(`${this.where(cast)}: an instance of ${owner?.name} is cast to another type, so a call of ${member} through it is not traced (${short(cast)})`);
					}
				}
			}
			for (const access of this.computedAccesses()) {
				if (this.keyAdmits(this.checker.getTypeAtLocation(access.argumentExpression), member, 0) && this.mayHaveMember(access.expression, member)) {
					failures.push(`${this.where(access)}: a computed key may select ${member} (${short(access)})`);
				}
			}
		}
		return out;
	}

	/** Every identifier and string literal in the source, by its text. */
	private nameIndex(): Map<string, ts.Node[]> {
		if (this.names === undefined) {
			const index = new Map<string, ts.Node[]>();
			const visit = (node: ts.Node): void => {
				if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
					index.set(node.text, [...(index.get(node.text) ?? []), node]);
				}
				ts.forEachChild(node, visit);
			};
			this.files.forEach(visit);
			this.names = index;
		}
		return this.names;
	}

	/** Every element access in the source whose key is not a string literal. */
	private computedAccesses(): ts.ElementAccessExpression[] {
		if (this.computed === undefined) {
			const out: ts.ElementAccessExpression[] = [];
			const visit = (node: ts.Node): void => {
				if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(skipOuter(node.argumentExpression))) {
					out.push(node);
				}
				ts.forEachChild(node, visit);
			};
			this.files.forEach(visit);
			this.computed = out;
		}
		return this.computed;
	}

	/** Every cast in the source (\`as\`, \`<T>\`, \`satisfies\` excluded: it keeps the type). */
	private casts(): (ts.AsExpression | ts.TypeAssertion)[] {
		if (this.castList === undefined) {
			const out: (ts.AsExpression | ts.TypeAssertion)[] = [];
			const visit = (node: ts.Node): void => {
				if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
					out.push(node);
				}
				ts.forEachChild(node, visit);
			};
			this.files.forEach(visit);
			this.castList = out;
		}
		return this.castList;
	}

	/** A receiver whose type may carry the member: any, unknown, object, a generic type, or a type with that property. */
	private mayHaveMember(receiver: ts.Expression, member: string): boolean {
		const type = this.checker.getTypeAtLocation(receiver);
		return [type, ...(type.isUnionOrIntersection() ? type.types : [])].some(t =>
			(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Instantiable)) !== 0
			|| this.checker.getPropertyOfType(this.checker.getApparentType(t), member) !== undefined);
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
				const write = this.parameterWrite(declaration);
				if (write !== undefined) {
					problems.push(`the parameter \`${e.text}\` is written inside its function (${this.where(write)})`);
					return;
				}
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

	/** `<x>.cspSource` where the member is vscode's Webview.cspSource and x is a webview vscode handed over (`isVscodeWebview`). */
	private isWebviewCspSource(e: ts.Expression): boolean {
		return ts.isPropertyAccessExpression(e) && this.symbolOf(e.name)?.declarations?.some(d =>
			ts.isPropertySignature(d) && d.name.getText() === 'cspSource' && isVscodeWebviewInterface(d.parent as ts.Declaration)) === true
			&& this.isVscodeWebview(e.expression, 0);
	}

	/**
	 * A receiver that is a webview vscode handed over, fail closed: `<y>.webview` where the member is a \`webview\` property of a
	 * vscode API interface (a panel's or a view's), reached through consts and unwritten parameters (every call site). A cast, a
	 * locally built object, or anything else is not one.
	 */
	private isVscodeWebview(receiver: ts.Expression, depth: number): boolean {
		let e = receiver;
		while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) {
			e = e.expression;
		}
		if (depth > MAX_TRACE_DEPTH) {
			return false;
		}
		if (ts.isPropertyAccessExpression(e)) {
			return e.name.text === 'webview' && this.symbolOf(e.name)?.declarations?.some(d => ts.isPropertySignature(d) && isInVscodeModule(d)) === true;
		}
		const declaration = ts.isIdentifier(e) ? this.symbolOf(e)?.valueDeclaration : undefined;
		if (declaration !== undefined && isConstWithInitializer(declaration)) {
			return this.isVscodeWebview(declaration.initializer, depth + 1);
		}
		if (declaration !== undefined && ts.isParameter(declaration) && this.parameterWrite(declaration) === undefined) {
			const problems: string[] = [];
			const args = this.argumentsFor(declaration, problems);
			return problems.length === 0 && args.length > 0 && args.every(a => this.isVscodeWebview(a, depth + 1));
		}
		return false;
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

function isInVscodeModule(node: ts.Node): boolean {
	for (let n: ts.Node = node.parent; n !== undefined; n = n.parent) {
		if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name) && n.name.text === 'vscode') {
			return true;
		}
	}
	return false;
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
			'initialize is reached through another member of that name other than by a direct call');
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

	test('c3: what the analysis does not positively recognise as a site, receiver, key or binding fails by name (fail closed)', () => {
		const plain = '"<html><body>plain</body></html>"';
		const holder = `class Holder { constructor(private readonly panel: vscode.WebviewPanel) { } initialize(html: string): void { this.panel.webview.html = html; } }`;
		const traced = `${GOOD_BUILDER}\n${holder}
export function show(panel: vscode.WebviewPanel): void { const html = build(panel.webview, makeNonce()); new Holder(panel).initialize(html); }`;
		const other = (body: string) => `${traced}\nexport function other(panel: vscode.WebviewPanel): void { ${body} }`;
		const noMeta = 'the assigned HTML has no Content-Security-Policy meta';
		// (1) every occurrence of a traced method's name is a direct call, or fails
		assertFails(other(`const h: any = new Holder(panel); h['initialize'](${plain});`), noMeta);
		assertFails(other(`const h: { initialize(html: string): void } = new Holder(panel); const key: 'initialize' = 'initialize'; h[key](${plain});`),
			'the name initialize appears as a string other than a direct call\'s key');
		assertFails(other(`const h: { initialize(html: string): void } = new Holder(panel); const key: 'initialize' = 'initialize'; h[key](${plain});`),
			'a computed key may select initialize');
		assertFails(other(`const h = new Holder(panel); const { initialize } = h; initialize.call(h, ${plain});`), 'initialize is destructured');
		assertFails(other(`const h = new Holder(panel); h.initialize.call(h, ${plain});`), 'initialize is referenced other than by a direct call');
		assertFails(`${traced}\nclass Other { initialize(html: string): void { void html; } }\nexport function other(panel: vscode.WebviewPanel): void { const o: Other = new Holder(panel); o.initialize(${plain}); }`, noMeta);
		assertFails(`${traced}\nclass Other { private x = 0; initialize(html: string): void { void html; void this.x; } }\nexport function other(panel: vscode.WebviewPanel): void { (new Holder(panel) as unknown as Other).initialize(${plain}); }`,
			'an instance of Holder is cast to another type');
		assertFails(`${traced}\nexport function other<K extends keyof Holder>(panel: vscode.WebviewPanel, k: K): void { const h = new Holder(panel); (h[k] as unknown as (s: string) => void)(${plain}); }`,
			'a computed key may select initialize');
		// (2) computed writes: keys through their constraints, receivers through casts, consts and every call site
		assertFails(`export function overwrite<K extends 'html'>(panel: vscode.WebviewPanel, key: K): void { const view: { html: string } = panel.webview; view[key] = ${plain}; }`, noMeta);
		assertFails(`export function overwrite<K extends string>(panel: vscode.WebviewPanel, key: K): void { const view: { html: string } = panel.webview; view[key as 'html'] = ${plain}; }`, noMeta);
		assertFails(`function overwrite(target: object, key: string): void { const view = target as { [key: string]: string }; view[key] = ${plain}; }
export function show(panel: vscode.WebviewPanel): void { overwrite(panel.webview, 'html'); }`, noMeta);
		assertFails(`function overwrite(target: object, key: string): void { const view = target as { [key: string]: string }; view[key] = ${plain}; }`, noMeta);
		// (3) a cspSource counts only from a webview vscode handed over
		const source = (declarations: string, receiver: string) => `${NONCE_SOURCE}
export function show(panel: vscode.WebviewPanel): void {
	const nonce = makeNonce();
	${declarations}
	const csp = \`default-src 'none'; script-src 'nonce-\${nonce}'; connect-src \${${receiver}.cspSource}\`;
	panel.webview.html = ${GOOD_DOCUMENT};
}`;
		assert.deepStrictEqual(fixtureFailures(source('const w = panel.webview;', 'w')), []);
		assertFails(source(`const policyWebview: vscode.Webview = { ...panel.webview, cspSource: '*' };`, 'policyWebview'), 'which this check cannot resolve');
		assertFails(source(`const w: vscode.Webview = { html: '', cspSource: '*' };`, 'w'), 'which this check cannot resolve');
		assertFails(source(`const w = panel.webview as vscode.Webview;`, 'w'), 'which this check cannot resolve');
		// (4) a traced parameter that is written inside its function fails, whatever the write
		const written = (write: string) => `${GOOD_BUILDER}\n${holder.replace('{ this.panel.webview.html = html; }', `{ ${write}; this.panel.webview.html = html; }`)}
export function show(panel: vscode.WebviewPanel): void { new Holder(panel).initialize(build(panel.webview, makeNonce())); }`;
		for (const write of [`html = ${plain}`, `html += ''`, `[html] = [${plain}]`, `({ html } = { html: ${plain} })`]) {
			assertFails(written(write), 'the HTML parameter `html` is written inside its function');
		}
		assertFails(`${NONCE_SOURCE}
function build(cspSource: string, nonce: string): string {
	cspSource = '*';
	const csp = \`default-src 'none'; script-src 'nonce-\${nonce}'; connect-src \${cspSource}\`;
	return ${GOOD_DOCUMENT};
}
export function show(panel: vscode.WebviewPanel): void { panel.webview.html = build(panel.webview.cspSource, makeNonce()); }`, 'the parameter `cspSource` is written inside its function');
		// regressions: what is positively recognised still passes
		assert.deepStrictEqual(fixtureFailures(traced), []);
		assert.deepStrictEqual(fixtureFailures(`${traced}\nclass Registry { static initialize(n: number): void { void n; } }\nexport function boot(): void { Registry.initialize(1); }`), []);
		assert.deepStrictEqual(fixtureFailures(`${traced}\nclass Store { private n = 0; initialize(n: number): void { this.n = n; } }\nexport function boot(): void { new Store().initialize(1); }`), []);
		assert.deepStrictEqual(fixtureFailures(`${traced}\nfunction put(target: object, key: string): void { const m = target as { [k: string]: string }; m[key] = 'x'; }\nexport function boot(): void { put({}, 'a'); }`), []);
		assert.deepStrictEqual(fixtureFailures(`${traced}\nexport function count(values: string[], key: number, map: { [k: string]: number }, name: string): void { values[key] = 'x'; map[name] = 1; }`), []);
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
