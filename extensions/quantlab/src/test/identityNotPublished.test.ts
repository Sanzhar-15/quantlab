/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Rule 2 / EXT-ISO case G3: no extension other than QuantLab may obtain the Delta Plus identity.
// A public vscode AuthenticationProvider would hand the account id and label to every extension,
// so QuantLab neither contributes nor registers one. Pure file-based checks -- no vscode runtime.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

interface AuthenticationContribution {
	id: string;
	label: string;
}

interface PackageManifest {
	contributes: {
		authentication?: AuthenticationContribution[];
	};
}

function read(rel: string): string {
	return fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');
}

/** Every non-test .ts file under src/, as [relative path, source]. */
function productionSources(): [string, string][] {
	return sourcesUnderSrc(false);
}

/** Every .ts file under src/ (test folders included when `includeTests`), as [relative path, source]. */
function sourcesUnderSrc(includeTests: boolean): [string, string][] {
	const out: [string, string][] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'test' && !includeTests) { continue; }
				walk(p);
			} else if (entry.name.endsWith('.ts')) {
				out.push([path.relative(EXTENSION_ROOT, p), fs.readFileSync(p, 'utf8')]);
			}
		}
	};
	walk(path.join(EXTENSION_ROOT, 'src'));
	return out;
}

suite('Delta Plus identity is not published to other extensions (EXT-ISO G3)', () => {
	test('package.json contributes no authentication provider with id deltaplus', () => {
		const pkg = JSON.parse(read('package.json')) as PackageManifest;
		const contributed = pkg.contributes.authentication;
		if (contributed !== undefined) {
			const ids = contributed.map(a => a.id);
			assert.ok(!ids.includes('deltaplus'), `contributes.authentication still lists deltaplus: ${ids.join(', ')}`);
		}
	});

	test('extension.ts does not call registerAuthenticationProvider', () => {
		const source = read('src/extension.ts');
		assert.ok(
			!source.includes('registerAuthenticationProvider'),
			'src/extension.ts must not register a vscode AuthenticationProvider',
		);
	});

	test('no production source registers an AuthenticationProvider', () => {
		const offenders = productionSources()
			.filter(([, source]) => source.includes('registerAuthenticationProvider'))
			.map(([rel]) => rel);
		assert.deepStrictEqual(offenders, [], `AuthenticationProvider registered in: ${offenders.join(', ')}`);
	});

	test('DeltaPlusAuthProvider does not implement vscode.AuthenticationProvider', () => {
		const source = read('src/auth/DeltaPlusAuthProvider.ts');
		assert.ok(
			!/implements[^{]*vscode\.AuthenticationProvider\b/.test(source),
			'DeltaPlusAuthProvider must stay an internal identity holder, not an AuthenticationProvider',
		);
	});

	// Rule 2: the identity reaches this extension ONLY through vscode.quantlabHost. The retired workbench
	// commands `_quantlab.hostIdentity.get` / `.didChange` handed it to ANY extension, so no source under
	// src/ (tests included, this file excepted) may register, execute or even name them.
	// Planted negative control: re-add `vscode.commands.registerCommand('_quantlab.hostIdentity.didChange', ...)`
	// to src/auth/DeltaPlusAuthProvider.ts and this test fails, naming that file.
	test('no source in src registers or executes a _quantlab.hostIdentity command', () => {
		const self = path.join('src', 'test', 'identityNotPublished.test.ts');
		const offenders = sourcesUnderSrc(true)
			.filter(([rel, source]) => rel !== self && source.includes('_quantlab.hostIdentity'))
			.map(([rel]) => rel);
		assert.deepStrictEqual(offenders, [], `_quantlab.hostIdentity named in: ${offenders.join(', ')}`);
	});

	// Planted negative control: replace `this._host.getIdentity()` in DeltaPlusAuthProvider._pull with
	// `vscode.commands.executeCommand<unknown>(['_quantlab', 'hostIdentity', 'get'].join('.'))` (a name the
	// literal check above does not see) and this test fails.
	test('DeltaPlusAuthProvider reads the identity through vscode.quantlabHost, never through a command', () => {
		const source = read('src/auth/DeltaPlusAuthProvider.ts');
		assert.ok(!source.includes('vscode.commands'), 'DeltaPlusAuthProvider must neither register nor execute a command');
		assert.ok(source.includes('vscode.quantlabHost'), 'DeltaPlusAuthProvider must read the identity from vscode.quantlabHost');
	});
});
