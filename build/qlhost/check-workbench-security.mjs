/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M2 + M3). qlHost/securityPolicy.ts and qlHost/security.ts are transpiled with the fork's
// typescript and run against fake frames and a fake web contents; app.ts is read for its permission wiring.
// M2: navigations and redirects reach only documents the workbench owns (the exact workbench document, webviews it created,
// their own frames). M3: one decision for both permission handlers grants clipboard-sanitized-write and fullscreen to owned
// documents only.
// Run from the fork root: `node build/qlhost/check-workbench-security.mjs src/vs`; rc 0 = GREEN.
// Negatives: (a) securityPolicy.ts whose webview rule is a scheme prefix (`if (document.scheme === policy.webviewScheme)
// return true;` before the path rules) -> rows 2, 4 and 10 RED; (b) security.ts without its `will-redirect` listener -> row 7 RED;
// (c) cf7027a7443's app.ts -> row 11 RED; (d) QL_GRANTED_PERMISSIONS with 'clipboard-read' added -> row 9 RED.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-workbench-security.mjs <path to src/vs>');
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
const read = rel => readFileSync(join(vs, rel), 'utf8');
const transpile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = (rel, modules) => {
	const exports = {};
	new Function('exports', 'require', transpile(read(rel)))(exports, id => {
		if (id in modules) {
			return modules[id];
		}
		throw new Error(`${rel} requires ${id} at run time`);
	});
	return exports;
};

const policyMod = load('code/electron-main/qlHost/securityPolicy.ts', {});
const policy = {
	workbenchDocument: 'vscode-file://vscode-app/Applications/QuantLab Host.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
	webviewScheme: 'vscode-webview'
};
const WORKBENCH = `${policy.workbenchDocument}?windowId=1`;
const frame = (url, parent = null) => ({ url, parent });
const top = frame(WORKBENCH);
const index = frame('vscode-webview://0a1b2c/index.html?id=w1&parentId=1', top);
const fake = frame('vscode-webview://0a1b2c/fake.html?id=w1', index);
const blankInFake = frame('about:blank', fake);
const nestedIndex = frame('vscode-webview://9z9z9z/index.html?id=w2', fake);
const foreignTop = frame('https://evil.example/');
const indexUnderForeign = frame('vscode-webview://0a1b2c/index.html?id=w3', foreignTop);
const httpsInFake = frame('https://evil.example/page', fake);
const nav = (url, isMainFrame, f) => policyMod.isAllowedNavigation(url, isMainFrame, f, policy);
const sub = (url, parent) => nav(url, false, { url: '', parent });

const expectAll = (name, cases, want) => {
	const wrong = cases.filter(([, got]) => got !== want).map(([label]) => label);
	row(name, wrong.length === 0, wrong.length === 0 ? `${cases.length} cases ${want ? 'allowed' : 'denied'}` : `${want ? 'denied' : 'allowed'}: ${wrong.join('; ')}`);
};

// ---- M2: navigations
expectAll('1 owned navigations allowed', [
	['main frame -> workbench document (query)', nav(`${policy.workbenchDocument}?windowId=2#x`, true, top)],
	['webview index.html under the workbench', sub('vscode-webview://0a1b2c/index.html?id=w1', top)],
	['fake.html under its own index.html', sub('vscode-webview://0a1b2c/fake.html?id=w1', index)],
	['about:blank under fake.html', sub('about:blank', fake)],
	['about:srcdoc under index.html', sub('about:srcdoc', index)],
	['about:blank under the workbench', sub('about:blank', top)],
	['about:srcdoc under a blank frame of fake.html', sub('about:srcdoc', blankInFake)]
], true);
expectAll('2 unregistered vscode-webview documents denied', [
	['index.html nested in a webview', sub('vscode-webview://9z9z9z/index.html?id=w2', fake)],
	['index.html under a foreign top frame', sub('vscode-webview://0a1b2c/index.html?id=w3', foreignTop)],
	['fake.html of another authority', sub('vscode-webview://9z9z9z/fake.html?id=w1', index)],
	['fake.html directly under the workbench', sub('vscode-webview://0a1b2c/fake.html?id=w1', top)],
	['fake.html under a nested (unregistered) index.html', sub('vscode-webview://9z9z9z/fake.html?id=w2', nestedIndex)],
	['another webview path', sub('vscode-webview://0a1b2c/other.html', top)]
], false);
expectAll('3 foreign destinations inside a webview denied', [
	['https under fake.html', sub('https://evil.example/page', fake)],
	['https under index.html', sub('https://evil.example/page', index)],
	['vscode-file under fake.html', sub(policy.workbenchDocument, fake)],
	['data: under fake.html', sub('data:text/html,x', fake)]
], false);
expectAll('4 unowned about:blank / about:srcdoc denied', [
	['about:blank under an https frame in a webview', sub('about:blank', httpsInFake)],
	['about:srcdoc under a nested (unregistered) index.html', sub('about:srcdoc', nestedIndex)],
	['about:blank under a webview of a foreign top', sub('about:blank', indexUnderForeign)],
	['about:blank under a foreign top', sub('about:blank', foreignTop)]
], false);
expectAll('5 top frame to anything but the workbench document denied', [
	['another path under vscode-app', nav('vscode-file://vscode-app/Applications/QuantLab Host.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/other.html', true, top)],
	['workbench-dev.html when the document is workbench.html', nav(policy.workbenchDocument.replace('workbench.html', 'workbench-dev.html'), true, top)],
	['another authority', nav(policy.workbenchDocument.replace('vscode-app', 'vscode-other'), true, top)],
	['https', nav('https://evil.example/', true, top)],
	['about:blank as top', nav('about:blank', true, top)]
], false);
expectAll('6 sub-frame navigation with no reported frame or parent denied', [
	['frame null', nav('about:blank', false, null)],
	['frame without parent', nav('about:blank', false, { url: '', parent: null })]
], false);

// ---- M2: the wiring of security.ts (navigations and redirects, both frames)
{
	const securityMod = load('code/electron-main/qlHost/security.ts', {
		'../../../base/common/lifecycle.js': { toDisposable: fn => ({ dispose: fn }) },
		'./securityPolicy.js': policyMod
	});
	const contents = new EventEmitter();
	contents.setWindowOpenHandler = () => undefined;
	const logged = [];
	const disposable = securityMod.secureWorkbenchContents(contents, {
		logService: { error: line => logged.push(line), trace: () => undefined },
		policy,
		openExternal: () => undefined
	});
	const fire = (event, url, isMainFrame, f) => {
		let prevented = false;
		contents.emit(event, { url, isMainFrame, frame: f, preventDefault: () => { prevented = true; } });
		return prevented;
	};
	const results = [
		['navigation, owned sub-frame', fire('will-frame-navigate', 'vscode-webview://0a1b2c/fake.html?id=w1', false, { url: '', parent: index }), false],
		['navigation, https in a webview', fire('will-frame-navigate', 'https://evil.example/', false, { url: '', parent: fake }), true],
		['navigation, main frame elsewhere', fire('will-frame-navigate', 'https://evil.example/', true, top), true],
		['redirect, owned main frame', fire('will-redirect', WORKBENCH, true, top), false],
		['redirect, https in a webview', fire('will-redirect', 'https://evil.example/r', false, { url: '', parent: fake }), true],
		['redirect, main frame elsewhere', fire('will-redirect', 'https://evil.example/r', true, top), true]
	];
	const wrong = results.filter(([, got, want]) => got !== want).map(([label, got]) => `${label} prevented=${got}`);
	const named = logged.length === 4 && logged.filter(line => line.includes('redirect to https://evil.example/r')).length === 2;
	disposable.dispose();
	const left = contents.listenerCount('will-frame-navigate') + contents.listenerCount('will-redirect');
	row('7 security.ts guards navigations and redirects', wrong.length === 0 && named && left === 0,
		`${wrong.length === 0 ? '6 events decided as the policy' : wrong.join('; ')}; ${logged.length} blocked lines (named redirects ${named}); listeners after dispose ${left}`);
}

// ---- M3: one permission decision
const contentsOf = (mainFrame, frames) => ({ mainFrame: { ...mainFrame, framesInSubtree: [mainFrame, ...frames] } });
const workbenchContents = contentsOf(top, [index, fake, blankInFake, nestedIndex, httpsInFake]);
const grant = (contents, permission, requestingUrl, isMainFrame) => policyMod.isGrantedPermission(contents, permission, requestingUrl, isMainFrame, policy);
const GRANTED = ['clipboard-sanitized-write', 'fullscreen'];
const OTHERS = ['pointerLock', 'clipboard-read', 'deprecated-sync-clipboard-read', 'local-fonts', 'media', 'notifications', 'keyboardLock', 'geolocation', 'display-capture', 'openExternal', 'fileSystem', 'window-management'];
const owned = [['workbench', WORKBENCH, true], ['index.html', index.url, false], ['fake.html', fake.url, false]];
expectAll('8 owned documents granted clipboard-sanitized-write and fullscreen', owned.flatMap(([label, url, isMainFrame]) => GRANTED.map(p => [`${p} ${label}`, grant(workbenchContents, p, url, isMainFrame)])), true);
expectAll('9 every other permission denied to owned documents', owned.flatMap(([label, url, isMainFrame]) => OTHERS.map(p => [`${p} ${label}`, grant(workbenchContents, p, url, isMainFrame)])), false);
{
	const shared = frame('vscode-webview://0a1b2c/fake.html?id=w1', nestedIndex);
	expectAll('10 foreign, unregistered and non-workbench requesters denied', GRANTED.flatMap(p => [
		[`${p} https frame in a webview`, grant(workbenchContents, p, httpsInFake.url, false)],
		[`${p} nested index.html`, grant(workbenchContents, p, nestedIndex.url, false)],
		[`${p} URL in no frame`, grant(workbenchContents, p, 'vscode-webview://0a1b2c/fake.html?id=other', false)],
		[`${p} URL shared by an owned and an unowned frame`, grant(contentsOf(top, [index, fake, nestedIndex, shared]), p, fake.url, false)],
		[`${p} main frame claiming another document`, grant(workbenchContents, p, 'https://evil.example/', true)],
		[`${p} contents whose top is not the workbench`, grant(contentsOf(foreignTop, [indexUnderForeign]), p, indexUnderForeign.url, false)],
		[`${p} null contents`, grant(null, p, WORKBENCH, true)],
		[`${p} no requesting URL`, grant(workbenchContents, p, undefined, true)]
	]), false);
}

// ---- M3: app.ts uses the decision in both handlers and keeps no other permission set
{
	const app = read('code/electron-main/app.ts');
	const body = app.slice(app.indexOf('private configureSession(): void {'), app.indexOf('//#region Request filtering'));
	const request = /setPermissionRequestHandler\([^]*?isGrantedPermission\(webContents, permission, details\.requestingUrl, details\.isMainFrame, framePolicy\)[^]*?callback\(granted\)/.test(body);
	const check = /setPermissionCheckHandler\([^]*?return isGrantedPermission\(webContents, permission, details\.requestingUrl, details\.isMainFrame, framePolicy\);/.test(body);
	const stale = ['allowedPermissionsIn', 'alwaysAllowedPermissions', 'isUrlFromWebview', 'isUrlFromWindow', `'clipboard-read'`, `'local-fonts'`, `'pointerLock'`].filter(token => body.includes(token));
	const windowImpl = read('platform/windows/electron-main/windowImpl.ts');
	const doc = 'FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? \'\' : \'-dev\'}.html`).toString(true)';
	const sameDocument = app.includes(`workbenchDocument: ${doc}`) && windowImpl.includes(`windowUrl = ${doc}`);
	const hostPolicy = /framePolicy: this\.qlFramePolicy\(\)/.test(app);
	row('11 app.ts: both handlers call isGrantedPermission, no other set, workbench document as windowImpl loads it', request && check && stale.length === 0 && sameDocument && hostPolicy,
		`request ${request}, check ${check}, stale tokens [${stale.join(', ')}], same document ${sameDocument}, host gets the policy ${hostPolicy}`);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
