/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- unit tests for the vscode-free dep-graph node model.
//
// Verifies the No-Fallbacks state machine: no focused cell -> "no selection"; a literal cell -> explicit
// "no dependencies (literal)"; a formula with precedents -> a "Formula precedents" section + one node per
// precedent (cross-sheet flagged); a published-driven cell -> a "Driven by" section naming the variable;
// a running kernel -> an explicit "SQL not tracked" note; a formula error -> a surfaced error node (never
// silently dropped). Pure (no ipykernel / no vscode); runs in the normal mocha suite.
//
// NB: the file name MUST start with `quantbook` -- the mocha glob is `out/test/quantbook*.test.js`.

import * as assert from 'assert';

import {
	buildDepGraphNodes,
	type DepGraphInput,
	type DepGraphNode,
	type PrecedentEdge,
} from '../src/quantbook/shell/depGraphModel';

function precedent(target: string, crossSheet = false, self = false): PrecedentEdge {
	return { target, crossSheet, self };
}

/** A focused-cell input with sensible defaults; override per test. */
function input(over: Partial<DepGraphInput>): DepGraphInput {
	return {
		focusedCellLabel: 'S0!B2',
		focusedSheetMissing: false,
		focusedFormula: undefined,
		formulaError: undefined,
		precedents: [],
		kernelRunning: false,
		pythonOwner: undefined,
		...over,
	};
}

function kinds(nodes: DepGraphNode[]): string[] {
	return nodes.map((n) => n.kind);
}

suite('W3 dep-graph model -- empty/selection states', () => {
	test('no focused cell -> a single "no selection" node (no fabricated data)', () => {
		const nodes = buildDepGraphNodes(input({ focusedCellLabel: undefined }));
		assert.strictEqual(nodes.length, 1);
		assert.strictEqual(nodes[0].kind, 'noSelection');
	});

	test('a deleted focused sheet -> a single explicit "focusedSheetMissing" node (not masked)', () => {
		// No-Fallbacks: a tombstoned focused sheet must look broken, not render a healthy "no dependencies".
		const nodes = buildDepGraphNodes(input({
			focusedCellLabel: 'Sheet 7!A1',
			focusedSheetMissing: true,
			// even if other fields are populated, the missing-sheet state replaces the whole view
			focusedFormula: 'A1',
			precedents: [precedent('S0!A1')],
			kernelRunning: true,
			pythonOwner: 'x',
		}));
		assert.strictEqual(nodes.length, 1);
		assert.strictEqual(nodes[0].kind, 'focusedSheetMissing');
		assert.ok(!nodes.some((n) => n.kind === 'noDependencies'), 'no healthy-looking empty state');
	});

	test('a literal cell (no formula, no owner) -> focusedCell + explicit "no dependencies (literal)"', () => {
		const nodes = buildDepGraphNodes(input({ focusedFormula: undefined }));
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'noDependencies']);
		const empty = nodes.find((n) => n.kind === 'noDependencies');
		assert.ok(empty !== undefined && empty.kind === 'noDependencies');
		assert.match(empty.label, /literal/);
	});

	test('a formula cell that reads no cells -> "no dependencies (formula reads no cells)"', () => {
		const nodes = buildDepGraphNodes(input({ focusedFormula: 'TODAY()', precedents: [] }));
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'noDependencies']);
		const empty = nodes.find((n) => n.kind === 'noDependencies');
		assert.ok(empty !== undefined && empty.kind === 'noDependencies');
		assert.match(empty.label, /reads no cells/);
	});

	test('the focused cell is always the first node when a cell is focused', () => {
		const nodes = buildDepGraphNodes(input({ focusedCellLabel: 'S0!C5' }));
		assert.strictEqual(nodes[0].kind, 'focusedCell');
		if (nodes[0].kind === 'focusedCell') {
			assert.strictEqual(nodes[0].label, 'S0!C5');
			assert.strictEqual(nodes[0].cellLabel, 'S0!C5');
		}
	});
});

suite('W3 dep-graph model -- formula precedents', () => {
	test('precedents -> a section header + one precedent node each, in order', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'A1+B1',
			precedents: [precedent('S0!A1'), precedent('S0!B1')],
		}));
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'sectionHeader', 'precedent', 'precedent']);
		const labels = nodes.filter((n) => n.kind === 'precedent').map((n) => n.label);
		assert.deepStrictEqual(labels, ['S0!A1', 'S0!B1']);
	});

	test('a cross-sheet precedent carries the crossSheet flag', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'Sheet2!C3',
			precedents: [precedent('Sheet2!C3', true)],
		}));
		const p = nodes.find((n) => n.kind === 'precedent');
		assert.ok(p !== undefined && p.kind === 'precedent');
		assert.strictEqual(p.crossSheet, true);
	});

	test('precedent node ids are unique per target', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'A1+B1+C1',
			precedents: [precedent('S0!A1'), precedent('S0!B1'), precedent('S0!C1')],
		}));
		const ids = nodes.map((n) => n.id);
		assert.strictEqual(new Set(ids).size, ids.length, 'all node ids are distinct');
	});

	test('a self-reference is KEPT + flagged, never silently dropped (cycle is a real signal)', () => {
		const nodes = buildDepGraphNodes(input({
			focusedCellLabel: 'S0!B2',
			focusedFormula: 'B2+A1',
			precedents: [precedent('S0!B2', false, true), precedent('S0!A1')],
		}));
		const prec = nodes.filter((n) => n.kind === 'precedent');
		assert.strictEqual(prec.length, 2, 'the self-ref is not dropped');
		const selfNode = prec.find((n) => n.kind === 'precedent' && n.self);
		assert.ok(selfNode !== undefined && selfNode.kind === 'precedent');
		assert.match(selfNode.label, /self|circular/i);
	});

	test('a formula-extraction error -> a surfaced error node, NOT silently dropped (No-Fallbacks)', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'A1+',
			formulaError: 'unexpected end of formula',
			// even if precedents were somehow passed, the error path replaces them
			precedents: [precedent('S0!A1')],
		}));
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'formulaError']);
		const err = nodes.find((n) => n.kind === 'formulaError');
		assert.ok(err !== undefined && err.kind === 'formulaError');
		assert.strictEqual(err.detail, 'unexpected end of formula');
	});
});

suite('W3 dep-graph model -- Python reactive edge', () => {
	test('a kernel-driven cell -> a "Driven by" section naming the variable + the SQL-deferred note', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: undefined,
			kernelRunning: true,
			pythonOwner: 'price',
		}));
		// focusedCell, [Driven by header, pythonOwner], sqlDeferred  (no formula precedents -> no "no deps")
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'sectionHeader', 'pythonOwner', 'sqlDeferred']);
		const owner = nodes.find((n) => n.kind === 'pythonOwner');
		assert.ok(owner !== undefined && owner.kind === 'pythonOwner');
		assert.strictEqual(owner.variableName, 'price');
		assert.match(owner.label, /price/);
	});

	test('a running kernel with NO owner + a literal cell -> SQL note + explicit "no dependencies"', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: undefined,
			kernelRunning: true,
			pythonOwner: undefined,
		}));
		// The SQL note appears (a runtime exists) but there is no python OWNER section, so the empty-state
		// node still fires (No-Fallbacks): the cell genuinely has no precedents and no driver.
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'sqlDeferred', 'noDependencies']);
	});

	test('an owner is IGNORED when the kernel is not running (no runtime to attribute to)', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: undefined,
			kernelRunning: false,
			// a stale owner must not leak an edge when there is no live kernel
			pythonOwner: 'ghost',
		}));
		assert.deepStrictEqual(kinds(nodes), ['focusedCell', 'noDependencies']);
		assert.ok(!nodes.some((n) => n.kind === 'pythonOwner'), 'no python edge without a kernel');
		assert.ok(!nodes.some((n) => n.kind === 'sqlDeferred'), 'no SQL note without a kernel');
	});

	test('the SQL note never appears without a running kernel', () => {
		const nodes = buildDepGraphNodes(input({ kernelRunning: false }));
		assert.ok(!nodes.some((n) => n.kind === 'sqlDeferred'));
	});
});

suite('W3 dep-graph model -- combined multi-language picture', () => {
	test('a cell with BOTH formula precedents AND a reactive driver shows both sections + SQL note', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'A1+Sheet2!B2',
			precedents: [precedent('S0!A1'), precedent('Sheet2!B2', true)],
			kernelRunning: true,
			pythonOwner: 'model',
		}));
		assert.deepStrictEqual(kinds(nodes), [
			'focusedCell',
			'sectionHeader', // Formula precedents
			'precedent',
			'precedent',
			'sectionHeader', // Driven by
			'pythonOwner',
			'sqlDeferred',
		]);
		// No "no dependencies" node when real edges exist.
		assert.ok(!nodes.some((n) => n.kind === 'noDependencies'));
	});

	test('the section headers are labelled "Formula precedents" and "Driven by"', () => {
		const nodes = buildDepGraphNodes(input({
			focusedFormula: 'A1',
			precedents: [precedent('S0!A1')],
			kernelRunning: true,
			pythonOwner: 'x',
		}));
		const headers = nodes.filter((n) => n.kind === 'sectionHeader').map((n) => n.label);
		assert.deepStrictEqual(headers, ['Formula precedents', 'Driven by']);
	});
});
