/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 S3): toggle presses during the workbench's first-use wait keep their intent. toggleSequencer.ts
// (no imports) is transpiled with the fork's typescript and driven by a fake host whose first workbench use waits on a
// deferred readiness; the wiring is read from workbenchHost.ts (toggle() goes through the sequencer; no target chosen at receipt).
// Run from the fork root: `node build/qlhost/check-toggle-sequencer.mjs src/vs/code/electron-main/qlHost`; rc 0 = GREEN.
// Negative (plant): the sequencer choosing `to` at the key's receipt (before `tail.then`) -> rc 1, row 1 RED (row 2 stays
// GREEN: three presses that all choose the workbench still end on it). With 7e55be1b9cb's workbenchHost.ts: row 4 RED.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-toggle-sequencer.mjs <path to src/vs/code/electron-main/qlHost>');
	process.exit(64);
}
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const { outputText } = ts.transpileModule(readFileSync(join(dir, 'toggleSequencer.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exported = {};
new Function('exports', outputText)(exported);
if (typeof exported.createToggleSequencer !== 'function') {
	console.error('check-toggle-sequencer: RED: toggleSequencer.ts exports no createToggleSequencer function');
	process.exit(1);
}

const rows = [];
const problems = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};
const flush = async () => { for (let i = 0; i < 20; i += 1) { await new Promise(resolve => setImmediate(resolve)); } };

/** A host whose first workbench use waits until `ready()`; `failNext` makes the next transition reject. */
function fakeHost() {
	const state = { shown: 'terminal', constructions: 0, queued: 0, built: false, failNext: false };
	let release;
	const readiness = new Promise(resolve => { release = resolve; });
	const sequencer = exported.createToggleSequencer({
		shown: () => state.shown,
		queued: () => { state.queued += 1; },
		apply: async to => {
			if (state.failNext) {
				state.failNext = false;
				throw new Error('planted failure');
			}
			if (to === 'workbench') {
				if (!state.built) {
					state.built = true;
					state.constructions += 1;
				}
				await readiness;
			}
			state.shown = to;
		}
	});

	return { state, sequencer, ready: () => release() };
}

async function presses(count) {
	const host = fakeHost();
	const results = [];
	for (let i = 0; i < count; i += 1) {
		results.push(host.sequencer.toggle());
	}
	await flush();
	host.ready();
	await Promise.all(results);

	return host.state;
}

const two = await presses(2);
row('row 1 two presses during first-use readiness end on the terminal, one construction', two.shown === 'terminal' && two.constructions === 1 && two.queued === 1, `shown=${two.shown} constructions=${two.constructions} queued=${two.queued}`);
const three = await presses(3);
row('row 2 three presses end on the workbench, one construction', three.shown === 'workbench' && three.constructions === 1 && three.queued === 2, `shown=${three.shown} constructions=${three.constructions} queued=${three.queued}`);

const failing = fakeHost();
failing.ready();
failing.state.failNext = true;
const first = failing.sequencer.toggle();
const second = failing.sequencer.toggle();
const firstOutcome = await first.then(() => 'resolved', error => `rejected: ${error.message}`);
const secondOutcome = await second;
row('row 3 a failed transition rejects its own call; the next still runs from the view on screen', firstOutcome === 'rejected: planted failure' && secondOutcome === 'workbench' && failing.state.shown === 'workbench', `first=${firstOutcome} second=${secondOutcome} shown=${failing.state.shown}`);

const host = readFileSync(join(dir, 'workbenchHost.ts'), 'utf8');
const viaSequencer = /async toggle\(\): Promise<void> \{\n\t\tawait this\.toggles\.toggle\(\);\n\t\}/.test(host);
const atReceipt = /const to = this\.shown === 'terminal'/.test(host);
row('row 4 workbenchHost.toggle() goes through the sequencer; no target chosen at receipt', viaSequencer && !atReceipt, `viaSequencer=${viaSequencer} chosenAtReceipt=${atReceipt}`);

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-toggle-sequencer: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-toggle-sequencer: GREEN: queued presses keep their intent; one construction; a failure stays with its press');
