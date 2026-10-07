/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A built-in extension whose main is ES module syntax must declare `"type": "module"`. Without it the extension host
// loads the main with require(); Node then links the module synchronously and resolves 'vscode' through the extension
// host's ESM loader hook, which waits for an answer from the extension host's main thread while that thread is blocked
// waiting for the hook: the extension host hangs (F-PACK-14; the github extension lost the line in 994d118b3f5).

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// What V8 reports when ES module syntax is compiled as a CommonJS module body.
const esmSyntaxErrorMessages: readonly string[] = [
	'Cannot use import statement outside a module',
	`Unexpected token 'export'`,
	`Cannot use 'import.meta' outside a module`,
];

/**
 * Compiles `source` as a CommonJS module body. Returns true when it fails only because it is ES module syntax,
 * false when it compiles. Any other compile error is thrown.
 */
export function isEsmSyntax(source: string, filename: string): boolean {
	try {
		vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
		return false;
	} catch (err) {
		if (err instanceof SyntaxError && esmSyntaxErrorMessages.includes(err.message)) {
			return true;
		}
		throw err;
	}
}

function resolveMain(extensionPath: string, main: string): string | undefined {
	const exact = path.join(extensionPath, main);
	if (fs.existsSync(exact) && fs.statSync(exact).isFile()) {
		return exact;
	}
	const withJs = `${exact}.js`;
	if (fs.existsSync(withJs)) {
		return withJs;
	}
	return undefined;
}

/**
 * One problem line per extension under `extensionsRoot` (one folder per extension; a folder without a package.json
 * is not an extension) whose main is ES module syntax without `"type": "module"`, or whose main does not exist.
 */
export function findEsmMainsWithoutModuleType(extensionsRoot: string): string[] {
	const problems: string[] = [];
	for (const name of fs.readdirSync(extensionsRoot).sort()) {
		const packageJsonPath = path.join(extensionsRoot, name, 'package.json');
		if (!fs.existsSync(packageJsonPath)) {
			continue;
		}
		const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { main?: string; type?: string };
		if (!manifest.main || manifest.type === 'module') {
			continue;
		}
		const mainPath = resolveMain(path.join(extensionsRoot, name), manifest.main);
		if (!mainPath) {
			problems.push(`${name}: main '${manifest.main}' does not exist`);
			continue;
		}
		// .mjs is loaded as ES module and .cjs as CommonJS whatever the package type says.
		if (mainPath.endsWith('.mjs') || mainPath.endsWith('.cjs')) {
			continue;
		}
		if (isEsmSyntax(fs.readFileSync(mainPath, 'utf8'), mainPath)) {
			problems.push(`${name}: main '${manifest.main}' is ES module syntax but package.json has no "type": "module" (the extension host would load it with require() and hang)`);
		}
	}
	return problems;
}
