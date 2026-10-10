/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c2 M5). The workbench is on screen, and the overlay closed, BEFORE its renderer is asked to
// unload: the unload handshake can wait for the user in the workbench's own DOM (the cancellable progress of a slow backup or
// save, a `custom` dialog style), which nobody can answer behind the terminal view. The bodies of
// QlWorkbenchHost#settleThenCloseHostWindow, #runQuitHandshake and #surfaceForUnload are taken from workbenchHost.ts,
// transpiled with the fork's typescript and run against fakes whose quit stays pending (rows 1-5); row 6 reads the binding of
// the shell's `close` (where the lifecycle service starts the handshake for a quit it did not get from the host window).
// Run from the fork root: `node build/qlhost/check-unload-surface.mjs src/vs/code/electron-main/qlHost`; rc 0 = GREEN.
// Negative: 2319b831ccc's workbenchHost.ts (the handshake is awaited before anything is shown) -> rows 1, 2, 4, 6 RED.
// The run-time proof is package row A4 (quit, window close, update restart; a delayed backup's Cancel).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-unload-surface.mjs <path to src/vs/code/electron-main/qlHost>');
	process.exit(64);
}
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const rows = [];
const problems = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};
const file = join(dir, 'workbenchHost.ts');
const text = readFileSync(file, 'utf8');
const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
let hostClass;
source.forEachChild(node => {
	if (ts.isClassDeclaration(node) && node.name?.text === 'QlWorkbenchHost') {
		hostClass = node;
	}
});
class FakeStore {
	constructor() { this.items = []; }
	add(d) { this.items.push(d); return d; }
	dispose() { this.items.splice(0).forEach(d => d.dispose()); }
}
const method = name => {
	const member = hostClass?.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === name);
	if (!member) {
		return undefined;
	}
	const params = member.parameters.map(p => p.name.getText(source)).join(', ');
	const isAsync = member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
	const js = ts.transpileModule(`${isAsync}function m(${params}) ${member.body.getText(source)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	return new Function('DisposableStore', `${js}; return m;`)(FakeStore);
};
const settle = method('settleThenCloseHostWindow');
const handshake = method('runQuitHandshake');
const surface = method('surfaceForUnload');

/** One host with a pending quit. `events` is the order of everything the methods did to the window, the views and the quit. */
const scene = ({ workbench: hasWorkbench = true, ready = true, shown = 'terminal', overlay = true, destroyed = false }) => {
	const events = [];
	let overlayOpen = overlay;
	let endQuit;
	const workbench = hasWorkbench ? { codeWindow: { isReady: ready }, onDidGone: () => ({ dispose() { } }) } : undefined;
	const terminalHost = {
		window: { isDestroyed: () => destroyed, close: () => events.push('window.close') },
		host: { log: line => events.push(`log ${line}`) },
		overlayOpen: () => overlayOpen,
		closeOverlay: () => { overlayOpen = false; events.push('closeOverlay'); },
		show: name => events.push(`show ${name}`)
	};
	const self = {
		shown,
		closing: true,
		hostMayClose: false,
		deps: {
			gate: { workbench, whenOpeningSettled: async () => { } },
			logService: { info() { }, error() { } },
			lifecycleMainService: { quit: () => { events.push('quit'); return new Promise(resolve => { endQuit = resolve; }); } }
		},
		requireTerminalHost: () => terminalHost,
		showWorkbench: async cause => { events.push(`showWorkbench ${cause}`); },
		settleThenCloseHostWindow: settle,
		runQuitHandshake: handshake,
		surfaceForUnload: surface
	};
	return { self, events, workbench, endQuit: veto => endQuit(veto), overlayOpen: () => overlayOpen };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

if (!settle || !handshake) {
	row('rows 1-5', false, 'QlWorkbenchHost#settleThenCloseHostWindow or #runQuitHandshake not found in workbenchHost.ts');
} else {
	// row 1: the reviewer's case. Terminal shown, overlay open, a ready workbench; the quit handshake stays pending.
	let s = scene({});
	let done = s.self.settleThenCloseHostWindow();
	await turn();
	const pending = s.events.join(' | ');
	const quitAt = s.events.indexOf('quit');
	row('row 1 while the quit handshake is pending the workbench is already shown and the overlay closed (terminal shown, overlay open, ready workbench)',
		quitAt > 0 && s.events.indexOf('show workbench') >= 0 && s.events.indexOf('show workbench') < quitAt && s.events.indexOf('closeOverlay') >= 0 && s.events.indexOf('closeOverlay') < quitAt && s.self.shown === 'workbench' && !s.overlayOpen(),
		`${pending || 'nothing'}; shown=${s.self.shown} overlayOpen=${s.overlayOpen()}`);

	// row 2: the veto leaves the window open and the workbench shown
	s.endQuit(true);
	await done;
	row('row 2 a veto (Cancel) leaves the host window open, closing reset, and the workbench shown',
		!s.events.includes('window.close') && s.self.closing === false && s.self.hostMayClose === false && s.self.shown === 'workbench' && s.events.indexOf('show workbench') < s.events.indexOf('quit'),
		`${s.events.join(' | ')}; closing=${s.self.closing} hostMayClose=${s.self.hostMayClose} shown=${s.self.shown}`);

	// row 3: no veto closes the host window, after the quit
	s = scene({});
	done = s.self.settleThenCloseHostWindow();
	await turn();
	s.endQuit(false);
	await done;
	row('row 3 a quit that was not vetoed closes the host window after the handshake',
		s.events.indexOf('window.close') > s.events.indexOf('quit') && s.events.indexOf('quit') >= 0 && s.self.hostMayClose === true, `${s.events.join(' | ')}; hostMayClose=${s.self.hostMayClose}`);

	// row 4: the workbench is already shown: the overlay still closes, the view is not shown again
	s = scene({ shown: 'workbench' });
	done = s.self.settleThenCloseHostWindow();
	await turn();
	row('row 4 with the workbench already shown the open overlay is still closed before the handshake, and no view is switched',
		s.events.join(' | ') === 'closeOverlay | quit', s.events.join(' | ') || 'nothing');
	s.endQuit(false);
	await done;

	// row 5: a workbench that never signalled ready is not asked anything by the unload, so it is not surfaced; no workbench: the window closes at once
	s = scene({ ready: false });
	done = s.self.settleThenCloseHostWindow();
	await turn();
	const unready = s.events.join(' | ');
	s.endQuit(false);
	await done;
	const none = scene({ workbench: false });
	await none.self.settleThenCloseHostWindow();
	row('row 5 a workbench that is not ready is not surfaced (its unload asks nothing); with no workbench the window closes at once without a quit handshake',
		unready === 'quit' && none.events.join(' | ') === 'window.close', `not ready: ${unready || 'nothing'}; no workbench: ${none.events.join(' | ') || 'nothing'}`);
}

const adoptedAt = text.indexOf('\tadopted(workbench: IAdoptedWorkbench): void {');
const adoptedEnd = adoptedAt < 0 ? -1 : text.indexOf('\n\t}\n', adoptedAt);
const adopted = adoptedAt < 0 || adoptedEnd < 0 ? '' : text.slice(adoptedAt, adoptedEnd);
const bound = /disposables\.add\(Event\.fromNodeEventEmitter\(workbench\.shell, 'close'\)\(\(\) => this\.surfaceForUnload\(workbench, '[^']+'\)\)\);/.test(adopted);
const sync = surface !== undefined && !/\bawait\b/.test(hostClass.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === 'surfaceForUnload').body.getText(source));
row('row 6 adopted() binds the shell\'s close (the lifecycle service\'s unload trigger) to surfaceForUnload, and surfaceForUnload awaits nothing',
	bound && sync, `adopted ${adopted ? 'found' : 'MISSING'}, close bound ${bound}, surfaceForUnload ${surface ? (sync ? 'synchronous' : 'awaits') : 'MISSING'}`);

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-unload-surface: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
