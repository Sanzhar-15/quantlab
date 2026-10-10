/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M8, fork side). The fork's encryption service makes no synchronous `safeStorage` call before
// the terminal host's Keychain phase settled (the client's start makes the launch's first Keychain calls behind its painted
// waiting window; keychain-wait.dtest proves that order). encryptionMainService.ts is transpiled with the fork's typescript and
// driven with fakes (rows 1-4); its source and app.ts are read for the wiring (rows 5-6).
// Run from the fork root: `node build/qlhost/check-keychain-gate.mjs src/vs`; rc 0 = GREEN.
// Negatives: 49e35049609's encryptionMainService.ts -> rows 1-5 RED; 49e35049609's app.ts -> row 6 RED.
// F-PERF-LZ1-1 (row 6's new form): the service is taken in the SYNCHRONOUS createQlStartServices (from the accessor); the hook
// awaits the services, attaches, reports, and holds nothing else (no catch: a rejection fails the start at before-show).
// Negatives: (c) a try/catch around the hook's await -> row 6 RED; (d) a second terminalHostKeychainPhaseSettled() call -> row 6
// RED; (e) adb6f9a0044's app.ts (the synchronous hook) -> row 6 RED.
// Review c1 M1 (row 6's form since): the services are held as an OUTCOME (QlEarlyStart: a promise made with no reject, observed
// at once); the hook awaits `qlStart.services()`, which rethrows a failure; startup()'s catch keeps the failure (`qlStart.fail`)
// and throws it ONCE after the host's start ended; nothing is chained on `qlStart.services()`. Negative: 295dc583a06's app.ts
// (the DeferredPromise, rethrown at once) -> row 6 RED. The behaviour itself: check-lz1-services-failure.mjs.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-keychain-gate.mjs <path to src/vs>');
	process.exit(64);
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

const source = readFileSync(join(vs, 'platform/encryption/electron-main/encryptionMainService.ts'), 'utf8');
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } });
// The module's imports, by specifier: only what its top level and the driven class read
const stubs = {
	'electron': { __esModule: true, default: {} },
	'../../../base/common/platform.js': { isMacintosh: true, isWindows: false },
	'../common/encryptionService.js': { KnownStorageProvider: { keychainAccess: 'keychain_access' }, PasswordStoreCLIOption: { basic: 'basic' } },
	'../../log/common/log.js': { ILogService: () => undefined }
};
const exported = {};
new Function('exports', 'require', outputText)(exported, specifier => {
	if (!Object.hasOwn(stubs, specifier)) {
		throw new Error(`check-keychain-gate: encryptionMainService.ts imports ${specifier}, which this check does not stub`);
	}

	return stubs[specifier];
});
if (typeof exported.EncryptionMainServiceWithElectron !== 'function') {
	console.error('check-keychain-gate: RED: encryptionMainService.ts exports no EncryptionMainServiceWithElectron class');
	process.exit(1);
}

const PLAIN = 'check-plaintext';
const STORED = JSON.stringify(Buffer.from(`c-${PLAIN}`));
function fake() {
	const events = [];
	const safeStorage = {
		isEncryptionAvailable: () => { events.push('call: isEncryptionAvailable'); return true; },
		encryptString: plain => { events.push('call: encryptString'); return Buffer.from(`c-${plain}`); },
		decryptString: bytes => { events.push('call: decryptString'); return bytes.toString().slice(2); }
	};
	const log = { info: message => events.push(`info: ${message}`), error: message => events.push(`error: ${message}`), trace: () => undefined };
	const app = { getName: () => 'CheckApp', commandLine: { getSwitchValue: () => '' } };

	return { events, service: new exported.EncryptionMainServiceWithElectron(safeStorage, app, log) };
}
const calls = events => events.filter(event => event.startsWith('call: '));
const waits = events => events.filter(event => event.endsWith('waits for the terminal host Keychain phase'));
const outcome = promise => Promise.resolve().then(() => promise).then(value => ({ value }), error => ({ error: String(error) }));

const held = fake();
let pending;
let issue = 'none';
try {
	pending = [held.service.isEncryptionAvailable(), held.service.encrypt(PLAIN), held.service.decrypt(STORED)].map(outcome);
} catch (error) {
	issue = String(error);
}
await flush();
row('1 before the phase settled: three operations make no safeStorage call, each logs that it waits',
	issue === 'none' && calls(held.events).length === 0 && waits(held.events).length === 3,
	`threw ${issue}, safeStorage calls ${calls(held.events).length}, wait lines ${waits(held.events).length}`);

const canReport = typeof held.service.terminalHostKeychainPhaseSettled === 'function';
let results = [];
if (canReport && pending) {
	held.service.terminalHostKeychainPhaseSettled();
	results = await Promise.all(pending);
}
row('2 the report releases the waiting operations, in order, with their answers',
	results.length === 3 && results[0].value === true && results[1].value === STORED && results[2].value === PLAIN
	&& calls(held.events).join(',') === 'call: isEncryptionAvailable,call: encryptString,call: decryptString',
	`report method ${canReport}, answers ${JSON.stringify(results.map(result => result.error ?? typeof result.value))}, calls [${calls(held.events).join(', ')}]`);

const before = held.events.length;
const later = canReport ? await outcome(held.service.isEncryptionAvailable()) : { error: 'no report method' };
const laterEvents = held.events.slice(before);
row('3 after the report an operation runs without a wait line', later.value === true && calls(laterEvents).length === 1 && waits(laterEvents).length === 0,
	`answer ${JSON.stringify(later)}, calls ${calls(laterEvents).length}, wait lines ${waits(laterEvents).length}`);

let second = 'no report method';
if (canReport) {
	try {
		held.service.terminalHostKeychainPhaseSettled();
		second = 'accepted';
	} catch (error) {
		second = String(error.message);
	}
}
row('4 a second report throws by name', /the terminal host Keychain phase was already reported settled/.test(second), `second report: ${second}`);

const direct = source.match(/this\.safeStorage\.(isEncryptionAvailable|encryptString|decryptString)\(/g) ?? [];
const gated = ['isEncryptionAvailable', 'encryptString', 'decryptString'].map(operation => {
	const call = source.indexOf(`this.keychainCall('${operation}', () => this.safeStorage.${operation}(`);
	const gate = source.lastIndexOf(`await this.afterTerminalHostKeychainPhase('${operation}');`, call);
	const method = source.lastIndexOf('\n\t}\n', call);

	return `${operation} ${call >= 0 && gate > method && gate < call}`;
});
row('5 every Keychain safeStorage call sits in keychainCall, after its own wait in the same method',
	direct.length === 3 && gated.every(entry => entry.endsWith(' true')), `${direct.length} direct call site(s); gated: ${gated.join(', ')}`);

const app = readFileSync(join(vs, 'code/electron-main/app.ts'), 'utf8');
const startAt = app.indexOf('\tprivate createQlStartServices(accessor: ServicesAccessor, initialProtocolUrls: IInitialProtocolUrls | undefined): QlStartServices {');
const startEnd = startAt < 0 ? -1 : app.indexOf('\n\t}\n', startAt);
const takenAt = app.indexOf('const encryptionMainService = this.requireQlEncryptionMainService(accessor.get(IEncryptionMainService));', startAt);
const synchronous = startAt >= 0 && !app.slice(startAt, startEnd).includes('await ') && app.slice(startAt, startEnd).includes('return { qlWorkbenchHost, encryptionMainService };');
const firstAwait = startEnd;
// Review c1 M1: the outcome holder (QlEarlyStart) makes its promise with no reject; `services()` rethrows the failure; startup()
// hands the holder to the host once, keeps a failure in its catch (no rethrow there), and throws it once the host's start ended
const holderAt = app.indexOf('export class QlEarlyStart<S> {');
const holder = holderAt < 0 ? '' : app.slice(holderAt, app.indexOf('\n}\n', holderAt));
const holderShaped = /this\.settled = new Promise<QlServicesOutcome<S>>\(resolve => \{ settle = resolve; \}\);/.test(holder)
	&& /services\(\): Promise<S> \{\n\t\treturn this\.settled\.then\(outcome => \{\n\t\t\tif \(!outcome\.ready\) \{\n\t\t\t\tthrow outcome\.error;/.test(holder)
	&& !/\.catch\(|\(resolve, reject\)/.test(holder);
const passed = holderShaped && (app.match(/this\.startQlTerminalHost\(qlStart\)/g)?.length ?? 0) === 1 && !/qlStart\.services\(\)\.(then|catch|finally)\(|qlStart\.outcome\(\)\.(then|catch|finally)\(/.test(app)
	&& /\} catch \(error\) \{\n(\t\t\t\/\/[^\n]*\n)*\t\t\tqlStart\.fail\(error\);\n\t\t\}\n/.test(app)
	&& /const started = await qlHost;\n\t\tconst services = await qlStart\.outcome\(\);\n\t\tif \(!services\.ready\) \{\n[\s\S]{0,400}?\t\t\tthrow services\.error;\n\t\t\}/.test(app);
const reports = app.match(/\.terminalHostKeychainPhaseSettled\(\)/g)?.length ?? 0;
const inHook = /onBeforeShow: async started => \{\n\t\t\t\tconst \{ qlWorkbenchHost, encryptionMainService \} = await qlStart\.services\(\);\n\t\t\t\tqlWorkbenchHost\.attach\(started\);\n\t\t\t\tencryptionMainService\.terminalHostKeychainPhaseSettled\(\);\n\t\t\t\}/.test(app);
const required = /private requireQlEncryptionMainService\(service: IEncryptionMainService\): EncryptionMainService \{\n\t\tif \(!\(service instanceof EncryptionMainService\)\) \{\n\t\t\tthrow new Error\(/.test(app);
row('6 app.ts reports the phase once, from onBeforeShow after awaiting the services and the attach, to the registered service taken synchronously',
	startAt >= 0 && takenAt > startAt && takenAt < firstAwait && synchronous && passed && reports === 1 && inHook && required,
	`service taken in the synchronous createQlStartServices ${takenAt > startAt && takenAt < firstAwait && synchronous}, services held as an outcome, rethrown once after the host ended, nothing chained ${passed}, ${reports} report call(s), in onBeforeShow (await, attach, report; nothing else) ${inHook}, instanceof guard ${required}`);

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
