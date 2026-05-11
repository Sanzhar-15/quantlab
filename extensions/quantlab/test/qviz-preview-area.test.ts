/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for previewArea -- Phase 9 step B.
 *
 * Phases 5 and 8 added several user-visible behaviors to the chart
 * preview pane that were never unit-tested because the test runner
 * lacked a DOM. With the Phase 9 jsdom-shim those behaviors now have
 * coverage:
 *
 *   - Skeleton overlay (Phase 8 Step C) shows/hides off `state.query.inflight`.
 *   - Retry buttons (Phase 8 Step D) toggle off `runtime.daemonStatus`
 *     and `runtime.datasetStatus`.
 *   - Stripe message text composes daemon + dataset + drift + inflight signals.
 *   - Diagnostics readout renders last error / last successful render.
 *   - `dispose()` detaches listeners and clears the DOM.
 *
 * Tests use a fresh in-memory store per case; mount the component into
 * a jsdom-backed div, dispatch actions, then assert on the rendered
 * DOM.
 */

// DOM globals installed by `out/test/helpers/mocha-setup.js` via mocha --require.
import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import { mountPreviewArea } from '../webview/qviz/components/previewArea';
import { createStore } from '../webview/qviz/state/store';

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

suite('previewArea -- Phase 9 jsdom coverage', () => {
	setup(() => { resetDom(); });

	test('mounts the chart container + stripe + diagnostics scaffolding', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountPreviewArea(root, store);

		assert.ok(root.classList.contains('qviz-preview-area'),
			'root should get qviz-preview-area class');
		assert.ok(handle.chartContainer instanceof HTMLElement,
			'chartContainer should be exposed for RendererHost');
		assert.ok(handle.chartContainer.classList.contains('qviz-preview-chart'));
		assert.ok(
			root.querySelector('.qviz-preview-skeleton'),
			'skeleton element should be in DOM',
		);
		assert.ok(
			root.querySelector('.qviz-preview-stripe'),
			'stripe element should be in DOM',
		);
		assert.ok(
			root.querySelector('.qviz-preview-diagnostics'),
			'diagnostics element should be in DOM',
		);

		handle.dispose();
	});

	test('skeleton hidden by default; becomes visible when query.inflight is set', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountPreviewArea(root, store);
		const skeleton = root.querySelector<HTMLElement>('.qviz-preview-skeleton')!;

		assert.strictEqual(skeleton.hidden, true,
			'skeleton should start hidden (no inflight request)');

		store.dispatch({
			type: 'requestStarted',
			requestId: 1, specHash: 'sha256:0000',
		});

		assert.strictEqual(skeleton.hidden, false,
			'skeleton should be visible while a daemon request is inflight');

		handle.dispose();
	});

	test('Phase 8 Step D: retry-daemon button hidden until daemonStatus is recoverable failure', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store, {
			onRetryDaemon: () => { /* tested separately */ },
		});

		const retryBtn = root.querySelector<HTMLButtonElement>('.qviz-preview-retry-daemon')!;
		assert.strictEqual(retryBtn.hidden, true,
			'retry button hidden when daemon is idle');

		store.dispatch({ type: 'daemonStatus', status: 'crashed', retryInMs: 250 });
		assert.strictEqual(retryBtn.hidden, false,
			'retry button visible when daemon is crashed');

		store.dispatch({ type: 'daemonStatus', status: 'ready' });
		assert.strictEqual(retryBtn.hidden, true,
			'retry button hidden again when daemon recovers');
	});

	test('Phase 8 Step D: retry-daemon click fires onRetryDaemon callback', () => {
		const root = mkRoot();
		const store = createStore();
		let calls = 0;
		mountPreviewArea(root, store, {
			onRetryDaemon: () => { calls += 1; },
		});

		store.dispatch({ type: 'daemonStatus', status: 'crashed', retryInMs: 250 });
		const retryBtn = root.querySelector<HTMLButtonElement>('.qviz-preview-retry-daemon')!;
		retryBtn.click();
		retryBtn.click();
		assert.strictEqual(calls, 2,
			'onRetryDaemon should fire on every click while visible');
	});

	test('Phase 8 Step D: recheck-dataset button toggles off datasetStatus', () => {
		const root = mkRoot();
		const store = createStore();
		let calls = 0;
		mountPreviewArea(root, store, {
			onRecheckDataset: () => { calls += 1; },
		});

		const recheckBtn = root.querySelector<HTMLButtonElement>('.qviz-preview-recheck-dataset')!;
		assert.strictEqual(recheckBtn.hidden, true,
			'recheck button hidden when dataset is ok');

		store.dispatch({
			type: 'datasetStatus',
			status: 'missing', datasetUri: 'file:///gone.csv',
		});
		assert.strictEqual(recheckBtn.hidden, false,
			'recheck button visible when dataset is missing');

		recheckBtn.click();
		assert.strictEqual(calls, 1, 'onRecheckDataset should fire on click');

		store.dispatch({
			type: 'datasetStatus',
			status: 'ok', datasetUri: 'file:///x.csv',
		});
		assert.strictEqual(recheckBtn.hidden, true,
			'recheck button hides when dataset is ok');
	});

	test('stripe message composes daemon + inflight signals', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store);

		const msg = root.querySelector<HTMLElement>('.qviz-preview-stripe-message')!;
		assert.strictEqual(msg.textContent, '',
			'stripe message empty by default');

		store.dispatch({
			type: 'requestStarted',
			requestId: 1, specHash: 'sha256:abc',
		});
		assert.ok(
			msg.textContent!.includes('computing'),
			`expected 'computing' in stripe, got: ${msg.textContent}`,
		);

		store.dispatch({
			type: 'daemonStatus', status: 'unavailable', lastError: 'pipe broken',
		});
		assert.ok(
			msg.textContent!.includes('Daemon unavailable'),
			`expected daemon-unavailable text, got: ${msg.textContent}`,
		);
		assert.ok(
			msg.textContent!.includes('pipe broken'),
			'daemon error should be appended to message',
		);
	});

	test('dispose() removes class, listeners, and contents', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountPreviewArea(root, store);

		assert.ok(root.classList.contains('qviz-preview-area'));
		handle.dispose();

		assert.strictEqual(root.classList.contains('qviz-preview-area'), false,
			'dispose should drop the qviz-preview-area class');
		assert.strictEqual(root.innerHTML, '',
			'dispose should clear the root inner HTML');

		// After dispose, further actions must NOT throw (no orphan
		// listener still attached to the store).
		assert.doesNotThrow(() => {
			store.dispatch({
				type: 'requestStarted',
				requestId: 99, specHash: 'sha256:0',
			});
		});
	});

	// Megaudit M-9 cure: stripe display:none toggle must be asserted,
	// not just stripeMessage textContent.
	test('stripe is display:none when there is nothing to show', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store);
		const stripe = root.querySelector<HTMLElement>('.qviz-preview-stripe');
		assert.ok(stripe);
		assert.strictEqual(stripe!.style.display, 'none',
			'fresh mount with no inflight/drift/error should hide the stripe');
	});

	test('stripe display flips to non-none when a request goes inflight', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store);
		const stripe = root.querySelector<HTMLElement>('.qviz-preview-stripe');
		store.dispatch({ type: 'requestStarted', requestId: 1, specHash: 'sha256:a' });
		assert.notStrictEqual(stripe!.style.display, 'none',
			'inflight must show the stripe');
		// And back to none after the data arrives.
		store.dispatch({
			type: 'dataReceived', requestId: 1, specHash: 'sha256:a',
			arrow: new Uint8Array(0), elapsedMs: 1, cached: false, diagnostics: [],
		});
		assert.strictEqual(stripe!.style.display, 'none',
			'after dataReceived clears inflight, stripe should hide again');
	});

	// Megaudit M-10 cure: diagnostics renderer for the error path
	// formats as `[errorKind] (transform #N) message`.
	test('diagnostics shows daemon error with kind + transform index', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store);
		const diag = root.querySelector<HTMLElement>('.qviz-preview-diagnostics');
		assert.ok(diag);
		store.dispatch({ type: 'requestStarted', requestId: 1, specHash: 'sha256:a' });
		store.dispatch({
			type: 'errorReceived', requestId: 1, specHash: 'sha256:a',
			error: 'column not in schema',
			errorKind: 'compile',
			transformIndex: 2,
		});
		const text = diag!.textContent ?? '';
		assert.ok(text.includes('[compile]'),
			`diagnostics must include the errorKind tag, got ${JSON.stringify(text)}`);
		assert.ok(text.includes('transform #2'),
			`diagnostics must include the transform index, got ${JSON.stringify(text)}`);
		assert.ok(text.includes('column not in schema'),
			`diagnostics must include the message, got ${JSON.stringify(text)}`);
	});

	test('stripe shows fields-missing drift banner with field names', () => {
		const root = mkRoot();
		const store = createStore();
		mountPreviewArea(root, store);
		const stripe = root.querySelector<HTMLElement>('.qviz-preview-stripe');

		store.dispatch({
			type: 'schemaChanged',
			oldHash: 'sha256:a', newHash: 'sha256:b',
			drift: 'fields-missing',
			newSchema: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:b',
				mtime_ns: 2,
				row_count: 100,
				columns: [{ name: 'time', dtype: 'TIMESTAMP', nullable: false }],
			},
			missingFields: ['close', 'volume'],
		});
		const text = stripe!.textContent ?? '';
		assert.ok(text.toLowerCase().includes('field') || text.toLowerCase().includes('missing'),
			`fields-missing banner must mention fields/missing, got ${JSON.stringify(text)}`);
		assert.ok(text.includes('close'),
			`banner should name the missing field 'close'`);
		assert.ok(text.includes('volume'),
			`banner should name the missing field 'volume'`);
	});
});
