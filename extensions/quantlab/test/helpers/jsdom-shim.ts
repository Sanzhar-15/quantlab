/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * jsdom-shim — Phase 9 step A.
 *
 * Provides a minimal jsdom-backed DOM environment for unit-testing the
 * qviz webview components. Resolves `jsdom` from the sibling
 * `extensions/notebook-renderers/node_modules/jsdom` install (already
 * present in the monorepo) so we don't need to pin jsdom as a dev
 * dependency on `extensions/quantlab`.
 *
 * Surface:
 *   - `installDom()` mounts global `window`, `document`, `HTMLElement`,
 *     `KeyboardEvent`, `MouseEvent`, `PointerEvent`, `sessionStorage`
 *     ONCE per process. Re-calls return the same handle.
 *   - `resetDom()` clears the document body + sessionStorage between
 *     tests. Use in `setup()` / `beforeEach`.
 *   - `disposeDom()` is intentionally not exported. We keep the jsdom
 *     window alive for the whole process; closing + re-opening it
 *     between suites is slow and not needed for our use cases.
 *
 * Why this exists: the production component modules statically call
 * `document.createElement`, `document.body.appendChild`,
 * `window.sessionStorage`, etc. The existing tests
 * (qviz-renderer-host.test.ts, qviz-state-store.test.ts) sidestep this
 * with hand-stubbed objects; Phase 9 needs the real DOM contract to
 * cover the mount + dispose + event-flow paths the components rely on.
 */

import { Module } from 'module';
import * as path from 'path';

interface DomHandle {
	readonly window: unknown;
	readonly document: unknown;
}

let installed: DomHandle | null = null;

function loadJsdom(): unknown {
	// jsdom is available in the monorepo at
	// extensions/notebook-renderers/node_modules/jsdom. We resolve via
	// that path so we don't have to add jsdom to extensions/quantlab's
	// package.json. The path is relative to this file's compiled
	// location (out/test/helpers/jsdom-shim.js) — three levels up takes
	// us to extensions/quantlab/, then we step sideways into
	// notebook-renderers.
	// At runtime, __dirname is .../extensions/quantlab/out/test/helpers/.
	// 4 segments up lands at .../extensions/quantlab; the sibling
	// extension lives at .../extensions/notebook-renderers/node_modules.
	// We also probe a couple of alternative roots so the helper works
	// from sources / from a relocated build.
	const candidates = [
		path.resolve(__dirname, '..', '..', '..', '..', 'notebook-renderers', 'node_modules'),
		path.resolve(__dirname, '..', '..', '..', 'notebook-renderers', 'node_modules'),
		path.resolve(__dirname, '..', '..', '..', '..', '..', 'extensions', 'notebook-renderers', 'node_modules'),
	];
	const tryPaths = candidates;
	let resolvedPath: string | null = null;
	for (const p of tryPaths) {
		try {
			resolvedPath = require.resolve('jsdom', { paths: [p] });
			break;
		} catch {
			// try next
		}
	}
	if (resolvedPath === null) {
		throw new Error(
			'jsdom-shim: could not resolve jsdom from sibling extensions. '
			+ `Tried: ${tryPaths.join(', ')}`,
		);
	}
	// Use require here (not import) because jsdom is a CJS module and we
	// have it under typeof =unknown=.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(resolvedPath);
}

export function installDom(): DomHandle {
	if (installed !== null) { return installed; }

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const jsdom = loadJsdom() as { JSDOM: new (html: string, opts?: any) => { window: any } };
	const dom = new jsdom.JSDOM('<!doctype html><html><body></body></html>', {
		url: 'https://qviz.test/',
		pretendToBeVisual: true,
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = dom.window as any;
	// Install just enough on the Node global so component code that
	// references `window`, `document`, and the standard DOM constructors
	// finds them. We deliberately do NOT install `navigator` /
	// `location` / `history` — components don't touch those.
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
	// a global `Node`, so installing jsdom's value here is safe —
	// existing tests that build a `new EventTarget()` (qviz-renderer-host)
	// don't refer to `Node` at all.
	g.Node = w.Node;
	// NOTE: we deliberately do NOT replace `globalThis.Event` /
	// `globalThis.EventTarget`. Pre-existing tests (qviz-renderer-host)
	// construct their own `new EventTarget()` and hand-rolled `Event`
	// instances using Node's built-ins, and Node's EventTarget refuses
	// to dispatch foreign-realm Events. Keeping the Node copies in
	// place preserves those tests; the jsdom DOM tree that backs
	// `document` / `HTMLElement` carries its own private Event +
	// EventTarget already, so component code that wires up listeners
	// through DOM nodes still gets the right behavior.
	g.getComputedStyle = w.getComputedStyle;
	// PointerEvent: jsdom 21 doesn't ship one. Provide a thin alias to
	// MouseEvent with an injected `pointerId` field; the inspector
	// resize-handle reads pointerId only.
	if (!('PointerEvent' in w)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const MouseEventCtor = w.MouseEvent as any;
		class PointerEventShim extends MouseEventCtor {
			readonly pointerId: number;
			constructor(type: string, init: { pointerId?: number; button?: number; clientX?: number; clientY?: number } = {}) {
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
	const elementProto = w.Element.prototype as Record<string, unknown>;
	if (typeof elementProto.setPointerCapture !== 'function') {
		elementProto.setPointerCapture = function (): void { /* no-op */ };
	}
	if (typeof elementProto.releasePointerCapture !== 'function') {
		elementProto.releasePointerCapture = function (): void { /* no-op */ };
	}

	installed = { window: w, document: w.document };
	return installed;
}

/** Reset the document body + sessionStorage between tests. Call from
 *  `setup()`. Cheaper than tearing down + rebuilding the jsdom window. */
export function resetDom(): void {
	if (installed === null) {
		throw new Error('jsdom-shim.resetDom: installDom() must be called first');
	}
	const doc = (installed.document as { body: { innerHTML: string } });
	doc.body.innerHTML = '';
	try {
		const w = installed.window as { sessionStorage: { clear(): void } };
		w.sessionStorage.clear();
	} catch { /* sessionStorage may not be available in some jsdom builds */ }
}

// Re-export the jsdom Module hook so the resolver picks up the sibling
// install before any production code that does `require('jsdom')` runs.
// (We don't currently need this in qviz code, but provide it for
// completeness in case a future component pulls jsdom-only utilities.)
export function pinJsdomResolver(): void {
	const M = Module as unknown as {
		_resolveFilename(
			request: string, parent: NodeJS.Module | null,
			isMain?: boolean, options?: { paths?: string[] },
		): string;
	};
	const original = M._resolveFilename;
	const siblingPaths = [
		path.resolve(__dirname, '..', '..', '..', '..', 'extensions', 'notebook-renderers', 'node_modules'),
	];
	M._resolveFilename = function (request, parent, isMain, options): string {
		if (request === 'jsdom') {
			return original.call(this, request, parent, isMain, { paths: siblingPaths });
		}
		return original.call(this, request, parent, isMain, options);
	};
}
