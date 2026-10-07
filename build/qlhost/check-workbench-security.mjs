/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M2 + M3, c2 M2 + M3). qlHost/securityPolicy.ts, qlHost/webviewRegistry.ts and
// qlHost/security.ts are transpiled with the fork's typescript and run against fake frames and a fake web contents; app.ts,
// the webview manager service and the workbench's webview element are read for their wiring.
// M2: navigations and redirects reach only documents the workbench owns (the exact workbench document, webviews it REGISTERED
// - a frame bound to a registration, never ancestry alone: rows 12-18 -, their own frames). M3: one decision for both permission handlers grants clipboard-sanitized-write and fullscreen to owned
// documents only.
// Run from the fork root: `node build/qlhost/check-workbench-security.mjs src/vs`; rc 0 = GREEN.
// Negatives: (a) securityPolicy.ts whose webview rule is a scheme prefix (`if (document.scheme === policy.webviewScheme)
// return true;` before the path rules) -> rows 2, 4 and 10 RED; (b) security.ts without its `will-redirect` listener -> row 7 RED;
// (c) cf7027a7443's app.ts -> row 11 RED; (d) QL_GRANTED_PERMISSIONS with 'clipboard-read' added -> row 9 RED;
// (e) c2: ancestry as registration (isOwnedFrame's index.html rule and isAllowedNavigation's index.html rule both reduced to
// `return isWorkbenchFrame(parent, policy);`) -> rows 2, 7, 10, 10a, 12, 13, 14, 15, 16 RED;
// (f) the `await this.qlRegisterFrame(encodedWebviewOrigin, targetWindow);` line removed from browser/webviewElement.ts ->
// row 18 RED; (g) webviewRegistry.ts `bind` without its live-frame test (the `const bound` line and its `if` block) ->
// rows 13, 16 RED.
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
const count = (text, pattern) => [...text.matchAll(pattern)].length;
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
const registryMod = load('code/electron-main/qlHost/webviewRegistry.ts', {});
const registry = new registryMod.QlWebviewRegistry();
const policy = {
	workbenchDocument: 'vscode-file://vscode-app/Applications/QuantLab Host.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
	webviewScheme: 'vscode-webview',
	webviews: contents => registry.of(contents)
};
const WORKBENCH = `${policy.workbenchDocument}?windowId=1`;
let nextFrameId = 100;
const frame = (url, parent = null, name = '') => ({ url, parent, name, frameTreeNodeId: nextFrameId++ });
const contentsOf = (mainFrame, frames) => ({ mainFrame: { ...mainFrame, framesInSubtree: [mainFrame, ...frames] } });
const top = frame(WORKBENCH);
// w1 is registered by the workbench and bound by its first navigation (row 1); the frame the workbench never registered
// has the same parent and would load the same document (rows 2, 12)
const index = frame('', top, 'w1');
const unregisteredIndex = frame('vscode-webview://0a1b2c/index.html?id=w1&parentId=1', top, 'not-registered');
const fake = frame('vscode-webview://0a1b2c/fake.html?id=w1', index);
const blankInFake = frame('about:blank', fake);
const nestedIndex = frame('vscode-webview://9z9z9z/index.html?id=w2', fake);
const foreignTop = frame('https://evil.example/');
const indexUnderForeign = frame('vscode-webview://0a1b2c/index.html?id=w3', foreignTop);
const httpsInFake = frame('https://evil.example/page', fake);
const workbenchContents = contentsOf(top, [index, fake, blankInFake, nestedIndex, httpsInFake]);
const navIn = (contents, url, isMainFrame, f) => policyMod.isAllowedNavigation(contents, url, isMainFrame, f, policy);
const nav = (url, isMainFrame, f) => navIn(workbenchContents, url, isMainFrame, f);
const sub = (url, parent) => nav(url, false, frame('', parent));
registry.register(workbenchContents, 'w1', '0a1b2c');
const firstNavigation = nav('vscode-webview://0a1b2c/index.html?id=w1&parentId=1', false, index);
index.url = 'vscode-webview://0a1b2c/index.html?id=w1&parentId=1';

const expectAll = (name, cases, want) => {
	const wrong = cases.filter(([, got]) => got !== want).map(([label]) => label);
	row(name, wrong.length === 0, wrong.length === 0 ? `${cases.length} cases ${want ? 'allowed' : 'denied'}` : `${want ? 'denied' : 'allowed'}: ${wrong.join('; ')}`);
};

// ---- M2: navigations
expectAll('1 owned navigations allowed', [
	['main frame -> workbench document (query)', nav(`${policy.workbenchDocument}?windowId=2#x`, true, top)],
	['registered webview index.html under the workbench (its first navigation)', firstNavigation],
	['the bound frame to its own index.html again', nav('vscode-webview://0a1b2c/index.html?id=w1', false, index)],
	['fake.html under its own index.html', sub('vscode-webview://0a1b2c/fake.html?id=w1', index)],
	['about:blank under fake.html', sub('about:blank', fake)],
	['about:srcdoc under index.html', sub('about:srcdoc', index)],
	['about:blank under the workbench', sub('about:blank', top)],
	['about:srcdoc under a blank frame of fake.html', sub('about:srcdoc', blankInFake)]
], true);
expectAll('2 unregistered vscode-webview documents denied', [
	['index.html in an unregistered frame under the workbench', nav(unregisteredIndex.url, false, unregisteredIndex)],
	['index.html in an unnamed frame under the workbench', sub('vscode-webview://0a1b2c/index.html?id=w1', top)],
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
	['frame without parent', nav('about:blank', false, frame('', null))]
], false);

// ---- M2: the wiring of security.ts (navigations and redirects, both frames)
{
	const securityMod = load('code/electron-main/qlHost/security.ts', {
		'../../../base/common/lifecycle.js': { toDisposable: fn => ({ dispose: fn }) },
		'./securityPolicy.js': policyMod
	});
	const contents = new EventEmitter();
	contents.setWindowOpenHandler = () => undefined;
	contents.mainFrame = workbenchContents.mainFrame;
	registry.register(contents, 'w1', '0a1b2c');
	const sevenIndex = frame('', top, 'w1');
	const sevenUnregistered = frame('', top, 'not-registered');
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
		['navigation, registered index.html (binds in THIS contents)', fire('will-frame-navigate', 'vscode-webview://0a1b2c/index.html?id=w1', false, sevenIndex), false],
		['navigation, owned sub-frame', fire('will-frame-navigate', 'vscode-webview://0a1b2c/fake.html?id=w1', false, frame('', { ...sevenIndex, url: 'vscode-webview://0a1b2c/index.html?id=w1' })), false],
		['navigation, https in a webview', fire('will-frame-navigate', 'https://evil.example/', false, frame('', fake)), true],
		['navigation, main frame elsewhere', fire('will-frame-navigate', 'https://evil.example/', true, top), true],
		['redirect, owned main frame', fire('will-redirect', WORKBENCH, true, top), false],
		['redirect, https in a webview', fire('will-redirect', 'https://evil.example/r', false, frame('', fake)), true],
		['redirect, main frame elsewhere', fire('will-redirect', 'https://evil.example/r', true, top), true],
		['navigation, unregistered index.html, same parent and URL', fire('will-frame-navigate', 'vscode-webview://0a1b2c/index.html?id=w1', false, sevenUnregistered), true],
		['redirect, unregistered index.html, same parent and URL', fire('will-redirect', 'vscode-webview://0a1b2c/index.html?id=w1', false, sevenUnregistered), true]
	];
	const wrong = results.filter(([, got, want]) => got !== want).map(([label, got]) => `${label} prevented=${got}`);
	const named = logged.length === 6 && logged.filter(line => line.includes('redirect to https://evil.example/r')).length === 2;
	disposable.dispose();
	const left = contents.listenerCount('will-frame-navigate') + contents.listenerCount('will-redirect');
	row('7 security.ts guards navigations and redirects', wrong.length === 0 && named && left === 0,
		`${wrong.length === 0 ? '9 events decided as the policy' : wrong.join('; ')}; ${logged.length} blocked lines (named redirects ${named}); listeners after dispose ${left}`);
}

// ---- M3: one permission decision
const grant = (contents, permission, requestingUrl, isMainFrame) => policyMod.isGrantedPermission(contents, permission, requestingUrl, isMainFrame, policy);
const GRANTED = ['clipboard-sanitized-write', 'fullscreen'];
const OTHERS = ['pointerLock', 'clipboard-read', 'deprecated-sync-clipboard-read', 'local-fonts', 'media', 'notifications', 'keyboardLock', 'geolocation', 'display-capture', 'openExternal', 'fileSystem', 'window-management'];
const owned = [['workbench', WORKBENCH, true], ['index.html', index.url, false], ['fake.html', fake.url, false]];
expectAll('8 owned documents granted clipboard-sanitized-write and fullscreen', owned.flatMap(([label, url, isMainFrame]) => GRANTED.map(p => [`${p} ${label}`, grant(workbenchContents, p, url, isMainFrame)])), true);
expectAll('9 every other permission denied to owned documents', owned.flatMap(([label, url, isMainFrame]) => OTHERS.map(p => [`${p} ${label}`, grant(workbenchContents, p, url, isMainFrame)])), false);
{
	const shared = frame('vscode-webview://0a1b2c/fake.html?id=w1', nestedIndex);
	// its own contents object: w1 is registered and bound there too, so the denial is the unowned twin's, not a missing registration
	const sharedContents = contentsOf(top, [index, fake, nestedIndex, shared]);
	registry.register(sharedContents, 'w1', '0a1b2c');
	const sharedBound = registry.of(sharedContents).bind('w1', '0a1b2c', index.frameTreeNodeId);
	const sharedAlone = GRANTED.every(p => grant(contentsOf(top, [index, fake]), p, fake.url, false) === false) && GRANTED.every(p => grant(sharedContents, p, index.url, false));
	row('10a the shared-URL case of row 10 is decided by the unowned twin', sharedBound && sharedAlone, `bound in its contents ${sharedBound}; index.html granted there and an unregistered contents denied ${sharedAlone}`);
	expectAll('10 foreign, unregistered and non-workbench requesters denied', GRANTED.flatMap(p => [
		[`${p} https frame in a webview`, grant(workbenchContents, p, httpsInFake.url, false)],
		[`${p} nested index.html`, grant(workbenchContents, p, nestedIndex.url, false)],
		[`${p} unregistered index.html under the workbench (w1 is registered and bound to another frame)`, policyMod.isGrantedPermission(contentsOf(top, [unregisteredIndex]), p, unregisteredIndex.url, false, { ...policy, webviews: () => registry.of(workbenchContents) })],
		[`${p} URL in no frame`, grant(workbenchContents, p, 'vscode-webview://0a1b2c/fake.html?id=other', false)],
		[`${p} URL shared by an owned and an unowned frame`, grant(sharedContents, p, fake.url, false)],
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

// ---- c2 M2 + M3: registration, not ancestry. Each case has its own contents (its own registrations) and fresh frames.
const INDEX_A = 'vscode-webview://aaaa/index.html?id=a';
const INDEX_B = 'vscode-webview://bbbb/index.html?id=b';
const FAKE_A = 'vscode-webview://aaaa/fake.html?id=a';
const scene = () => {
	const sceneTop = frame(WORKBENCH);
	const contents = { mainFrame: { ...sceneTop, framesInSubtree: [sceneTop] } };
	const add = (url, parent, name) => {
		const f = frame(url, parent, name);
		contents.mainFrame.framesInSubtree.push(f);
		return f;
	};
	const remove = f => contents.mainFrame.framesInSubtree.splice(contents.mainFrame.framesInSubtree.indexOf(f), 1);
	// a navigation as Electron reports it (frame still at its old URL), then the frame is at the destination when allowed
	const go = (f, url) => {
		const allowed = navIn(contents, url, false, f);
		if (allowed) {
			f.url = url;
		}
		return allowed;
	};
	return { top: sceneTop, contents, add, remove, go };
};
const securityOf = contents => {
	const securityMod = load('code/electron-main/qlHost/security.ts', {
		'../../../base/common/lifecycle.js': { toDisposable: fn => ({ dispose: fn }) },
		'./securityPolicy.js': policyMod
	});
	const emitter = Object.assign(new EventEmitter(), contents, { setWindowOpenHandler: () => undefined });
	securityMod.secureWorkbenchContents(emitter, { logService: { error: () => undefined, trace: () => undefined }, policy: { ...policy, webviews: () => registry.of(contents) }, openExternal: () => undefined });
	return (event, url, f) => {
		let prevented = false;
		emitter.emit(event, { url, isMainFrame: false, frame: f, preventDefault: () => { prevented = true; } });
		return prevented;
	};
};
{
	// 12: two frames, the same parent (the workbench document), the same destination; the workbench registered one
	const s = scene();
	registry.register(s.contents, 'a', 'aaaa');
	const registered = s.add('', s.top, 'a');
	const twin = s.add('', s.top, 'twin');
	const fire = securityOf(s.contents);
	const cases = [
		['navigation registered', s.go(registered, INDEX_A), true],
		['navigation unregistered twin', s.go(twin, INDEX_A), false],
		['redirect registered (security.ts) prevented', fire('will-redirect', INDEX_A, registered), false],
		['redirect unregistered twin (security.ts) prevented', fire('will-redirect', INDEX_A, twin), true],
		['navigation event unregistered twin (security.ts) prevented', fire('will-frame-navigate', INDEX_A, twin), true]
	];
	twin.url = INDEX_A; // as if it had loaded: its document is still unowned
	for (const p of GRANTED) {
		cases.push([`${p} the bound frame, asked of a contents that holds no registration`, grant(contentsOf(s.top, [registered]), p, INDEX_A, false), false]);
		cases.push([`${p} registered, in the contents that holds the registration`, policyMod.isGrantedPermission({ mainFrame: { ...s.top, framesInSubtree: [s.top, registered] } }, p, INDEX_A, false, { ...policy, webviews: () => registry.of(s.contents) }), true]);
		cases.push([`${p} unregistered twin`, policyMod.isGrantedPermission({ mainFrame: { ...s.top, framesInSubtree: [s.top, twin] } }, p, INDEX_A, false, { ...policy, webviews: () => registry.of(s.contents) }), false]);
		cases.push([`${p} both frames present (one unowned requester denies)`, policyMod.isGrantedPermission(s.contents, p, INDEX_A, false, policy), false]);
	}
	const wrong = cases.filter(([, got, want]) => got !== want).map(([label, got]) => `${label}=${got}`);
	row('12 equal ancestry: the registered frame is owned, its unregistered twin is not (navigation, redirect, both permissions)', wrong.length === 0, wrong.length === 0 ? `${cases.length} cases as expected` : wrong.join('; '));
}
{
	// 13: initialization
	const s = scene();
	const early = s.add('', s.top, 'a');
	const beforeRegistration = s.go(early, INDEX_A);
	registry.register(s.contents, 'a', 'aaaa');
	const wrongAuthority = s.go(s.add('', s.top, 'a'), INDEX_B);
	const nested = s.go(s.add('', s.add('about:blank', s.top, ''), 'a'), INDEX_A);
	const first = s.add('', s.top, 'a');
	const unownedBefore = policyMod.isOwnedFrame({ ...first, url: INDEX_A }, policy, registry.of(s.contents));
	const firstBinds = s.go(first, INDEX_A);
	const ownedAfter = policyMod.isOwnedFrame(first, policy, registry.of(s.contents));
	const second = s.add('', s.top, 'a');
	const secondDenied = !s.go(second, INDEX_A);
	const firstAgain = s.go(first, INDEX_A);
	const otherContents = scene();
	const otherFrame = otherContents.add('', otherContents.top, 'a');
	const perContents = !otherContents.go(otherFrame, INDEX_A);
	const ok = !beforeRegistration && !wrongAuthority && !nested && !unownedBefore && firstBinds && ownedAfter && secondDenied && firstAgain && perContents;
	row('13 initialization: the first navigation of a registered name binds its frame; a second frame with the name is unowned', ok,
		`before registration allowed ${beforeRegistration}; other authority allowed ${wrongAuthority}; not a direct child allowed ${nested}; owned before its navigation ${unownedBefore}; first binds ${firstBinds} (owned after ${ownedAfter}); second frame denied ${secondDenied}; first again ${firstAgain}; another contents denied ${perContents}`);
}
{
	// 14: content frames under a bound vs an unbound index.html (same URLs, same shape)
	const s = scene();
	registry.register(s.contents, 'a', 'aaaa');
	const bound = s.add('', s.top, 'a');
	s.go(bound, INDEX_A);
	const unbound = s.add(INDEX_A, s.top, 'twin');
	const under = parent => {
		const fakeFrame = s.add('', parent, '');
		const fakeOk = s.go(fakeFrame, FAKE_A);
		fakeFrame.url = FAKE_A; // loaded or not, what follows is decided on the parent chain
		const blank = s.add('', fakeFrame, '');
		const blankOk = s.go(blank, 'about:blank');
		blank.url = 'about:blank';
		const srcdocOk = s.go(s.add('', parent, ''), 'about:srcdoc');
		const deepOk = s.go(s.add('', blank, ''), 'about:srcdoc');
		const webviews = registry.of(s.contents);
		return [fakeOk, blankOk, srcdocOk, deepOk, policyMod.isOwnedFrame(fakeFrame, policy, webviews), policyMod.isOwnedFrame(blank, policy, webviews),
			...GRANTED.map(p => policyMod.isGrantedPermission(contentsOf(s.top, [parent, fakeFrame]), p, FAKE_A, false, { ...policy, webviews: () => webviews }))];
	};
	const underBound = under(bound);
	const underUnbound = under(unbound);
	row('14 fake.html, about:blank and about:srcdoc are owned under a bound index.html, unowned under an unbound one', underBound.every(v => v === true) && underUnbound.every(v => v === false),
		`under bound [${underBound.join(',')}]; under unbound [${underUnbound.join(',')}]`);
}
{
	// 15: one registration per frame
	const s = scene();
	registry.register(s.contents, 'a', 'aaaa');
	registry.register(s.contents, 'b', 'bbbb');
	const a = s.add('', s.top, 'a');
	s.go(a, INDEX_A);
	const toOther = s.go(a, INDEX_B);
	a.name = 'b'; // a same-origin content frame can rename its parent
	const renamed = s.go(a, INDEX_B);
	const stillA = registry.of(s.contents).boundAuthority(a.frameTreeNodeId);
	a.name = 'a';
	const b = s.add('', s.top, 'b');
	const bBinds = s.go(b, INDEX_B);
	const direct = registry.of(s.contents).bind('b', 'bbbb', a.frameTreeNodeId);
	row('15 a bound frame cannot go to another registered authority, renamed or not', !toOther && !renamed && stillA === 'aaaa' && bBinds && !direct,
		`to bbbb allowed ${toOther}; renamed to b allowed ${renamed}; still bound to ${stillA}; b's own frame binds ${bBinds}; registry binds a's frame to b ${direct}`);
}
{
	// 16: the end of a registration
	const s = scene();
	registry.register(s.contents, 'a', 'aaaa');
	const a = s.add('', s.top, 'a');
	s.go(a, INDEX_A);
	const child = s.add(FAKE_A, a, '');
	const webviews = () => registry.of(s.contents);
	const ownedBefore = policyMod.isOwnedFrame(a, policy, webviews()) && policyMod.isOwnedFrame(child, policy, webviews());
	registry.unregister(s.contents, 'a');
	const ownedAfter = policyMod.isOwnedFrame(a, policy, webviews()) || policyMod.isOwnedFrame(child, policy, webviews());
	const navAfter = s.go(a, INDEX_A) || navIn(s.contents, FAKE_A, false, frame('', a));
	const grantAfter = GRANTED.some(p => policyMod.isGrantedPermission(s.contents, p, INDEX_A, false, policy));
	let unknown = '';
	try {
		registry.unregister(s.contents, 'a');
	} catch (error) {
		unknown = error.message;
	}
	// mounted again (the same name registered again): the old frame is unowned, a new one binds
	registry.register(s.contents, 'a', 'aaaa');
	const oldUnowned = !policyMod.isOwnedFrame(a, policy, webviews());
	s.remove(child);
	s.remove(a);
	const again = s.add('', s.top, 'a');
	const rebinds = s.go(again, INDEX_A);
	// the element taken out of the document and put back without a new registration: the bound frame no longer exists
	s.remove(again);
	const reinserted = s.add('', s.top, 'a');
	const whileLive = (() => {
		const t = scene();
		registry.register(t.contents, 'a', 'aaaa');
		t.go(t.add('', t.top, 'a'), INDEX_A);
		return t.go(t.add('', t.top, 'a'), INDEX_A);
	})();
	const afterGone = s.go(reinserted, INDEX_A);
	const ok = ownedBefore && !ownedAfter && !navAfter && !grantAfter && unknown.includes('no webview registration "a"') && oldUnowned && rebinds && !whileLive && afterGone;
	row('16 after unregister the frame and its content are unowned; a registration binds again only when registered again or its frame is gone', ok,
		`owned before ${ownedBefore}; owned after ${ownedAfter}; navigation after ${navAfter}; permission after ${grantAfter}; second unregister "${unknown}"; old frame unowned on re-registration ${oldUnowned}; new frame binds ${rebinds}; second frame while the first lives ${whileLive}; after the bound frame is gone ${afterGone}`);
}
{
	// 17: what the registry accepts
	const s = scene();
	const refused = [['', 'aaaa'], [undefined, 'aaaa'], ['a', ''], ['a', 'AAAA'], ['a', 'aa.aa'], ['a', 'aaaa/index.html'], ['a', undefined], ['a', 7]].filter(([name, authority]) => {
		try {
			registry.register(s.contents, name, authority);
			return false;
		} catch (error) {
			return error.message.startsWith('QuantLab host:');
		}
	}).length;
	const none = registry.of(s.contents).boundAuthority(1) === undefined && registry.of(s.contents).bind('a', 'aaaa', 1) === false;
	const hash = '0'.repeat(20) + 'abcdefghijklmnopqrstuv0123456789'; // the shape of parentOriginHash: 52 base-32 characters
	registry.register(s.contents, 'a', hash);
	const accepted = s.go(s.add('', s.top, 'a'), `vscode-webview://${hash}/index.html`);
	row('17 the registry refuses a registration without a name or with an authority that is not lower-case alphanumeric', refused === 8 && none && accepted, `${refused} of 8 refused by name; nothing bound after them ${none}; a 52-character base-32 authority registers and binds ${accepted}`);
}
{
	// 18: the wiring, read from the sources
	const app = read('code/electron-main/app.ts');
	const service = read('platform/webview/electron-main/webviewMainService.ts');
	const common = read('platform/webview/common/webviewManagerService.ts');
	const element = read('workbench/contrib/webview/browser/webviewElement.ts');
	const electronElement = read('workbench/contrib/webview/electron-browser/webviewElement.ts');
	const oneRegistry = count(app, /new QlWebviewRegistry\(\)/g) === 1 && app.includes('private readonly qlWebviewRegistry = new QlWebviewRegistry();')
		&& app.includes('webviews: contents => this.qlWebviewRegistry.of(contents)')
		&& app.includes('services.set(IWebviewManagerService, new SyncDescriptor(WebviewMainService, [this.qlWebviewRegistry]));');
	const serviceWrites = /public async qlRegisterWebview\(windowId: WebviewWindowId, frameName: string, authority: string\): Promise<void> \{[^]*?this\.qlWebviews\.register\(window\.win\.webContents, frameName, authority\);\n\t\}/.test(service)
		&& /public async qlUnregisterWebview\(windowId: WebviewWindowId, frameName: string\): Promise<void> \{[^]*?this\.qlWebviews\.unregister\(window\.win\.webContents, frameName\);\n\t\}/.test(service)
		&& common.includes('qlRegisterWebview(windowId: WebviewWindowId, frameName: string, authority: string): Promise<void>;') && common.includes('qlUnregisterWebview(windowId: WebviewWindowId, frameName: string): Promise<void>;');
	const mount = element.slice(element.indexOf('public mountTo('), element.indexOf('this._registerMessageHandler(targetWindow);'));
	const awaited = /\.then\(async encodedWebviewOrigin => \{\n(\t+\/\/[^\n]*\n)*\t+await this\.qlRegisterFrame\(encodedWebviewOrigin, targetWindow\);\n\t+if \(!this\._disposed\) \{\n\t+this\._initElement\(/.test(mount);
	const srcSites = count(element, /setAttribute\('src'|\.src = /g) + count(electronElement, /setAttribute\('src'|\.src = /g);
	const initCalls = count(element, /this\._initElement\(/g);
	const registers = /protected override async qlRegisterFrame\(encodedWebviewOrigin: string, targetWindow: CodeWindow\): Promise<void> \{\n\t+const windowId: WebviewWindowId = \{ windowId: targetWindow\.vscodeWindowId \};\n\t+await this\._webviewMainService\.qlRegisterWebview\(windowId, this\.id, encodedWebviewOrigin\);/.test(electronElement)
		&& electronElement.includes('return `${Schemas.vscodeWebview}://${iframeId}`;') && element.includes('element.name = this.id;');
	const unregisters = /override dispose\(\): void \{[^]*?this\._webviewMainService\.qlUnregisterWebview\(this\._qlRegisteredIn, this\.id\);[^]*?super\.dispose\(\);/.test(electronElement);
	row('18 wiring: one registry for the service and the policy; the element registers its frame name and authority and awaits it before the only src assignment; dispose unregisters',
		oneRegistry && serviceWrites && awaited && srcSites === 1 && initCalls === 1 && registers && unregisters,
		`one registry ${oneRegistry}; service writes it ${serviceWrites}; awaited before _initElement ${awaited}; src assignments ${srcSites}, _initElement calls ${initCalls}; element registers id + authority ${registers}; dispose unregisters ${unregisters}`);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
