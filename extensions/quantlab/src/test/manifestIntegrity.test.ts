/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Megaudit W6.4 (H48 / H49 / M91) regression suite: manifest <-> runtime
// integrity. Pure file-based checks -- no vscode runtime needed.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

interface CommandContribution {
	command: string;
	title: string;
	category?: string;
}

interface KeybindingContribution {
	command: string;
	key: string;
	mac?: string;
	when?: string;
}

interface PackageManifest {
	contributes: {
		commands: CommandContribution[];
		keybindings: KeybindingContribution[];
	};
}

function readJson<T>(rel: string): T {
	const raw = fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');
	return JSON.parse(raw) as T;
}

/** Collect the concatenated source of every .ts file under src/ (excluding tests). */
function collectSource(): string {
	const chunks: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'test') { continue; }
				walk(p);
			} else if (entry.name.endsWith('.ts')) {
				chunks.push(fs.readFileSync(p, 'utf8'));
			}
		}
	};
	walk(path.join(EXTENSION_ROOT, 'src'));
	return chunks.join('\n');
}

suite('Manifest integrity (W6.4: H48/H49/M91)', () => {
	let pkg: PackageManifest;
	let nls: Record<string, string>;
	let source: string;

	suiteSetup(() => {
		pkg = readJson<PackageManifest>('package.json');
		nls = readJson<Record<string, string>>('package.nls.json');
		source = collectSource();
	});

	test('package.json and package.nls.json parse', () => {
		assert.ok(pkg.contributes.commands.length > 0, 'contributes.commands must be non-empty');
		assert.ok(Object.keys(nls).length > 0, 'package.nls.json must be non-empty');
	});

	test('every contributed command id appears in src (is wired to a registration)', () => {
		// Commands registered through helper wrappers (registerClipboardCommand,
		// registerStructuralCommand, dashboard helpers) still mention the literal
		// id, so a source-wide literal scan is the correct invariant.
		const missing = pkg.contributes.commands
			.map(c => c.command)
			.filter(id => !source.includes(`'${id}'`) && !source.includes(`"${id}"`) && !source.includes('`' + id + '`'));
		assert.deepStrictEqual(missing, [], `contributed but never referenced in src: ${missing.join(', ')}`);
	});

	test('every %nls% reference in package.json resolves in package.nls.json', () => {
		const raw = fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8');
		const missing: string[] = [];
		for (const m of raw.matchAll(/"%([^%"]+)%"/g)) {
			if (!Object.prototype.hasOwnProperty.call(nls, m[1])) {
				missing.push(m[1]);
			}
		}
		assert.deepStrictEqual(missing, [], `unresolved NLS keys: ${missing.join(', ')}`);
	});

	test('M91: all contributed command titles use NLS keys (no hardcoded strings)', () => {
		const hardcoded = pkg.contributes.commands.filter(c => !/^%.+%$/.test(c.title));
		assert.deepStrictEqual(
			hardcoded.map(c => c.command), [],
			`hardcoded titles: ${hardcoded.map(c => `${c.command}="${c.title}"`).join(', ')}`,
		);
	});

	test('H48: quantlab.openHome is declared in the manifest and registered in extension.ts', () => {
		const declared = pkg.contributes.commands.find(c => c.command === 'quantlab.openHome');
		assert.ok(declared, 'quantlab.openHome missing from contributes.commands');
		assert.strictEqual(declared.title, '%command.openHome.title%');
		assert.ok(Object.prototype.hasOwnProperty.call(nls, 'command.openHome.title'), 'command.openHome.title missing from package.nls.json');
		const extensionTs = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8');
		assert.ok(
			extensionTs.includes(`registerCommand('quantlab.openHome'`),
			'quantlab.openHome runtime registration missing from extension.ts',
		);
	});

	test('H49: the two ctrl+q e keybindings are mutually exclusive on quantlab.isDataFile', () => {
		const bindings = pkg.contributes.keybindings.filter(k => k.key === 'ctrl+q e');
		assert.strictEqual(bindings.length, 2, 'expected exactly two ctrl+q e keybindings');

		const toEditor = bindings.find(k => k.command === 'quantlab.switchToEditor');
		const toDataEditor = bindings.find(k => k.command === 'quantlab.switchToDataEditor');
		assert.ok(toEditor, 'quantlab.switchToEditor ctrl+q e binding missing');
		assert.ok(toDataEditor, 'quantlab.switchToDataEditor ctrl+q e binding missing');

		assert.ok(
			/(^|\s&&\s)!quantlab\.isDataFile($|\s)/.test(toEditor.when ?? ''),
			`switchToEditor when-clause must exclude data files, got: ${toEditor.when}`,
		);
		assert.ok(
			/(^|\s&&\s)quantlab\.isDataFile($|\s)/.test(toDataEditor.when ?? ''),
			`switchToDataEditor when-clause must require quantlab.isDataFile, got: ${toDataEditor.when}`,
		);
	});

	test('H49: extension.ts refreshes quantlab.isDataFile on active-context changes', () => {
		const extensionTs = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8');
		assert.ok(
			extensionTs.includes(`'quantlab.isDataFile'`),
			'extension.ts must set the quantlab.isDataFile context key on editor/tab changes (H49 staleness fix)',
		);
	});
});
