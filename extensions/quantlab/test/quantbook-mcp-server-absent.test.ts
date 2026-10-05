/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Release 1 ships no Quantbook MCP server (W-ORCH, 2026-10-05: it opened a loopback server, imported its
// SDK through a Function-constructed import and printed its bearer token). This guard fails if any of it
// returns to the extension's source or manifest; the packaged app is judged by the FEATURES run's
// quantbook-mcp-absent row.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Compiled to out/test/: the extension root is two levels up.
const root = path.resolve(__dirname, '..', '..');
const SDK = '@modelcontextprotocol/';
const MCP_IDS = /Mcp/;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/** `file:line` for every non-comment line of `files` that matches `pattern`. */
function hits(files: string[], pattern: RegExp): string[] {
	const out: string[] = [];
	for (const file of files) {
		fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
			const code = line.trim();
			if (!code.startsWith('//') && !code.startsWith('*') && !code.startsWith('/*') && pattern.test(line)) {
				out.push(`${path.relative(root, file)}:${i + 1}`);
			}
		});
	}
	return out;
}

suite('Quantbook MCP server absent from release 1', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const src = sourceFiles(path.join(root, 'src'));

	test('the guard reads the quantlab extension and its source', () => {
		assert.strictEqual(`${manifest.publisher}.${manifest.name}`, 'quantlab.quantlab');
		assert.ok(src.length > 50, `only ${src.length} source files found under ${path.join(root, 'src')}`);
		assert.ok(src.some(file => file.endsWith(path.join('src', 'extension.ts'))), 'src/extension.ts not found');
	});

	test('quantbook/mcp holds only the two pure logic modules', () => {
		assert.deepStrictEqual(fs.readdirSync(path.join(root, 'src', 'quantbook', 'mcp')).sort(), ['mcpToolLogic.ts', 'mcpWriteLogic.ts']);
	});

	test('no source imports the MCP SDK, constructs a Function or registers the server', () => {
		assert.deepStrictEqual(hits(src, /from\s+['"]@modelcontextprotocol\/|import\(\s*['"]@modelcontextprotocol\//), []);
		assert.deepStrictEqual(hits(src, /\bnew\s+Function\s*\(/), []);
		assert.deepStrictEqual(hits(src, /registerQuantbookMcpServer/), []);
	});

	test('no Quantbook source writes a token value to a log or the clipboard', () => {
		const quantbook = sourceFiles(path.join(root, 'src', 'quantbook'));
		assert.deepStrictEqual(hits(quantbook, /(appendLine|console\.\w+|clipboard\.writeText)\([^\n]*token/i), []);
	});

	test('the manifest has no MCP command, palette entry, setting or SDK dependency', () => {
		const c = manifest.contributes;
		assert.deepStrictEqual(c.commands.map((x: { command: string }) => x.command).filter((id: string) => MCP_IDS.test(id)), []);
		assert.deepStrictEqual(c.menus.commandPalette.map((x: { command: string }) => x.command).filter((id: string) => MCP_IDS.test(id)), []);
		assert.deepStrictEqual(Object.keys(c.configuration.properties).filter(key => MCP_IDS.test(key)), []);
		const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
		assert.deepStrictEqual(deps.filter(name => name.startsWith(SDK)), []);
		const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
		assert.deepStrictEqual(Object.keys(lock.packages).filter(key => key.includes(`node_modules/${SDK}`)), []);
	});
});
