/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for inspectorPanel — Phase 9 step B.
 *
 * The inspector panel is the right-side toggleable data-table host
 * (Phase 6 / Phase 8 polish). Until Phase 9 it had no jsdom coverage;
 * only the reducer slice (`inspectorState`) was exercised. These tests
 * cover the mount/unmount + header behavior + dispose path:
 *
 *   - Mount adds class + aria-label and inserts the resize handle,
 *     header, and body wrap.
 *   - Visibility toggle (`toggleInspector`) does NOT remove the panel
 *     root but DOES mount/unmount the table body. The width state
 *     persists across hides (sessionStorage).
 *   - Header title reflects `inspector.window.total` and switches to
 *     "(filtered)" when any column filter is active. "Clear filters"
 *     button hidden until a filter is set.
 *   - Close button dispatches `toggleInspector{visible:false}`.
 *   - Width persists to sessionStorage with the namespaced key.
 *   - Dispose teardown: class removed, content empty, no leaks.
 */

import { installDom, resetDom } from './helpers/jsdom-shim';
installDom();

import * as assert from 'assert';

import { mountInspectorPanel } from '../webview/qviz/components/inspectorPanel';
import { createStore } from '../webview/qviz/state/store';

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

suite('inspectorPanel — Phase 9 jsdom coverage', () => {
	setup(() => { resetDom(); });

	test('mount installs class, aria-label, and required sub-elements', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountInspectorPanel(root, store);

		assert.ok(root.classList.contains('qviz-inspector-panel'),
			'panel root should be marked with qviz-inspector-panel');
		assert.strictEqual(root.getAttribute('aria-label'), 'Data inspector');

		assert.ok(root.querySelector('.qviz-inspector-resize-handle'),
			'resize handle should be inserted');
		assert.ok(root.querySelector('.qviz-inspector-title'),
			'title element should be present');
		assert.ok(root.querySelector('.qviz-inspector-clear'),
			'clear button should be present');
		assert.ok(root.querySelector('.qviz-inspector-close'),
			'close button should be present');
		assert.ok(root.querySelector('.qviz-inspector-body-wrap'),
			'body wrap should be present');

		// Phase 6 a11y cure: resize handle has role="separator".
		assert.strictEqual(
			root.querySelector('.qviz-inspector-resize-handle')!.getAttribute('role'),
			'separator',
		);

		assert.strictEqual(handle.element, root,
			'handle.element should be the mount root');
	});

	test('clear-filters button is hidden when no filter is active, visible when one is', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountInspectorPanel(root, store);
		const clearBtn = root.querySelector<HTMLButtonElement>('.qviz-inspector-clear')!;

		assert.strictEqual(clearBtn.hidden, true,
			'clear filters hidden by default');

		store.dispatch({
			type: 'setColumnFilter',
			column: 'price',
			filter: { kind: 'range', column: 'price', min: 0, max: 100 },
		});
		assert.strictEqual(clearBtn.hidden, false,
			'clear button visible when one filter is active');

		store.dispatch({ type: 'clearAllFilters' });
		assert.strictEqual(clearBtn.hidden, true,
			'clear button hidden after clearAllFilters');

		handle.dispose();
	});

	test('close (×) button dispatches toggleInspector{visible:false}', () => {
		const root = mkRoot();
		const store = createStore();
		mountInspectorPanel(root, store);
		// Make it visible first so we can observe the close action.
		store.dispatch({ type: 'toggleInspector', visible: true });
		assert.strictEqual(store.getState().inspector.visible, true);

		const closeBtn = root.querySelector<HTMLButtonElement>('.qviz-inspector-close')!;
		closeBtn.click();
		assert.strictEqual(store.getState().inspector.visible, false,
			'clicking × should hide the inspector');
	});

	test('title reflects total rows + filter state', () => {
		const root = mkRoot();
		const store = createStore();
		mountInspectorPanel(root, store);
		const title = root.querySelector<HTMLElement>('.qviz-inspector-title')!;

		assert.strictEqual(title.textContent, 'Inspector',
			'no data yet → bare title');

		// Simulate the daemon returning a preview window.
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array(0),
			offset: 0,
			n: 50,
			total: 12_345,
			elapsedMs: 12,
		});
		assert.ok(
			title.textContent!.includes('12,345'),
			`title should include locale-formatted total, got: ${title.textContent}`,
		);
		assert.ok(
			!title.textContent!.includes('filtered'),
			'no filter yet → no "(filtered)" suffix',
		);

		store.dispatch({
			type: 'setColumnFilter',
			column: 'sym',
			filter: { kind: 'set', column: 'sym', includes: ['A', 'B'] },
		});
		// setColumnFilter resets the window — re-emit a count to render.
		store.dispatch({
			type: 'inspectorDataReceived',
			arrow: new Uint8Array(0),
			offset: 0, n: 2, total: 2, elapsedMs: 3,
		});
		assert.ok(
			title.textContent!.includes('filtered'),
			`title should switch to filtered when a filter is active, got: ${title.textContent}`,
		);
	});

	test('mount adds body content only when inspector becomes visible', () => {
		const root = mkRoot();
		const store = createStore();
		mountInspectorPanel(root, store);
		const bodyWrap = root.querySelector<HTMLElement>('.qviz-inspector-body-wrap')!;

		// initial state: invisible -> body is empty
		assert.strictEqual(bodyWrap.children.length, 0,
			'body wrap empty when inspector hidden (lazy mount)');

		store.dispatch({ type: 'toggleInspector', visible: true });
		assert.ok(bodyWrap.children.length > 0,
			'becoming visible should mount the table sub-tree');

		store.dispatch({ type: 'toggleInspector', visible: false });
		assert.strictEqual(bodyWrap.children.length, 0,
			'going invisible should tear down the table sub-tree');
	});

	test('dispose() clears the DOM and removes the class', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountInspectorPanel(root, store);

		assert.ok(root.classList.contains('qviz-inspector-panel'));
		handle.dispose();
		assert.strictEqual(root.classList.contains('qviz-inspector-panel'), false);
		assert.strictEqual(root.innerHTML, '',
			'dispose should empty the root');

		// Subsequent store dispatch must not throw (listener detached).
		assert.doesNotThrow(() => {
			store.dispatch({ type: 'toggleInspector', visible: true });
		});
	});

	test('restores persisted width from sessionStorage on mount', () => {
		// Phase 6 Tier-9 (2026-05-11) namespaced sessionStorage key.
		window.sessionStorage.setItem('qviz.inspectorWidth.v1', '480px');
		const root = mkRoot();
		const store = createStore();
		const handle = mountInspectorPanel(root, store);

		const width = document.documentElement.style.getPropertyValue('--qviz-inspector-width');
		assert.strictEqual(width, '480px',
			'mount should restore --qviz-inspector-width from sessionStorage');
		handle.dispose();
	});

	test('legacy sessionStorage key is read when v1 key is absent', () => {
		window.sessionStorage.setItem('qviz.inspectorWidth', '360px');
		const root = mkRoot();
		const store = createStore();
		const handle = mountInspectorPanel(root, store);

		const width = document.documentElement.style.getPropertyValue('--qviz-inspector-width');
		assert.strictEqual(width, '360px',
			'mount should fall back to legacy sessionStorage key when v1 absent');
		handle.dispose();
	});
});
