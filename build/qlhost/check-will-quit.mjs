/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M6): a second quit while the shutdown joiners are pending does not exit; after they settle
// exactly one quit goes through, with one shutdown sequence. The guard (willQuitGuard.ts, no imports) is transpiled with the
// fork's typescript and run against a fake `electron.app` that models Electron's quit: `quit()` emits `will-quit`, and the app
// exits unless a listener called `preventDefault()`. The wiring is read from lifecycleMainService.ts: the guard is installed
// and no `once('will-quit'` remains.
// Run from the fork root: `node build/qlhost/check-will-quit.mjs src/vs/platform/lifecycle/electron-main`; rc 0 = GREEN.
// Negative (the plant): the guard's `app.addListener('will-quit', listener)` replaced by a once-style registration (the stock
// behaviour) -> rc 1 naming row 2 (the second quit exits under the pending joiner).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-will-quit.mjs <path to src/vs/platform/lifecycle/electron-main>');
	process.exit(64);
}
const require = createRequire(join(process.cwd(), 'package.json'));
const ts = require('typescript');

const problems = [];

// 1. the wiring
const service = readFileSync(join(dir, 'lifecycleMainService.ts'), 'utf8');
if (/\.once\(\s*'will-quit'/.test(service)) {
	problems.push(`wiring: lifecycleMainService.ts still registers a once('will-quit') listener`);
}
const installs = service.split('\n').filter(line => /^\t\tinstallWillQuitGuard\(electron\.app, \{$/.test(line)).length;
if (installs !== 1) {
	problems.push(`wiring: expected exactly 1 \`installWillQuitGuard(electron.app, {\` in registerListeners, found ${installs}`);
}

// 2. the behaviour
const source = readFileSync(join(dir, 'willQuitGuard.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exportsObject = {};
new Function('exports', outputText)(exportsObject);
const { installWillQuitGuard } = exportsObject;
if (typeof installWillQuitGuard !== 'function') {
	console.error('check-will-quit: RED: willQuitGuard.ts exports no installWillQuitGuard function');
	process.exit(1);
}

function fakeApp() {
	const listeners = [];
	const app = {
		exits: 0,
		addListener(event, listener) {
			if (event !== 'will-quit') {
				throw new Error(`fake app: unexpected event ${event}`);
			}
			listeners.push({ listener, once: false });
		},
		once(event, listener) {
			if (event !== 'will-quit') {
				throw new Error(`fake app: unexpected event ${event}`);
			}
			listeners.push({ listener, once: true });
		},
		removeListener(event, listener) {
			const index = listeners.findIndex(entry => entry.listener === listener);
			if (index >= 0) {
				listeners.splice(index, 1);
			}
		},
		get listenerCount() {
			return listeners.length;
		},
		quit() {
			let prevented = false;
			const event = { preventDefault: () => { prevented = true; } };
			for (const entry of [...listeners]) {
				if (entry.once) {
					app.removeListener('will-quit', entry.listener);
				}
				entry.listener(event);
			}
			if (!prevented) {
				app.exits += 1;
			}
		}
	};

	return app;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const app = fakeApp();
let shutdowns = 0;
let finalQuits = 0;
let releaseJoiner;
const trace = [];
installWillQuitGuard(app, {
	startShutdown: () => {
		shutdowns += 1;

		return new Promise(resolve => { releaseJoiner = resolve; });
	},
	beforeFinalQuit: () => { finalQuits += 1; },
	trace: message => trace.push(message)
});

const rows = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};

app.quit();
row('row 1 first quit is prevented and starts one shutdown', app.exits === 0 && shutdowns === 1, `exits=${app.exits} shutdowns=${shutdowns} listeners=${app.listenerCount}`);

app.quit();
await flush();
row('row 2 a second quit while the joiner is pending does not exit', app.exits === 0 && shutdowns === 1, `exits=${app.exits} shutdowns=${shutdowns} listeners=${app.listenerCount}`);

releaseJoiner();
await flush();
await flush();
row('row 3 after the joiner settles exactly one quit exits', app.exits === 1 && shutdowns === 1 && finalQuits === 1, `exits=${app.exits} shutdowns=${shutdowns} finalQuits=${finalQuits}`);
row('row 4 the listener is removed after the final quit', app.listenerCount === 0, `listeners=${app.listenerCount}`);

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-will-quit: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-will-quit: GREEN: a second quit is prevented under a pending joiner; one shutdown; one final exit');
