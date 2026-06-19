/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I-b (R12) -- unit tests for the "Functions" catalog sidebar.
//   1. formatArity / buildFunctionTooltip / isUserDefined -- pure formatting + classification.
//   2. buildFunctionCatalogNodes -- grouping (user-defined first, built-ins by first letter), ordering,
//      empty state -- pure.
//   3. FunctionCatalogTreeProvider getTreeItem / getChildren (icons + copy command + tree walk), driving
//      the focused-function read via a monkeypatched focused panel.

import * as assert from 'assert';

import { installVscodeShim } from './helpers/vscode-shim';
installVscodeShim();

import {
	buildFunctionCatalogNodes,
	buildFunctionTooltip,
	formatArity,
	isUserDefined,
	type FunctionCatalogNode,
} from '../src/quantbook/shell/functionCatalogModel';
import { COPY_FUNCTION_NAME_COMMAND, FunctionCatalogTreeProvider } from '../src/quantbook/shell/FunctionCatalogTreeProvider';
import { CellGridPanel } from '../src/quantbook/cellGrid/cellGridPanel';
import type { ArityJson, FunctionMetadataJson, SessionInstance } from '../src/quantbook/types';

function fn(canonicalName: string, over: Partial<FunctionMetadataJson> = {}): FunctionMetadataJson {
	return {
		canonicalName,
		aliases: [],
		arity: { kind: 'variadic' },
		volatility: 'pure',
		determinism: true,
		depShape: 'value_deps',
		batchShape: 'scalar',
		argPolicy: 'strict',
		cancellation: 'none',
		argContext: 'scalar',
		provenanceTags: [],
		...over,
	};
}

// ---------------------------------------------------------------------------
// formatArity / buildFunctionTooltip / isUserDefined
// ---------------------------------------------------------------------------

suite('Wave I-b -- formatArity', () => {
	const cases: Array<{ arity: ArityJson; out: string }> = [
		{ arity: { kind: 'fixed', n: 0 }, out: '()' },
		{ arity: { kind: 'fixed', n: 1 }, out: '(1 arg)' },
		{ arity: { kind: 'fixed', n: 3 }, out: '(3 args)' },
		{ arity: { kind: 'range', min: 1, max: 3 }, out: '(1-3 args)' },
		{ arity: { kind: 'range', min: 2 }, out: '(2+ args)' },
		{ arity: { kind: 'variadic' }, out: '(variadic)' },
	];
	for (const c of cases) {
		test(`${JSON.stringify(c.arity)} -> ${c.out}`, () => {
			assert.strictEqual(formatArity(c.arity), c.out);
		});
	}
});

suite('Wave I-b -- isUserDefined', () => {
	test('a built-in (no tags, no displayName) is NOT user-defined', () => {
		assert.strictEqual(isUserDefined(fn('SUM')), false);
	});
	test('a function with a provenance tag is user-defined', () => {
		assert.strictEqual(isUserDefined(fn('MY_UDF', { provenanceTags: ['python'] })), true);
	});
	test('a function with a displayName is user-defined', () => {
		assert.strictEqual(isUserDefined(fn('MY_UDF', { displayName: 'My UDF' })), true);
	});
});

suite('Wave I-b -- buildFunctionTooltip', () => {
	test('canonical name + signature, traits, context; aliases + tags only when present', () => {
		const t = buildFunctionTooltip(fn('SHARPE', { arity: { kind: 'range', min: 1, max: 3 }, aliases: ['SR'], provenanceTags: ['quant'], argContext: 'aggregate' }));
		assert.ok(t.startsWith('SHARPE (1-3 args)'), t);
		assert.ok(t.includes('Aliases: SR'), t);
		assert.ok(t.includes('Volatility: pure  |  Deterministic: yes'), t);
		assert.ok(t.includes('Context: aggregate'), t);
		assert.ok(t.includes('Tags: quant'), t);
	});
	test('a UDF displayName surfaces when it differs from the canonical name', () => {
		const t = buildFunctionTooltip(fn('MY_UDF', { displayName: 'My UDF', provenanceTags: ['python'] }));
		assert.ok(t.includes('Display name: My UDF'), t);
	});
	test('no aliases / no tags / no distinct displayName -> those lines omitted (context always shown)', () => {
		const t = buildFunctionTooltip(fn('SUM', { arity: { kind: 'variadic' } }));
		assert.ok(!t.includes('Aliases:'), t);
		assert.ok(!t.includes('Tags:'), t);
		assert.ok(!t.includes('Display name:'), t);
		assert.ok(t.includes('Context: scalar'), t);
	});
});

// ---------------------------------------------------------------------------
// buildFunctionCatalogNodes (grouping / ordering / empty state)
// ---------------------------------------------------------------------------

suite('Wave I-b -- buildFunctionCatalogNodes', () => {
	const built = (functions: FunctionMetadataJson[]): FunctionCatalogNode[] =>
		buildFunctionCatalogNodes({ hasFocusedGrid: true, functions });

	test('no focused grid -> a single noGrid node (distinct from "no functions")', () => {
		assert.deepStrictEqual(buildFunctionCatalogNodes({ hasFocusedGrid: false, functions: [] }).map(n => n.kind), ['noGrid']);
	});

	test('focused grid with no functions -> a single empty node', () => {
		assert.deepStrictEqual(built([]).map(n => n.kind), ['empty']);
	});

	test('built-ins group by first letter, letters ascending, names sorted within', () => {
		const nodes = built([fn('SUM'), fn('ABS'), fn('AVERAGE'), fn('COUNT')]);
		assert.deepStrictEqual(nodes.map(n => (n.kind === 'group' ? n.label : '?')), ['A', 'C', 'S']);
		const a = nodes[0];
		assert.strictEqual(a.kind, 'group');
		if (a.kind !== 'group') { return; }
		assert.strictEqual(a.count, 2);
		assert.deepStrictEqual(a.children.map(c => (c.kind === 'function' ? c.name : '?')), ['ABS', 'AVERAGE']);
	});

	test('user-defined functions are grouped FIRST, before the letter groups', () => {
		const nodes = built([fn('ABS'), fn('MY_UDF', { provenanceTags: ['python'] })]);
		assert.strictEqual(nodes[0].kind, 'group');
		assert.strictEqual(nodes[0].kind === 'group' ? nodes[0].label : '', 'User-defined');
		assert.strictEqual(nodes[0].kind === 'group' ? nodes[0].userDefined : false, true);
		// then the built-in letter group(s)
		assert.deepStrictEqual(nodes.slice(1).map(n => (n.kind === 'group' ? n.label : '?')), ['A']);
	});

	test('a non-letter first char buckets under "#"', () => {
		const nodes = built([fn('_PRIVATE'), fn('SUM')]);
		assert.deepStrictEqual(nodes.map(n => (n.kind === 'group' ? n.label : '?')), ['#', 'S']);
	});

	test('a function node carries its signature + tooltip', () => {
		const nodes = built([fn('SHARPE', { arity: { kind: 'range', min: 1, max: 3 } })]);
		const group = nodes[0];
		assert.strictEqual(group.kind, 'group');
		if (group.kind !== 'group') { return; }
		const f = group.children[0];
		assert.strictEqual(f.kind, 'function');
		if (f.kind !== 'function') { return; }
		assert.strictEqual(f.signature, '(1-3 args)');
		assert.ok(f.tooltip.startsWith('SHARPE (1-3 args)'));
	});
});

// ---------------------------------------------------------------------------
// FunctionCatalogTreeProvider (icons + copy command + tree walk)
// ---------------------------------------------------------------------------

const noopSub = (_l: () => void): { dispose(): void } => ({ dispose: () => { /* no-op */ } });

function iconId(item: { iconPath?: unknown }): string | undefined {
	return (item.iconPath as { id?: string } | undefined)?.id;
}

suite('Wave I-b -- FunctionCatalogTreeProvider', () => {
	test('getTreeItem: a group is collapsible with a count; a function is a leaf with a copy command', () => {
		const p = new FunctionCatalogTreeProvider(noopSub);
		const group = p.getTreeItem({ kind: 'group', id: 'g', label: 'A', count: 2, userDefined: false, children: [] });
		assert.strictEqual(group.collapsibleState, 1 /* Collapsed */);
		assert.strictEqual(group.description, '2');
		assert.strictEqual(iconId(group), 'symbol-function');

		const leaf = p.getTreeItem({ kind: 'function', id: 'f', label: 'ABS', name: 'ABS', signature: '(1 arg)', tooltip: 'ABS (1 arg)', userDefined: false });
		assert.strictEqual(leaf.collapsibleState, 0 /* None */);
		assert.strictEqual(leaf.description, '(1 arg)');
		assert.strictEqual(leaf.command?.command, COPY_FUNCTION_NAME_COMMAND);
		assert.deepStrictEqual(leaf.command?.arguments, ['ABS']);
	});

	test('getChildren(group) returns its children; a leaf returns []', () => {
		const p = new FunctionCatalogTreeProvider(noopSub);
		const child: FunctionCatalogNode = { kind: 'function', id: 'f', label: 'ABS', name: 'ABS', signature: '()', tooltip: 'ABS ()', userDefined: false };
		const group: FunctionCatalogNode = { kind: 'group', id: 'g', label: 'A', count: 1, userDefined: false, children: [child] };
		assert.deepStrictEqual(p.getChildren(group), [child]);
		assert.deepStrictEqual(p.getChildren(child), []);
	});

	test('getChildren(root) reads the focused session listFunctions and groups them', () => {
		const original = CellGridPanel.focusedLocalPanel;
		const session = { listFunctions: () => [fn('SUM'), fn('ABS')] } as unknown as SessionInstance;
		try {
			(CellGridPanel as unknown as { focusedLocalPanel: () => { session: SessionInstance; sheet: number } }).focusedLocalPanel =
				() => ({ session, sheet: 0 });
			const roots = new FunctionCatalogTreeProvider(noopSub).getChildren();
			assert.deepStrictEqual(roots.map(n => (n.kind === 'group' ? n.label : '?')), ['A', 'S']);
		} finally {
			(CellGridPanel as unknown as { focusedLocalPanel: typeof original }).focusedLocalPanel = original;
		}
	});

	test('getChildren(root) with no focused grid -> the noGrid node (not a misleading empty)', () => {
		const original = CellGridPanel.focusedLocalPanel;
		try {
			(CellGridPanel as unknown as { focusedLocalPanel: () => undefined }).focusedLocalPanel = () => undefined;
			assert.deepStrictEqual(new FunctionCatalogTreeProvider(noopSub).getChildren().map(n => n.kind), ['noGrid']);
		} finally {
			(CellGridPanel as unknown as { focusedLocalPanel: typeof original }).focusedLocalPanel = original;
		}
	});
});
