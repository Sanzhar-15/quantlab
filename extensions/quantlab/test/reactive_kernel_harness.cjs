/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5-1d-0 -- headless-in-extension harness for ReactiveKernelClient.
//
// Proves the COMPILED in-extension client (`out/src/quantbook/reactiveKernel/reactiveKernelClient.js`)
// drives a REAL ipykernel (via the relocated supervisor) and applies republishes to a napi Session --
// the same acid#1 transport as the 1c-1/1c-2 spike, but now through the extension's own TS client and
// CURSOR-LESS (the client never threads a version; this harness reads ground truth via session.cell).
//
// Standalone, Mac-run (needs the dylib + a Python with ipykernel/jupyter_client/pyzmq/comm) -- NOT in
// the mocha auto-suite (which lacks those deps), mirroring the 1c-* spike discipline.
//
// Run:
//   QL_NODE_CDYLIB=<engine>/target/release/libql_bindings_node.dylib \
//   QL_KERNEL_PYTHON=$HOME/.fe15-spike-venv/bin/python3.12 \
//   node extensions/quantlab/test/reactive_kernel_harness.cjs

'use strict';
const path = require('node:path');

const HERE = __dirname;
const EXT_ROOT = path.resolve(HERE, '..');
const CLIENT = path.join(EXT_ROOT, 'out', 'src', 'quantbook', 'reactiveKernel', 'reactiveKernelClient.js');
const PYTHONPATH_MOD = path.join(EXT_ROOT, 'out', 'src', 'qviz', 'pythonPath.js');
const SUPERVISOR = path.join(EXT_ROOT, 'python', 'reactive_kernel', 'reactive_kernel_supervisor.py');

function resolveCdylib() {
	if (process.env.QL_NODE_CDYLIB) {
		return process.env.QL_NODE_CDYLIB;
	}
	throw new Error('set QL_NODE_CDYLIB to libql_bindings_node.dylib');
}
function resolveKernelPython() {
	// No-Fallbacks (CLAUDE.md): require an explicit interpreter; do not silently fall back to a venv
	// guess or a bare `python3` (which may lack ipykernel/jupyter_client/pyzmq/comm).
	if (process.env.QL_KERNEL_PYTHON) {
		return process.env.QL_KERNEL_PYTHON;
	}
	throw new Error('set QL_KERNEL_PYTHON to a Python with ipykernel/jupyter_client/pyzmq/comm');
}

const { ReactiveKernelClient } = require(CLIENT);
// FE-1.5-1d-2: spawn under the EXACT hardened env the shipped factory uses (scrubs PYTHONPATH/
// PYTHONHOME, disables user site-packages) -- so this harness proves the kernel's deps resolve under
// the scrub, not just under an unhardened inherited env.
const { buildReactiveKernelEnv } = require(PYTHONPATH_MOD);

// napi Session -- owned HERE (throwaway), exactly like the shipped CellGridPanel owns one.
const mod = { exports: {} };
process.dlopen(mod, resolveCdylib());
const { Session } = mod.exports;
const s = new Session();
const sheetIds = new Map();

function colLetters(letters) {
	let col = 0;
	for (const ch of letters.toUpperCase()) {
		col = col * 26 + (ch.charCodeAt(0) - 64);
	}
	return col - 1;
}
function a1Cell(ref) {
	const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
	if (!m) {
		throw new Error(`malformed A1 cell: ${ref}`);
	}
	const row = parseInt(m[2], 10);
	if (row < 1) {
		throw new Error(`A1 row must be >= 1: ${ref}`);
	}
	return { row: row - 1, col: colLetters(m[1]) };
}
// The injected resolveTarget: "Bench!A1:C3" -> CellRangeJson on this Session's sheets.
function resolveTarget(a1) {
	const bang = a1.indexOf('!');
	if (bang < 0) {
		throw new Error(`target must be sheet-qualified: ${a1}`);
	}
	const name = a1.slice(0, bang);
	const ref = a1.slice(bang + 1);
	if (!sheetIds.has(name)) {
		throw new Error(`unknown sheet in target: ${name}`);
	}
	const sheet = sheetIds.get(name);
	let a, b;
	if (ref.includes(':')) {
		const [x, y] = ref.split(':', 2);
		a = a1Cell(x);
		b = a1Cell(y);
	} else {
		a = a1Cell(ref);
		b = a;
	}
	return { sheet, startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
}

function groundNum(sheet, row, col) {
	const c = s.cell(sheet, row, col);
	return c && c.value ? c.value.number : null;
}
function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

async function main() {
	const sheet = s.addSheet('Bench', 1000);
	sheetIds.set('Bench', sheet);
	s.setFormula(sheet, 0, 2, 'B1*2'); // C1
	s.setFormula(sheet, 0, 3, 'B1+100'); // D1
	s.setFormula(sheet, 2, 3, 'A3+B3+C3'); // D3
	s.setFormula(sheet, 4, 5, '1+1'); // F5 -- a user FORMULA (the G3 target)
	s.recalcDirty();

	let changedCount = 0;
	const errors = [];
	const client = new ReactiveKernelClient({
		pythonPath: resolveKernelPython(),
		supervisorScript: SUPERVISOR,
		env: buildReactiveKernelEnv(),
		session: s,
		resolveTarget,
		onChanged: () => {
			changedCount++;
		},
		onError: (m) => {
			errors.push(m);
		},
	});
	await client.start();

	// ===== B -- first publish; the same-cell hook is QUIET (no double-fire); onChanged fires once =====
	let before = changedCount;
	let r = await client.execute('x = 0\nqb.publish("x", x, "Bench!B1", owner_cell_id="cellX")');
	assert(r.republishCount === 1, `B: expected 1 republish, got ${r.republishCount}`);
	assert(groundNum(sheet, 0, 1) === 0 && groundNum(sheet, 0, 2) === 0 && groundNum(sheet, 0, 3) === 100, 'B: B1/C1/D1 = 0/0/100');
	assert(changedCount === before + 1, `B: onChanged must fire exactly once (got ${changedCount - before})`);

	// ===== C -- reassign -> hook fires in the REAL kernel -> C1 AND D1 recompute (FAN-OUT) =====
	r = await client.execute('x = 7');
	assert(r.republishCount === 1, `C: expected 1 republish, got ${r.republishCount}`);
	assert(groundNum(sheet, 0, 1) === 7 && groundNum(sheet, 0, 2) === 14 && groundNum(sheet, 0, 3) === 107, 'C: ground 7/14/107 (fan-out)');

	// ===== negatives -- kernel-quiet (no republish frame), onChanged NOT fired =====
	before = changedCount;
	r = await client.execute('z = x + 1');
	assert(r.republishCount === 0, 'neg-readonly: must be quiet');
	r = await client.execute('w = 99');
	assert(r.republishCount === 0, 'neg-unrelated: must be quiet');
	r = await client.execute('x = 7');
	assert(r.republishCount === 0, 'neg-samevalue: must be quiet');
	assert(changedCount === before, `neg: onChanged must NOT fire on quiet cells (got ${changedCount - before})`);

	// ===== G -- mutate-in-place (the 1b detector) across the real kernel =====
	r = await client.execute('vec = [10, 20, 30]\nqb.publish("vec", vec, "Bench!A3:C3", owner_cell_id="cellV")');
	assert(r.republishCount === 1 && groundNum(sheet, 2, 3) === 60, 'G-publish: D3=60');
	r = await client.execute('vec[1] = 99');
	assert(r.republishCount === 1 && groundNum(sheet, 2, 3) === 139, 'G-mutate: D3=139');

	// ===== FAIL -- a raising cell is FATAL to the cell (surfaced), kernel survives =====
	let raised = null;
	try {
		await client.execute('raise RuntimeError("boom-1d0")');
	} catch (e) {
		raised = e;
	}
	assert(raised && /boom-1d0/.test(raised.message), `FAIL: raising cell must surface as an error, got ${raised && raised.message}`);
	assert(errors.some((m) => /boom-1d0/.test(m)), 'FAIL: the error must reach onError (No-Fallbacks)');
	r = await client.execute('x = 12');
	assert(groundNum(sheet, 0, 2) === 24, 'FAIL-recover: kernel survives; C1=24');

	// ===== PUBLISH-THEN-RAISE (Codex HIGH-1) -- a cell that mutates a published var THEN raises must
	// STILL repaint (the post_run_cell hook republishes before the error surfaces), not leave the grid
	// stale. The error must still surface. =====
	before = changedCount;
	let ptr = null;
	try {
		await client.execute('x = 50\nraise RuntimeError("after-publish-1d0")');
	} catch (e) {
		ptr = e;
	}
	assert(ptr && /after-publish-1d0/.test(ptr.message), `publish-then-raise: the error must still surface, got ${ptr && ptr.message}`);
	assert(groundNum(sheet, 0, 2) === 100, `publish-then-raise: the pre-raise republish must APPLY (C1=100, x=50), got ${groundNum(sheet, 0, 2)}`);
	assert(changedCount === before + 1, `publish-then-raise: onChanged must fire for the applied republish despite the raise (got ${changedCount - before})`);

	// ===== G1/G2 -- kernel-side guard rejects propagate over the wire as a cell error =====
	await client.execute('qb.publish("dup", 5, "Bench!E1", owner_cell_id="cellDup")');
	let g1 = null;
	try {
		await client.execute('qb.publish("dup", 9, "Bench!E1", owner_cell_id="other")');
	} catch (e) {
		g1 = e;
	}
	assert(g1 && /already published/.test(g1.message), `G1: duplicate reject must reach host, got ${g1 && g1.message}`);
	let g2 = null;
	try {
		await client.execute('qb.publish("rangeB", [9, 9], "Bench!A3:B3", owner_cell_id="cellB")');
	} catch (e) {
		g2 = e;
	}
	assert(g2 && /overlaps/.test(g2.message), `G2: overlap reject must reach host, got ${g2 && g2.message}`);

	// ===== G3 -- host REFUSES to overwrite a user FORMULA (F5) unless overwrite=True =====
	before = changedCount;
	r = await client.execute('qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF")');
	assert(r.republishCount === 0 && r.refused.length === 1, `G3: host must REFUSE to clobber F5, got refused=${JSON.stringify(r.refused)} republished=${r.republishCount}`);
	assert(s.cell(sheet, 4, 5).formula !== undefined, 'G3: F5 must still be a formula after the refusal');
	assert(changedCount === before, 'G3: a pure refusal must not fire onChanged');
	assert(errors.some((m) => /refused/.test(m)), 'G3: the refusal must reach onError (surfaced, not silent)');
	// same name + owner + overwrite=True: G1 allows the same-owner re-run, host applies, F5 replaced.
	r = await client.execute('qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF", overwrite=True)');
	assert(r.republishCount === 1 && r.refused.length === 0 && groundNum(sheet, 4, 5) === 0 && s.cell(sheet, 4, 5).formula === undefined, `G3: overwrite=True must replace F5's formula with 0, got republished=${r.republishCount} F5=${groundNum(sheet, 4, 5)}`);

	// ===== R7 -- undo reverts the grid; force_check heals on the NEXT touch (the host drives undo) =====
	r = await client.execute('x = 8');
	assert(groundNum(sheet, 0, 1) === 8 && groundNum(sheet, 0, 2) === 16, 'R7 setup: B1/C1=8/16');
	const undoRes = s.undo();
	assert(undoRes.consumed === true, `R7: undo must be consumed, got ${JSON.stringify(undoRes)}`);
	s.recalcDirty();
	assert(groundNum(sheet, 0, 1) !== 8, `R7: undo must revert B1 away from 8 (got ${groundNum(sheet, 0, 1)})`);
	await client.epochChange(); // signal the kernel: mark force_check on every binding
	// an UNRELATED cell must NOT consume the force_check (it's "next TOUCHED var", not "next cell")
	r = await client.execute('u = 1');
	assert(r.republishCount === 0, `R7: an unrelated cell must not republish, got ${r.republishCount}`);
	assert(groundNum(sheet, 0, 1) !== 8, 'R7: an unrelated cell must not heal the grid');
	// touching x heals: fingerprint unchanged (still 8) BUT force_check -> republish -> grid heals.
	r = await client.execute('y = x');
	assert(r.republishCount === 1, `R7: y=x must force a republish despite an unchanged fingerprint, got ${r.republishCount}`);
	assert(groundNum(sheet, 0, 1) === 8 && groundNum(sheet, 0, 2) === 16, 'R7: force_check healed B1/C1 to 8/16');
	r = await client.execute('z2 = x');
	assert(r.republishCount === 0, 'R7: force_check must clear after the heal (a later same-value touch is quiet)');

	// ---- clean shutdown ----
	await client.close();

	console.log('[reactive-kernel-harness 1d-0] PASS -- acid#1 transport through the in-extension ReactiveKernelClient');
	console.log('  B/C   publish + reassign -> hook fires in the REAL kernel -> C1=14 AND D1=107 (fan-out)');
	console.log('  neg   z=x+1 / w=99 / x=7 -> 0 frames (kernel-quiet), onChanged not fired');
	console.log('  G     vec[1]=99          -> mutate-in-place across the real kernel -> D3=139');
	console.log('  FAIL  raise              -> cell error surfaced via onError; kernel survives -> C1=24');
	console.log('  PTR   x=50; raise        -> publish-then-raise STILL repaints (C1=100) + error surfaces (HIGH fold)');
	console.log('  G1/G2 dup / overlap      -> kernel-side guard rejects propagate over the wire');
	console.log('  G3    publish over F5     -> host REFUSES (surfaced, rolled back); overwrite=True replaces it');
	console.log('  R7    x=8; undo; u=1; y=x -> epoch force_check: u=1 no overfire; y=x heals C1=16');
	console.log(`  (onChanged fired ${changedCount}x total; cursor-less -- ground truth via session.cell)`);
	process.exit(0);
}

main().catch((e) => {
	console.error(`[reactive-kernel-harness 1d-0] FAIL: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
