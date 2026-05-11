/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * jsdom-shim -- Phase 9, hardened by megaudit cure 2026-05-12.
 *
 * Provides a minimal jsdom-backed DOM environment for unit-testing the
 * qviz webview components. Resolves `jsdom` from the sibling
 * `extensions/notebook-renderers/node_modules/jsdom` install (already
 * present in the monorepo) so we don't need to pin jsdom as a dev
 * dependency on `extensions/quantlab`.
 *
 * Surface:
 *   - `installDom()` mounts global `window`, `document`, plus DOM
 *     constructors and rAF/storage globals ONCE per process. Re-calls
 *     return the same handle.
 *   - `resetDom()` clears the document, sessionStorage, document-level
 *     event listeners, and inline styles between tests. Use in
 *     `setup()` / `beforeEach`.
 *   - `disposeDom()` is intentionally not exported. We keep the jsdom
 *     window alive for the whole process; closing + re-opening it
 *     between suites is slow and not needed.
 *
 * Why this exists: the production component modules statically call
 * `document.createElement`, `document.body.appendChild`,
 * `window.sessionStorage`, etc. The existing tests
 * (qviz-renderer-host.test.ts, qviz-state-store.test.ts) sidestep this
 * with hand-stubbed objects; Phase 9 needs the real DOM contract to
 * cover the mount + dispose + event-flow paths the components rely on.
 *
 * Pinning local: if `notebook-renderers` is ever removed or migrated,
 * pin jsdom locally by adding `"jsdom": "21.x"` to
 * `extensions/quantlab/package.json` devDependencies. The shim's
 * resolver tries `extensions/quantlab/node_modules` first, so a local
 * pin takes precedence over the sibling probe.
 */

import * as path from 'path';

/** jsdom major versions known to work with this shim. Mismatches will
 *  fail loudly at installDom() time -- jsdom 22+ rewrote Event/PointerEvent
 *  internals + dropped Node 18; jsdom 19 lacked PointerEvent shimmability.
 *  Update this set when the sibling extension bumps + we've validated. */
const SUPPORTED_JSDOM_MAJORS = new Set<number>([21]);

interface DomHandle {
	readonly window: unknown;
	readonly document: unknown;
}

let installed: DomHandle | null = null;
/** Listeners attached to `document` by component code; tracked so
 *  `resetDom()` can clear them between tests. */
const docListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; useCapture: boolean }> = [];

interface JsdomModule {
	readonly JSDOM: new (html: string, opts?: { url?: string; pretendToBeVisual?: boolean }) => {
		window: Window & typeof globalThis;
	};
}

function loadJsdom(): { mod: JsdomModule; version: string; major: number } {
	// Resolution order:
	//   1. extensions/quantlab/node_modules (local pin -- highest priority)
	//   2. extensions/notebook-renderers/node_modules (current sibling)
	//
	// At runtime, __dirname is .../extensions/quantlab/out/test/helpers/.
	// 4 segments up lands at .../extensions/quantlab; the sibling
	// extension lives at .../extensions/notebook-renderers/node_modules.
	const candidates = [
		path.resolve(__dirname, '..', '..', '..', 'node_modules'),
		path.resolve(__dirname, '..', '..', '..', '..', 'notebook-renderers', 'node_modules'),
	];
	let resolvedPath: string | null = null;
	let resolvedFrom: string | null = null;
	for (const p of candidates) {
		try {
			resolvedPath = require.resolve('jsdom', { paths: [p] });
			resolvedFrom = p;
			break;
		} catch {
			// try next
		}
	}
	if (resolvedPath === null) {
		throw new Error(
			'jsdom-shim: could not resolve jsdom. Tried:\n'
			+ candidates.map(c => `  - ${c}`).join('\n')
			+ '\n\n'
			+ 'To pin jsdom locally, add `"jsdom": "21.x"` to '
			+ 'extensions/quantlab/package.json devDependencies and re-run npm install. '
			+ 'See test/helpers/jsdom-shim.ts header for context.',
		);
	}
	// Read the resolved jsdom's package.json to enforce a known major.
	let pkgPath: string;
	try {
		pkgPath = require.resolve('jsdom/package.json', { paths: [resolvedFrom!] });
	} catch (e) {
		throw new Error(
			`jsdom-shim: resolved jsdom at ${resolvedPath} but its package.json is missing: ${(e as Error).message}`,
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const pkg = require(pkgPath) as { version?: string };
	const version = typeof pkg.version === 'string' ? pkg.version : '?';
	const majorMatch = version.match(/^(\d+)\./);
	const major = majorMatch ? Number(majorMatch[1]) : 0;
	if (!SUPPORTED_JSDOM_MAJORS.has(major)) {
		throw new Error(
			`jsdom-shim: resolved jsdom version ${version} (major ${major}) is not in the `
			+ `supported set ${[...SUPPORTED_JSDOM_MAJORS].join(', ')}. `
			+ `Update SUPPORTED_JSDOM_MAJORS in test/helpers/jsdom-shim.ts after validating `
			+ `behavior, OR pin jsdom@${[...SUPPORTED_JSDOM_MAJORS][0]} in `
			+ `extensions/quantlab/package.json devDependencies.`,
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require(resolvedPath) as JsdomModule;
	return { mod, version, major };
}

export function installDom(): DomHandle {
	if (installed !== null) { return installed; }

	const { mod: jsdom } = loadJsdom();
	const dom = new jsdom.JSDOM('<!doctype html><html><body></body></html>', {
		url: 'https://qviz.test/',
		pretendToBeVisual: true,
	});

	const w = dom.window as unknown as Record<string, unknown> & {
		document: Document;
		HTMLElement: typeof HTMLElement;
		Element: { prototype: Record<string, unknown> };
		requestAnimationFrame?: (cb: FrameRequestCallback) => number;
		cancelAnimationFrame?: (id: number) => void;
		sessionStorage: Storage;
		localStorage: Storage;
		addEventListener: typeof addEventListener;
	};
	// Install just enough on the Node global so component code that
	// references `window`, `document`, and the standard DOM constructors
	// finds them. We deliberately do NOT install `navigator` /
	// `location` / `history` -- components don't touch those.
	const g = globalThis as Record<string, unknown>;
	g.window = w;
	g.document = w.document;
	g.HTMLElement = w.HTMLElement;
	g.HTMLButtonElement = w.HTMLButtonElement;
	g.HTMLInputElement = w.HTMLInputElement;
	g.HTMLDivElement = w.HTMLDivElement;
	g.KeyboardEvent = w.KeyboardEvent;
	g.MouseEvent = w.MouseEvent;
	// `Node` is the DOM node constructor. Node.js itself does NOT define
	// a global `Node`, so installing jsdom's value here is safe.
	g.Node = w.Node;
	// NOTE: we deliberately do NOT replace `globalThis.Event` /
	// `globalThis.EventTarget`. Pre-existing tests (qviz-renderer-host)
	// construct their own `new EventTarget()` and hand-rolled `Event`
	// instances using Node's built-ins, and Node's EventTarget refuses
	// to dispatch foreign-realm Events. Keeping the Node copies in
	// place preserves those tests; the jsdom DOM tree that backs
	// `document` / `HTMLElement` carries its own private Event +
	// EventTarget already.
	g.getComputedStyle = w.getComputedStyle;

	// Cure M-19: install rAF + storage on globalThis so production code
	// that uses BARE `requestAnimationFrame(...)` / `localStorage.foo` /
	// `sessionStorage.foo` resolves correctly. (`window.X` already worked
	// because `window` is on globalThis.) jsdom's `pretendToBeVisual:true`
	// polyfills rAF onto the window; we just expose it.
	g.requestAnimationFrame = w.requestAnimationFrame;
	g.cancelAnimationFrame = w.cancelAnimationFrame;
	g.localStorage = w.localStorage;
	g.sessionStorage = w.sessionStorage;

	// PointerEvent: jsdom 21 doesn't ship one. Provide a thin alias to
	// MouseEvent with an injected `pointerId` field; the inspector
	// resize-handle reads pointerId only. Production tests that dispatch
	// PointerEvent must use `target.dispatchEvent(new PointerEvent(...))`
	// for pointerdown and `window.dispatchEvent(new PointerEvent(...))`
	// for pointermove/up -- jsdom does NOT auto-bubble pointer events.
	if (!('PointerEvent' in w)) {
		const MouseEventCtor = w.MouseEvent as typeof MouseEvent;
		class PointerEventShim extends MouseEventCtor {
			readonly pointerId: number;
			constructor(type: string, init: PointerEventInit & { pointerId?: number } = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 0;
			}
		}
		w.PointerEvent = PointerEventShim;
		g.PointerEvent = PointerEventShim;
	} else {
		g.PointerEvent = w.PointerEvent;
	}
	// Capture-set / release: jsdom doesn't implement pointer capture.
	// Stub on Element so .setPointerCapture / .releasePointerCapture are
	// no-ops; the inspector code guards both with `?.()` anyway.
	const elementProto = w.Element.prototype;
	if (typeof elementProto.setPointerCapture !== 'function') {
		(elementProto as Record<string, unknown>).setPointerCapture = function (): void { /* no-op */ };
	}
	if (typeof elementProto.releasePointerCapture !== 'function') {
		(elementProto as Record<string, unknown>).releasePointerCapture = function (): void { /* no-op */ };
	}

	// Cure M-20: track every `document.addEventListener` so `resetDom`
	// can remove them between tests. Component code that registers
	// document-level listeners (e.g., columnFilters click-outside)
	// otherwise leaks listeners that fire on later tests' dispatches.
	const docAny = w.document as Document & {
		addEventListener: typeof document.addEventListener;
		removeEventListener: typeof document.removeEventListener;
	};
	const origAdd = docAny.addEventListener.bind(docAny);
	const origRemove = docAny.removeEventListener.bind(docAny);
	docAny.addEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void {
		const useCapture = typeof options === 'boolean'
			? options
			: !!(options && options.capture);
		docListeners.push({ type, listener, useCapture });
		origAdd(type as keyof DocumentEventMap, listener, options);
	} as typeof document.addEventListener;
	docAny.removeEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void {
		const useCapture = typeof options === 'boolean'
			? options
			: !!(options && options.capture);
		const idx = docListeners.findIndex(
			e => e.type === type && e.listener === listener && e.useCapture === useCapture,
		);
		if (idx >= 0) { docListeners.splice(idx, 1); }
		origRemove(type as keyof DocumentEventMap, listener, options);
	} as typeof document.removeEventListener;

	installed = { window: w, document: w.document };
	return installed;
}

/** Reset the document body + sessionStorage + tracked document listeners
 *  + inline document.documentElement styles between tests. Call from
 *  `setup()`. Cheaper than tearing down + rebuilding the jsdom window. */
export function resetDom(): void {
	if (installed === null) {
		throw new Error('jsdom-shim.resetDom: installDom() must be called first');
	}
	const doc = installed.document as Document;
	doc.body.innerHTML = '';
	// Cure: clear inline style + CSS custom-properties on documentElement
	// so a test that wrote --qviz-inspector-width doesn't leak it.
	doc.documentElement.removeAttribute('style');
	const w = installed.window as { sessionStorage: Storage; localStorage: Storage };
	w.sessionStorage.clear();
	w.localStorage.clear();
	// Cure M-20: remove every tracked document listener. Untracked listeners
	// (added by something other than `document.addEventListener` through
	// our wrapper) will still leak; our wrapper covers all component code
	// paths in qviz today.
	if (docListeners.length > 0) {
		const docAny = doc as Document & {
			removeEventListener: typeof document.removeEventListener;
		};
		// Snapshot first so the splice inside removeEventListener doesn't
		// re-enter the array we're iterating.
		const snapshot = docListeners.slice();
		docListeners.length = 0;
		for (const e of snapshot) {
			try {
				docAny.removeEventListener(
					e.type as keyof DocumentEventMap, e.listener, e.useCapture,
				);
			} catch {
				// remove failures shouldn't block reset
			}
		}
	}
}
