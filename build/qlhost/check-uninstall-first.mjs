/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, F-DESK-UNINSTALL-1): the bootstrap's FIRST act on the profile is the client's
// `claimLaunchOrUninstall(...)`: one top-level statement that comes before every statement of the bootstrap that writes the
// profile or tells Electron where it is. Rule, read from the file's syntax tree (the fork's typescript), so neither a
// statement's indentation nor its place among the imports hides it: every top-level statement BEFORE the call is an import
// declaration or, token for token, one of ALLOWED_BEFORE (none of them writes: marks, the egress switch, portable
// configuration, argument parsing, the profile path's resolution); the call is, token for token, CALL; it is the only call
// of that name in the file; and each statement of WRITERS_AFTER exists at the top level and comes after the call.
// Run from the fork root (its node_modules holds typescript): `node build/qlhost/check-uninstall-first.mjs src/main.ts`;
// rc 0 = in place.
// Negatives (each on a copy of src/main.ts), rc 1 each: (a) the `const userDataPath…` + call block moved below
// `configureCommandlineSwitchesSync(args)` -> names that writer; (b) the call deleted -> "found 0"; (c) an
// `fs.mkdirSync(...)` statement inserted after `parseCLIArgs()` -> names it; (d) review c1 M9: the same statement INDENTED
// -> names it; (e) review c1 M9: the same statement placed BEFORE the last import -> names it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) {
	console.error('usage: check-uninstall-first.mjs <path to src/main.ts>');
	process.exit(64);
}
const require = createRequire(join(process.cwd(), 'package.json'));
const ts = require('typescript');

const NAME = 'claimLaunchOrUninstall';
const MODULE = './vs/code/electron-main/ql-client/index.js';
const CALL = `claimLaunchOrUninstall({
	argv: process.argv,
	userData: userDataPath,
	product: {
		nameShort: product.nameShort,
		applicationName: product.applicationName,
		dataFolderName: product.dataFolderName,
		darwinBundleIdentifier: product.darwinBundleIdentifier
	}
});`;
const ALLOWED_BEFORE = [
	`perf.mark('code/didStartMain');`,
	`perf.mark('code/willLoadMainBundle', { startTime: Math.floor(performance.timeOrigin) });`,
	`perf.mark('code/didLoadMainBundle');`,
	`disableBackgroundNetwork(app);`,
	`const portable = configurePortable(product);`,
	`const args = parseCLIArgs();`,
	`const userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');`,
];
const WRITERS_AFTER = [
	`const argvConfig = configureCommandlineSwitchesSync(args);`,
	`app.setPath('userData', userDataPath);`,
	`const codeCachePath = getCodeCachePath();`,
];

const printer = ts.createPrinter({ removeComments: true });
function parse(name, text) {
	const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	if (tree.parseDiagnostics.length > 0) {
		throw new Error(`${name} does not parse: ${ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, ' ')}`);
	}
	return tree;
}
/** A statement as its tokens: printed without comments, white space collapsed. */
function tokensOf(statement, tree) {
	return printer.printNode(ts.EmitHint.Unspecified, statement, tree).replace(/\s+/g, ' ').trim();
}
/** The tokens of a rule's one statement, through the same parser and printer as the file's. */
function ruleTokens(text) {
	const tree = parse('rule.ts', text);
	if (tree.statements.length !== 1) {
		throw new Error(`a rule of this check is not one statement: ${text}`);
	}
	return tokensOf(tree.statements[0], tree);
}

const source = readFileSync(file, 'utf8');
const tree = parse(file, source);
const problems = [];
const lineOf = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const firstLine = node => node.getText(tree).split('\n')[0];
const isCallOf = (node, name) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

const imported = tree.statements.some(statement =>
	ts.isImportDeclaration(statement) &&
	ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === MODULE &&
	statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings) &&
	statement.importClause.namedBindings.elements.some(element => element.name.text === NAME && element.propertyName === undefined));
if (!imported) {
	problems.push(`no top-level import of \`${NAME}\` from ${MODULE}`);
}

const calls = tree.statements
	.map((statement, index) => ({ statement, index }))
	.filter(({ statement }) => ts.isExpressionStatement(statement) && isCallOf(statement.expression, NAME));
if (calls.length !== 1) {
	problems.push(`expected exactly 1 top-level \`${NAME}({\` statement, found ${calls.length}`);
}
let everywhere = 0;
const count = node => {
	if (isCallOf(node, NAME)) {
		everywhere++;
	}
	ts.forEachChild(node, count);
};
count(tree);
if (everywhere !== calls.length) {
	problems.push(`\`${NAME}(\` occurs somewhere other than its one top-level statement (${everywhere} calls in the file)`);
}
const call = calls.length === 1 ? calls[0] : undefined;

if (call !== undefined) {
	if (tokensOf(call.statement, tree) !== ruleTokens(CALL)) {
		problems.push(`the call (line ${lineOf(call.statement)}) is not, token for token, the permitted one: \`${ruleTokens(CALL)}\``);
	}
	const allowed = new Set(ALLOWED_BEFORE.map(ruleTokens));
	for (const statement of tree.statements.slice(0, call.index)) {
		if (ts.isImportDeclaration(statement)) {
			continue;
		}
		if (!allowed.has(tokensOf(statement, tree))) {
			problems.push(`line ${lineOf(statement)} runs before the call and is not in the allowed list: \`${firstLine(statement)}\``);
		}
	}
}

const topLevel = wanted => tree.statements.map((statement, index) => ({ statement, index })).filter(({ statement }) => wanted(statement));
const writers = [
	...WRITERS_AFTER.map(text => ({ shown: text, wanted: statement => tokensOf(statement, tree) === ruleTokens(text) })),
	{
		shown: `app.once('ready', function () {`,
		wanted: statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
			statement.expression.expression.getText(tree) === 'app.once' &&
			statement.expression.arguments.length > 0 && ts.isStringLiteral(statement.expression.arguments[0]) && statement.expression.arguments[0].text === 'ready',
	},
];
for (const writer of writers) {
	const found = topLevel(writer.wanted);
	if (found.length === 0) {
		problems.push(`no top-level \`${writer.shown}\` found (the bootstrap changed: re-read it)`);
	}
	for (const { statement, index } of found) {
		if (call !== undefined && index < call.index) {
			problems.push(`\`${writer.shown}\` (line ${lineOf(statement)}) comes BEFORE the call (line ${lineOf(call.statement)}): a refused launch would write the profile`);
		}
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(`check-uninstall-first: RED ${file}: ${problem}`);
	}
	process.exit(1);
}
console.log(`check-uninstall-first: GREEN ${file}: ${NAME} is the bootstrap's first act on the profile (line ${lineOf(call.statement)})`);
