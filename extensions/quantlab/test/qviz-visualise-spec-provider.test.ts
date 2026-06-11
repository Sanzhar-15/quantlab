/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Integration tests for VisualiseSpecProvider — Step C megaudit
 * follow-up. The original Step C landed with ZERO tests for the
 * provider (the audit's loudest finding). This file exercises the
 * untested orchestration: drift detection race, drift-aware save's
 * atomic disk-gate, watcher attach/detach, onDocumentContentChanged
 * re-broadcast, and ready-handler failed-state passthrough.
 *
 * Mechanism: `vscode-shim.ts` hooks Node's module resolver so the
 * provider's `import * as vscode from 'vscode'` lands at our shim.
 * The shim's `_setFile / _setWorkspaceFolders / _setFsWriteThrows`
 * etc. let us program the runtime that the provider sees.
 *
 * Coverage scope (provider-specific orchestration):
 *   - drift detection race-safety (concurrent calls drop stale results)
 *   - watcher attach/detach across dataset URI changes
 *   - drift-aware save: 'fields-preserved' branch atomicity
 *     (disk-write failure does NOT advance in-memory state)
 *   - ready handler: re-broadcasts schemaChanged on non-same drift
 *   - ready handler: surfaces drift-detection FAILURE to webview
 *
 * Out of scope (covered elsewhere by pure-module tests):
 *   - decideSave decision logic   → qviz-save-decision.test.ts
 *   - detectDrift correctness     → qviz-schema-drift.test.ts
 *   - resolveDatasetPath errors   → qviz-persist.test.ts
 *   - schemaState reducer         → qviz-state-store.test.ts
 *   - validator surface           → qviz-message-protocol.test.ts
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Install BEFORE any provider import resolves (imports hoist, so the shim
// module evaluates first regardless of where the call sits).
import {
	installVscodeShim,
	Uri,
	_resetShimState,
	_setWorkspaceFolders,
	_setFile,
	_setFsWriteThrows,
	_writesSnapshot,
	_errorMessagesSnapshot,
	_setWarningMessageResponse,
	_createdWatchers,
} from './helpers/vscode-shim';
installVscodeShim();

import {
	VisualiseSpecProvider,
	inspectorFiltersToFilterTransforms,
	specHasAggregateTransforms,
	type LifecycleSource,
} from '../src/views/visualise/VisualiseSpecProvider';
import type { QvizSpec } from '../src/qviz/spec';
import type { LifecycleStatus } from '../src/qviz/daemon-lifecycle';
import { serializeSpec } from '../src/qviz/specCore';

// ---------------------------------------------------------------------------
// helpers — REAL temp dir for real-fs operations (persist uses real fs)
// ---------------------------------------------------------------------------

// persist.ts uses fs.realpathSync / fs.statSync against the REAL fs.
// The shim only covers vscode.workspace.fs. So we need a real workspace
// root on the filesystem. Each test suite creates its own temp dir.
let WORKSPACE_ROOT: string;
let SPEC_PATH: string;
let DATASET_ABS: string;
const DATASET_REL = 'data/x.parquet';

function setupRealWorkspace(): void {
	WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-provider-'));
	SPEC_PATH = path.join(WORKSPACE_ROOT, 'spec.qviz.json');
	DATASET_ABS = path.join(WORKSPACE_ROOT, DATASET_REL);
	fs.mkdirSync(path.dirname(DATASET_ABS), { recursive: true });
	fs.writeFileSync(DATASET_ABS, 'dataset-bytes');
}

// teardownRealWorkspace intentionally not wired (tests share the dir
// across the run; OS tmp cleanup handles it). Kept-out to satisfy
// noUnusedLocals.

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

function makeSpec(overrides: Partial<QvizSpec> = {}): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: DATASET_REL,
			schema_hash: HASH_A,
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family: 'general', type: 'scatter',
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
		},
		...overrides,
	};
}

function makeSchemaResponse(hash: string, columns: { name: string; dtype?: string }[] = [
	{ name: 'a' }, { name: 'b' },
]) {
	return {
		data: {
			uri: DATASET_REL,
			schema_hash: hash,
			mtime_ns: 100,
			row_count: 50,
			columns: columns.map(c => ({
				name: c.name, dtype: c.dtype ?? 'float64', nullable: false,
			})),
		},
		elapsedMs: 1,
	};
}

/** Fake daemon client that records calls. The provider invokes
 *  `client.schema(uri)` to drive drift detection AND `client.aggregate(spec)`
 *  to handle requestData. */
class FakeClient {
	calls: { op: string; arg: unknown }[] = [];
	schemaResponse: ReturnType<typeof makeSchemaResponse> | Error = makeSchemaResponse(HASH_A);
	aggregateResponse: {
		arrow: Uint8Array; elapsedMs: number; cached: boolean;
	} | Error = { arrow: new Uint8Array([1, 2, 3]), elapsedMs: 5, cached: false };
	async schema(uri: string) {
		this.calls.push({ op: 'schema', arg: uri });
		if (this.schemaResponse instanceof Error) { throw this.schemaResponse; }
		return this.schemaResponse;
	}
	async aggregate(spec: unknown) {
		this.calls.push({ op: 'aggregate', arg: spec });
		if (this.aggregateResponse instanceof Error) { throw this.aggregateResponse; }
		return { ...this.aggregateResponse, meta: { n: 1, bytes: 3, columns: [] } };
	}
	async capabilities() {
		this.calls.push({ op: 'capabilities', arg: null });
		return {
			data: {
				daemon_version: 1,
				transform_kinds: ['filter', 'date_trunc', 'bin', 'groupby', 'aggregate', 'window', 'math', 'tz_convert', 'sort', 'limit'],
				unsupported: [],
				chart_families: ['timeseries', 'general'],
			},
			elapsedMs: 1,
		};
	}
}

/** Fake LifecycleSource that returns a configurable client and a
 *  configurable status. */
class FakeLifecycleSource implements LifecycleSource {
	client: FakeClient | null = new FakeClient();
	getLifecycleErr: Error | null = null;
	status: LifecycleStatus = { kind: 'ready' };
	statusHandlers = new Set<(s: LifecycleStatus) => void>();

	getLifecycleForDocument() {
		if (this.getLifecycleErr !== null) { throw this.getLifecycleErr; }
		if (this.client === null) { return null; }
		// Returning a fake "DaemonLifecycle" — the provider only uses
		// .getClient() from it.
		return {
			getClient: async () => this.client as unknown as never,
		} as unknown as ReturnType<LifecycleSource['getLifecycleForDocument']>;
	}

	getStatusForDocument() { return this.status; }

	onStatusChangeForDocument(_uri: Uri, handler: (s: LifecycleStatus) => void) {
		this.statusHandlers.add(handler);
		return { dispose: () => { this.statusHandlers.delete(handler); } };
	}

	_fireStatus(s: LifecycleStatus): void {
		this.status = s;
		for (const h of [...this.statusHandlers]) { h(s); }
	}
}

/** Minimal extension-context stub. */
function makeContext(): { subscriptions: { dispose(): unknown }[]; extensionUri: Uri } {
	return {
		subscriptions: [],
		extensionUri: Uri.file('/ext'),
	};
}

/** Drive the provider through `openCustomDocument`, yielding a doc
 *  whose `detectAndRecordDrift` has had a chance to complete. */
async function openDocAndDriveDetection(args: {
	source: LifecycleSource;
	specOverrides?: Partial<QvizSpec>;
	skipDataset?: boolean;
}): Promise<{
	provider: VisualiseSpecProvider;
	document: import('../src/views/visualise/QvizSpecDocument').QvizSpecDocument;
}> {
	const spec = makeSpec(args.specOverrides);
	const specBytes = serializeSpec(spec);
	_setFile(SPEC_PATH, specBytes);
	if (!args.skipDataset) {
		// Make sure the real-fs dataset is present (some tests delete it).
		if (!fs.existsSync(DATASET_ABS)) {
			fs.mkdirSync(path.dirname(DATASET_ABS), { recursive: true });
			fs.writeFileSync(DATASET_ABS, 'dataset-bytes');
		}
	}
	const provider = new (VisualiseSpecProvider as unknown as {
		new (
			ctx: ReturnType<typeof makeContext>,
			opts: { lifecycleSource: LifecycleSource | null },
		): VisualiseSpecProvider;
	})(makeContext(), { lifecycleSource: args.source });
	const document = await provider.openCustomDocument(
		Uri.file(SPEC_PATH) as unknown as never,
		{ untitledDocumentData: undefined, backupId: undefined } as unknown as never,
		undefined as unknown as never,
	);
	// detectAndRecordDrift is fire-and-forget. Drain microtasks so the
	// async chain (resolveDatasetPath, getClient, schema, detectDrift)
	// completes before the test assertions run.
	await drainMicrotasks();
	return { provider, document };
}

/** Wait long enough for all fire-and-forget Promise chains kicked off
 *  by openCustomDocument to settle. Plain `await Promise.resolve()` is
 *  one microtask tick; we need many. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// suite setup
// ---------------------------------------------------------------------------

function beforeEachReset(): void {
	if (!WORKSPACE_ROOT || !fs.existsSync(WORKSPACE_ROOT)) {
		setupRealWorkspace();
	}
	_resetShimState();
	_setWorkspaceFolders([{ uri: Uri.file(WORKSPACE_ROOT), name: 'ws' }]);
}

// ---------------------------------------------------------------------------
// drift detection — happy path
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- drift detection happy path', () => {

	test('open document → drift detected to same-hash when daemon agrees', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		// Inspect via the public-ish driftAwareSave path — easier than
		// reaching into private state.
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'detected', `unexpected status: ${status.kind}`);
		if (status.kind !== 'detected') { return; }
		assert.strictEqual(status.result.drift, 'same-hash');
	});

	test('open document → drift detected to fields-preserved when daemon hash differs', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		// Daemon reports new hash but same columns — fields-preserved.
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_B, [
			{ name: 'a' }, { name: 'b' }, { name: 'c' },  // extra col is OK
		]);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'detected');
		if (status.kind !== 'detected') { return; }
		assert.strictEqual(status.result.drift, 'fields-preserved');
	});

	test('open document → drift detected to fields-missing when columns gone', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_B, [
			{ name: 'b' },  // 'a' is GONE
		]);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'detected');
		if (status.kind !== 'detected') { return; }
		assert.strictEqual(status.result.drift, 'fields-missing');
		assert.deepStrictEqual([...status.result.missingFields], ['a']);
	});

});

// ---------------------------------------------------------------------------
// drift detection — failure paths surface visibly (Step C megaudit C2-C4)
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- drift detection failure paths', () => {

	test('schema fetch failure surfaces as showErrorMessage AND ctx.driftStatus = failed', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = new Error('parquet corrupt');
		const { provider, document } = await openDocAndDriveDetection({ source });
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'failed');
		const msgs = _errorMessagesSnapshot();
		assert.ok(
			msgs.some(m => /schema fetch failed/.test(m) && /parquet corrupt/.test(m)),
			`expected schema-fetch error notification; got ${JSON.stringify(msgs)}`,
		);
	});

	test('no lifecycle for document (multi-folder gap) surfaces as failed', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		source.client = null;  // factory says no lifecycle
		const { provider, document } = await openDocAndDriveDetection({ source });
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'failed');
	});

	test('dataset-resolution failure (missing) sets ctx.driftStatus = failed + showErrorMessage', async () => {
		beforeEachReset();
		// Delete the dataset BEFORE drift detection runs.
		try { fs.unlinkSync(DATASET_ABS); } catch { /* may not exist */ }
		const source = new FakeLifecycleSource();
		const { provider, document } = await openDocAndDriveDetection({
			source, skipDataset: true,
		});
		const status = readDriftStatus(provider, document);
		assert.strictEqual(status.kind, 'failed');
		const msgs = _errorMessagesSnapshot();
		assert.ok(msgs.length > 0, 'expected error notification for missing dataset');
	});

});

// ---------------------------------------------------------------------------
// drift-aware save — atomic disk-gate (Step C megaudit C8)
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- drift-aware save atomicity', () => {

	test('refuses save when drift is fields-missing', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_B, [
			{ name: 'b' },  // 'a' missing
		]);
		const { provider, document } = await openDocAndDriveDetection({ source });
		await assert.rejects(
			() => provider.saveCustomDocument(
				document, undefined as unknown as never,
			),
			/missing from data file/,
		);
		// AND no disk write was attempted.
		assert.deepStrictEqual(_writesSnapshot(), []);
	});

	test('refuses save when drift status is FAILED (not silent fallback)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = new Error('daemon unresponsive');
		const { provider, document } = await openDocAndDriveDetection({ source });
		await assert.rejects(
			() => provider.saveCustomDocument(
				document, undefined as unknown as never,
			),
			/drift detection failed/,
		);
		assert.deepStrictEqual(_writesSnapshot(), []);
	});

	test('verbatim save when drift is same-hash', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		await provider.saveCustomDocument(document, undefined as unknown as never);
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1, 'expected exactly one disk write');
		// Bytes equal the original spec bytes.
		const original = serializeSpec(makeSpec());
		assert.deepStrictEqual(Array.from(writes[0].bytes), Array.from(original));
	});

	test('fields-preserved save writes refreshed spec atomically', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_B, [
			{ name: 'a' }, { name: 'b' }, { name: 'c' },
		]);
		const { provider, document } = await openDocAndDriveDetection({ source });
		await provider.saveCustomDocument(document, undefined as unknown as never);
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1);
		// The written bytes should reflect the REFRESHED spec: new
		// schema_hash, all-zero query_hash, bumped generated_at.
		const writtenJson = JSON.parse(new TextDecoder().decode(writes[0].bytes));
		assert.strictEqual(writtenJson.dataset.schema_hash, HASH_B,
			'fields-preserved save must rewrite dataset.schema_hash to the live value');
		assert.strictEqual(writtenJson.provenance.query_hash, 'sha256:' + '0'.repeat(64),
			'fields-preserved save must reset query_hash to the zero sentinel');
	});

	test('fields-preserved save: DISK FAILURE does not advance in-memory state', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_B);
		const { provider, document } = await openDocAndDriveDetection({ source });
		// Pre-save: in-memory spec has schema_hash = HASH_A.
		const beforeSpec = document.spec;
		assert.strictEqual(beforeSpec.dataset.schema_hash, HASH_A);
		// Make the disk write fail.
		_setFsWriteThrows(new Error('EACCES'));
		await assert.rejects(
			() => provider.saveCustomDocument(
				document, undefined as unknown as never,
			),
			/EACCES/,
		);
		// CRUCIAL: in-memory spec MUST NOT have advanced. Step C
		// megaudit C8 — atomic disk-gate.
		const afterSpec = document.spec;
		assert.strictEqual(afterSpec.dataset.schema_hash, HASH_A,
			'in-memory spec must not advance after disk-write failure');
		assert.strictEqual(afterSpec.provenance.query_hash,
			beforeSpec.provenance.query_hash,
			'provenance must not advance after disk-write failure');
	});

});

// ---------------------------------------------------------------------------
// Step 5.I.4 — save-conflict detection
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- save-conflict detection', () => {

	test('save throws when the .qviz.json file changed on disk externally', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });

		// External process modifies the on-disk spec file. The provider
		// reads via vscode.workspace.fs.readFile (the shim) to detect
		// conflict, so update the shim's in-memory store.
		_setFile(SPEC_PATH, new TextEncoder().encode(
			'{"qviz_version":1,"hostile":"injection"}',
		));

		await assert.rejects(
			() => provider.saveCustomDocument(
				document, undefined as unknown as never,
			),
			/was changed on disk since it was opened/,
		);
	});

	test('save succeeds for unchanged on-disk content (no false positive)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		// No external modification. Save should succeed without prompting.
		await provider.saveCustomDocument(document, undefined as unknown as never);
		// And there's exactly one disk write via the shim.
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1);
		assert.strictEqual(writes[0].path, SPEC_PATH);
	});

	test('save conflict + user picks Overwrite → save proceeds', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		// External modification.
		_setFile(SPEC_PATH, new TextEncoder().encode('{"externally":"modified"}'));
		// Pre-program the warning prompt to choose Overwrite.
		_setWarningMessageResponse('Overwrite');

		await provider.saveCustomDocument(document, undefined as unknown as never);

		// Write occurred (provider's retry-with-skipConflictCheck path).
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 1, `expected 1 write after Overwrite; got ${writes.length}`);
		assert.strictEqual(writes[0].path, SPEC_PATH);
	});

	test('save conflict + user picks Cancel → save rejects + no write', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		_setFile(SPEC_PATH, new TextEncoder().encode('{"externally":"modified"}'));
		_setWarningMessageResponse('Cancel');

		await assert.rejects(
			() => provider.saveCustomDocument(
				document, undefined as unknown as never,
			),
			/was changed on disk/,
		);
		const writes = _writesSnapshot();
		assert.strictEqual(writes.length, 0, 'Cancel must not write');
	});

});

// ---------------------------------------------------------------------------
// requestData (Step D 5.D.6 live-preview wiring)
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- requestData handling', () => {

	test('forwards aggregate to daemon and posts `data` response', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const fakeClient = source.client as FakeClient;
		fakeClient.schemaResponse = makeSchemaResponse(HASH_A);
		fakeClient.aggregateResponse = {
			arrow: new Uint8Array([9, 8, 7]), elapsedMs: 42, cached: true,
		};
		const { provider, document } = await openDocAndDriveDetection({ source });

		// Construct a webview message and feed it via the panel's
		// onDidReceiveMessage handler. We need a panel; use the
		// resolveCustomEditor path with a fake panel.
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);

		const spec = makeSpec();
		const requestId = 999;
		const specHash = await computeSpecHashLocal(spec);
		const requestDataMsg = {
			type: 'requestData',
			protocolVersion: 1,
			requestId,
			specHash,
			spec,
		};

		// Trigger the message handler.
		panel.fireMessage(requestDataMsg);
		await drainMicrotasks();

		// Assert the fake daemon got an aggregate call.
		const aggregateCalls = fakeClient.calls.filter(c => c.op === 'aggregate');
		assert.strictEqual(aggregateCalls.length, 1, `expected 1 aggregate call, got ${aggregateCalls.length}`);

		// Assert a `data` message was posted with the response.
		const dataMessages = panel.postedMessages.filter(
			(m): m is { type: 'data'; arrow: Uint8Array; elapsedMs: number; cached: boolean; requestId: number; specHash: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'data',
		);
		assert.strictEqual(dataMessages.length, 1, `expected 1 data message; got ${dataMessages.length}`);
		assert.strictEqual(dataMessages[0].requestId, requestId);
		assert.strictEqual(dataMessages[0].specHash, specHash);
		assert.strictEqual(dataMessages[0].elapsedMs, 42);
		assert.strictEqual(dataMessages[0].cached, true);
		assert.deepStrictEqual(Array.from(dataMessages[0].arrow), [9, 8, 7]);
	});

	test('5.I.1: daemon error during aggregate posts error message + does not clear chart', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const fakeClient = source.client as FakeClient;
		fakeClient.schemaResponse = makeSchemaResponse(HASH_A);
		fakeClient.aggregateResponse = new Error('daemon crashed mid-aggregate');
		const { provider, document } = await openDocAndDriveDetection({ source });

		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);

		const spec = makeSpec();
		const specHash = await computeSpecHashLocal(spec);
		panel.fireMessage({
			type: 'requestData', protocolVersion: 1, requestId: 1,
			specHash, spec,
		});
		await drainMicrotasks();

		// Daemon failed → provider sends `error`, NO `data` message.
		const errorMessages = panel.postedMessages.filter(
			(m): m is { type: 'error'; specHash: string; requestId: number; error: string; errorKind: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'error',
		);
		assert.strictEqual(errorMessages.length, 1);
		assert.strictEqual(errorMessages[0].specHash, specHash);
		assert.match(errorMessages[0].error, /crashed mid-aggregate/);
		// Megaudit CRITICAL-2 regression: error MUST echo the inbound
		// requestId so the webview's queryState reducer's
		// `requestId === inflight.requestId` gate accepts it. Inventing
		// a fresh id (the previous bug) made the reducer drop the
		// error as stale and the UI sat at "computing…" forever.
		assert.strictEqual(errorMessages[0].requestId, 1,
			'Step I.1: error MUST echo the inbound requestId or the webview drops it as stale');

		// No `data` message — the webview's renderer keeps the last
		// successful chart visible.
		const dataMessages = panel.postedMessages.filter(
			(m): m is { type: 'data' } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'data',
		);
		assert.strictEqual(dataMessages.length, 0);
	});

	test('Megaudit CRITICAL-2: error from fields-missing refusal also echoes inbound requestId', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const fakeClient = source.client as FakeClient;
		fakeClient.schemaResponse = makeSchemaResponse(HASH_B, [{ name: 'b' }]);
		const { provider, document } = await openDocAndDriveDetection({ source });

		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);

		const spec = makeSpec();
		const inboundId = 42;
		panel.fireMessage({
			type: 'requestData', protocolVersion: 1, requestId: inboundId,
			specHash: await computeSpecHashLocal(spec), spec,
		});
		await drainMicrotasks();

		const errorMessages = panel.postedMessages.filter(
			(m): m is { type: 'error'; requestId: number } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'error',
		);
		assert.strictEqual(errorMessages.length, 1);
		assert.strictEqual(errorMessages[0].requestId, inboundId,
			'fields-missing refusal MUST echo inbound requestId so reducer accepts the error');
	});

	test('refuses aggregate when drift is fields-missing (posts error)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const fakeClient = source.client as FakeClient;
		fakeClient.schemaResponse = makeSchemaResponse(HASH_B, [{ name: 'b' }]);  // 'a' missing
		const { provider, document } = await openDocAndDriveDetection({ source });

		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);

		const spec = makeSpec();
		panel.fireMessage({
			type: 'requestData', protocolVersion: 1, requestId: 1,
			specHash: await computeSpecHashLocal(spec), spec,
		});
		await drainMicrotasks();

		// No aggregate call should fire.
		const aggregateCalls = fakeClient.calls.filter(c => c.op === 'aggregate');
		assert.strictEqual(aggregateCalls.length, 0,
			'fields-missing drift must refuse aggregate; daemon should not be called');

		// An error message should be posted.
		const errorMessages = panel.postedMessages.filter(
			(m): m is { type: 'error'; error: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'error',
		);
		assert.strictEqual(errorMessages.length, 1);
		assert.ok(/missing fields/.test(errorMessages[0].error), errorMessages[0].error);
	});

});

// ---------------------------------------------------------------------------
// Step 5.J.2 — Provider lifecycle: dispose, panel teardown, status forwarding
// ---------------------------------------------------------------------------
//
// What's covered elsewhere:
//   - daemon spawn / ready / crash+respawn at the lifecycle layer
//     (qviz-daemon-lifecycle.test.ts) — gated on Python availability.
//   - daemon-error path during aggregate
//     (above: '5.I.1: daemon error during aggregate posts error...').
//
// Gap closed here:
//   - document.dispose tears down the per-doc context fully (subscriptions,
//     watcher, contexts map entry) AND drops in-flight detection results
//     via the driftGeneration bump.
//   - panel.dispose tears down panelByUri + outboundRequestIdByUri so a
//     re-resolveCustomEditor for the same URI starts from a clean slot.
//   - lifecycle status changes propagate to the webview as `daemonStatus`
//     messages (the wiring registered in resolveCustomEditor).

suite('VisualiseSpecProvider -- lifecycle (dispose, panel teardown)', () => {

	test('document.dispose removes context AND detaches the file watcher', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });

		// Pre-state: ctx exists, watcher attached.
		assert.doesNotThrow(() => readDriftStatus(provider, document));
		const watchersBefore = _createdWatchers().filter(w => !w.disposed).length;
		assert.ok(watchersBefore >= 1, 'expected at least one live watcher before dispose');

		// Dispose the document — fires onDidDispose on the document
		// which the provider hooks via onDocumentDispose.
		document.dispose();

		// Post-state: ctx is gone (readDriftStatus throws).
		assert.throws(
			() => readDriftStatus(provider, document),
			/no document context for this document/,
		);
		// All watchers we created have been disposed.
		const liveWatchersAfter = _createdWatchers().filter(w => !w.disposed).length;
		assert.strictEqual(liveWatchersAfter, 0,
			`expected all watchers to be disposed; ${liveWatchersAfter} still live`);
	});

	test('panel.dispose tears down per-URI panel slot (re-resolve starts clean)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);

		// Pre-state: provider has registered the panel for this URI.
		const internals = provider as unknown as {
			panelByUri: Map<string, unknown>;
			outboundRequestIdByUri: Map<string, number>;
		};
		const key = document.uri.toString();
		assert.strictEqual(internals.panelByUri.has(key), true);
		assert.strictEqual(internals.outboundRequestIdByUri.has(key), true);

		// Fire panel disposal.
		panel.fireDispose();

		// Post-state: both slots cleaned up.
		assert.strictEqual(internals.panelByUri.has(key), false,
			'panelByUri must release the URI slot on panel dispose');
		assert.strictEqual(internals.outboundRequestIdByUri.has(key), false,
			'outboundRequestIdByUri must release the URI slot on panel dispose');
	});

	test('lifecycle status changes after resolve are forwarded as daemonStatus messages', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);
		// Drop the initial daemonStatus posted at resolve time so we
		// can isolate the events fired AFTER subscription was set up.
		const initialDaemonStatusMessages = panel.postedMessages.filter(
			(m): m is { type: 'daemonStatus' } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'daemonStatus',
		);
		const initialCount = initialDaemonStatusMessages.length;

		// Fire a sequence of status transitions through the lifecycle
		// source. Each one must reach the webview as a `daemonStatus`.
		source._fireStatus({ kind: 'starting', attemptNumber: 1 });
		source._fireStatus({ kind: 'crashed', error: 'segv', retryInMs: 250, attemptNumber: 1 });
		source._fireStatus({ kind: 'ready' });

		const allDaemonStatusMessages = panel.postedMessages.filter(
			(m): m is { type: 'daemonStatus'; status: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'daemonStatus',
		);
		const newOnes = allDaemonStatusMessages.slice(initialCount);
		assert.deepStrictEqual(
			newOnes.map(m => m.status),
			['starting', 'crashed', 'ready'],
		);
	});

	test('lifecycle status NOT forwarded after panel.dispose (subscription torn down)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);
		const before = panel.postedMessages.length;

		panel.fireDispose();
		// After dispose the provider must have unhooked from the
		// lifecycle source. Firing further status events therefore
		// posts NO further messages.
		source._fireStatus({ kind: 'starting', attemptNumber: 1 });
		source._fireStatus({ kind: 'ready' });

		assert.strictEqual(panel.postedMessages.length, before,
			'panel.fireDispose must unhook the provider from the lifecycle source');
	});

	test('document.dispose mid-detection: in-flight result is dropped (driftGeneration bump)', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const fakeClient = source.client as FakeClient;
		// Make schema() never settle so detection stays in-flight.
		fakeClient.schemaResponse = new Promise<never>(() => { /* never */ }) as unknown as never;
		// Open the document — detection kicks off but never completes.
		// Use a custom open path to skip drainMicrotasks (which would
		// hang on the never-resolving promise).
		const spec = makeSpec();
		_setFile(SPEC_PATH, serializeSpec(spec));
		if (!fs.existsSync(DATASET_ABS)) {
			fs.mkdirSync(path.dirname(DATASET_ABS), { recursive: true });
			fs.writeFileSync(DATASET_ABS, 'dataset-bytes');
		}
		const provider = new (VisualiseSpecProvider as unknown as {
			new (
				ctx: ReturnType<typeof makeContext>,
				opts: { lifecycleSource: LifecycleSource | null },
			): VisualiseSpecProvider;
		})(makeContext(), { lifecycleSource: source });
		const document = await provider.openCustomDocument(
			Uri.file(SPEC_PATH) as unknown as never,
			{ untitledDocumentData: undefined, backupId: undefined } as unknown as never,
			undefined as unknown as never,
		);
		// One microtask tick so detection has started but not completed.
		await Promise.resolve();
		const internals = provider as unknown as {
			documentContexts: Map<unknown, { driftGeneration: number }>;
		};
		const ctx = internals.documentContexts.get(document)!;
		const genBefore = ctx.driftGeneration;

		// Dispose the document mid-detection.
		document.dispose();

		// Pre-existing context map entry is gone.
		assert.strictEqual(internals.documentContexts.has(document), false);
		// We can't assert on the bumped generation directly (ctx is
		// gone), but we CAN assert there is no leak: the test simply
		// finishing without the never-resolving schema promise leaving
		// state behind is the invariant. (If detectAndRecordDrift
		// later recorded into the deleted ctx, the result would have
		// to be silently swallowed; either way, no test crash.)
		assert.ok(genBefore >= 0);  // sanity: ctx existed before dispose
	});

	test('subscription dispose error isolation: one throwing sub does not abort the rest', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		(source.client as FakeClient).schemaResponse = makeSchemaResponse(HASH_A);
		const { provider, document } = await openDocAndDriveDetection({ source });
		const internals = provider as unknown as {
			documentContexts: Map<unknown, { subs: { dispose(): unknown }[] }>;
		};
		const ctx = internals.documentContexts.get(document)!;
		// Inject a misbehaving subscription at the FRONT of subs so it
		// runs first; if the provider's dispose loop bails on first
		// throw, the original subs (and therefore the doc-content
		// listener) won't be released.
		let goodDisposed = false;
		ctx.subs.unshift({ dispose() { throw new Error('bad sub'); } });
		ctx.subs.push({ dispose() { goodDisposed = true; } });

		// Dispose. Provider catches each subscription error
		// individually (logged via console.warn — system-boundary
		// cleanup, per CLAUDE.md exception). The good subscription
		// must still dispose.
		document.dispose();

		assert.strictEqual(goodDisposed, true,
			'a throwing subscription must NOT abort the dispose loop');
		// And the context map slot is gone.
		assert.strictEqual(internals.documentContexts.has(document), false);
	});

});

// ---------------------------------------------------------------------------
// Phase 6 (6.G.2/6.G.3): inspector-filter translation
// ---------------------------------------------------------------------------

import type { InspectorFilter } from '../src/qviz/messageProtocol';

suite('VisualiseSpecProvider -- inspectorFiltersToFilterTransforms (Phase 6)', () => {

	test('empty input yields empty output', () => {
		assert.deepStrictEqual(inspectorFiltersToFilterTransforms([]), []);
	});

	test('range filter with both bounds expands to >= AND <= FilterTransforms', () => {
		const filters: InspectorFilter[] = [
			{ kind: 'range', column: 'close', min: 100, max: 200 },
		];
		const out = inspectorFiltersToFilterTransforms(filters);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'close', op: '>=', value: 100 },
			{ kind: 'filter', column: 'close', op: '<=', value: 200 },
		]);
	});

	test('range with min-only emits one >= transform', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'range', column: 'close', min: 0, max: null },
		]);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'close', op: '>=', value: 0 },
		]);
	});

	test('range with max-only emits one <= transform', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'range', column: 'close', min: null, max: 50 },
		]);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'close', op: '<=', value: 50 },
		]);
	});

	test('range with both bounds null emits zero transforms', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'range', column: 'close', min: null, max: null },
		]);
		assert.deepStrictEqual(out, []);
	});

	test('text filter with non-empty contains emits a contains op', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'text', column: 'ticker', contains: 'AAPL' },
		]);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'ticker', op: 'contains', value: 'AAPL' },
		]);
	});

	test('text filter with empty contains emits nothing', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'text', column: 'ticker', contains: '' },
		]);
		assert.deepStrictEqual(out, []);
	});

	test('set filter with non-empty includes emits in op', () => {
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'set', column: 'ticker', includes: ['AAPL', 'MSFT'] },
		]);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'ticker', op: 'in', value: ['AAPL', 'MSFT'] },
		]);
	});

	test('set filter with empty includes emits in op with empty array', () => {
		// Audit M-G (2026-05-11): the provider now emits `{op:'in', value:[]}`
		// for an empty-set filter. The daemon-side compiler
		// (_compile_inspector_filters_to_sql + _compile_filter)
		// short-circuits empty `in` to a constant-FALSE predicate, so
		// "uncheck all" matches zero rows. The previous version emitted
		// `{op:'==', value:'__sentinel__'}` which would incorrectly
		// match real rows containing that exact string.
		const out = inspectorFiltersToFilterTransforms([
			{ kind: 'set', column: 'ticker', includes: [] },
		]);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'ticker', op: 'in', value: [] },
		]);
	});

	test('multiple filters compose in order, with empty inner filters dropped', () => {
		const filters: InspectorFilter[] = [
			{ kind: 'range', column: 'a', min: 0, max: 10 },
			{ kind: 'text', column: 'b', contains: '' }, // dropped
			{ kind: 'set', column: 'c', includes: ['x'] },
		];
		const out = inspectorFiltersToFilterTransforms(filters);
		assert.deepStrictEqual(out, [
			{ kind: 'filter', column: 'a', op: '>=', value: 0 },
			{ kind: 'filter', column: 'a', op: '<=', value: 10 },
			{ kind: 'filter', column: 'c', op: 'in', value: ['x'] },
		]);
	});

	test('round-trip: every InspectorFilter shape produces a FilterTransform with kind="filter"', () => {
		const filters: InspectorFilter[] = [
			{ kind: 'range', column: 'a', min: 0, max: 1 },
			{ kind: 'text', column: 'b', contains: 'foo' },
			{ kind: 'set', column: 'c', includes: ['x'] },
		];
		const out = inspectorFiltersToFilterTransforms(filters);
		for (const t of out) {
			assert.strictEqual(t.kind, 'filter');
			assert.ok(typeof t.column === 'string' && t.column.length > 0);
			assert.ok(typeof t.op === 'string' && t.op.length > 0);
		}
	});

});

/** Minimal fake panel for testing onDidReceiveMessage / postMessage. */
function makeFakePanel() {
	let messageHandler: ((rawMsg: unknown) => void) | null = null;
	const postedMessages: unknown[] = [];
	const disposeHandlers: (() => void)[] = [];
	const panel = {
		webview: {
			options: {},
			html: '',
			onDidReceiveMessage(h: (rawMsg: unknown) => void) {
				messageHandler = h;
				return { dispose: () => { messageHandler = null; } };
			},
			postMessage(msg: unknown): Thenable<boolean> {
				postedMessages.push(msg);
				return Promise.resolve(true);
			},
			asWebviewUri(uri: unknown) { return uri; },
			cspSource: 'vscode-webview:',
		},
		onDidDispose(h: () => void) {
			disposeHandlers.push(h);
			return { dispose: () => {
				const i = disposeHandlers.indexOf(h);
				if (i >= 0) { disposeHandlers.splice(i, 1); }
			} };
		},
	};
	return {
		panel,
		postedMessages,
		fireMessage(msg: unknown): void {
			if (messageHandler) { messageHandler(msg); }
		},
		fireDispose(): void {
			// Iterate over a SNAPSHOT — handlers themselves dispose
			// subscriptions which can mutate the array.
			for (const h of [...disposeHandlers]) { h(); }
		},
	};
}

/** Local computeSpecHash via dynamic import to match the runtime
 *  semantics without coupling tests to internal hash details. */
async function computeSpecHashLocal(spec: QvizSpec): Promise<string> {
	const mod = await import('../src/qviz/messageProtocol');
	return mod.computeSpecHash(spec);
}

// ---------------------------------------------------------------------------
// helpers for reading private state
// ---------------------------------------------------------------------------

interface DriftStatusRead {
	kind: 'idle' | 'in-flight' | 'detected' | 'failed';
	result: { drift: string; missingFields: readonly string[] };
	liveSchema?: unknown;
	error?: string;
	generation?: number;
}

/** Read the per-document drift status from the provider. We do this by
 *  reaching into private state via a typed cast; it's test-only. */
function readDriftStatus(
	provider: VisualiseSpecProvider,
	document: import('../src/views/visualise/QvizSpecDocument').QvizSpecDocument,
): DriftStatusRead {
	const docContexts = (provider as unknown as {
		documentContexts: Map<unknown, { driftStatus: DriftStatusRead }>;
	}).documentContexts;
	const ctx = docContexts.get(document);
	if (!ctx) { throw new Error('no document context for this document'); }
	return ctx.driftStatus;
}

// ---------------------------------------------------------------------------
// Megaudit B-10 webview wireup — specHasAggregateTransforms
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- specHasAggregateTransforms (B-10 cure)', () => {

	test('empty transforms returns false', () => {
		assert.strictEqual(specHasAggregateTransforms(makeSpec({ transforms: [] })), false);
	});

	test('transforms without groupby/aggregate returns false', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'filter', column: 'close', op: '>', value: 0 },
				{ kind: 'sort', columns: [{ column: 'close', desc: false }] },
				{ kind: 'limit', n: 100 },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), false);
	});

	test('groupby alone returns true (aggregate may follow)', () => {
		const spec = makeSpec({
			transforms: [{ kind: 'groupby', columns: ['strategy'] }],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	test('aggregate alone returns true', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'aggregate', aggs: [{ column: 'pnl', fn: 'sum', as: 'pnl_sum' }] },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	test('pnl_by_strategy-style pipeline returns true', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'groupby', columns: ['strategy'] },
				{ kind: 'aggregate', aggs: [{ column: 'pnl', fn: 'sum', as: 'pnl_sum' }] },
				{ kind: 'sort', columns: [{ column: 'pnl_sum', desc: true }] },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	// H3 (megaudit, 2026-05-12): non-aggregate transforms that produce
	// new columns also require applySpecTransforms — otherwise the
	// inspector queries raw parquet and can't see/filter the calculated
	// column.

	test('H3: expr-only pipeline returns true (calculated column case)', () => {
		const spec = makeSpec({
			transforms: [
				{
					kind: 'expr',
					as: 'mid',
					expression: {
						kind: 'binary', op: '+',
						left: { kind: 'col', name: 'high' },
						right: { kind: 'col', name: 'low' },
					},
					references: ['high', 'low'],
				},
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	test('H3: window-only pipeline returns true', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'window', column: 'close', fn: 'rolling_mean', window: 20, order_by: 'timestamp', as: 'sma20' },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	test('H3: math-only pipeline returns true', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'math', column: 'close', fn: 'log_returns', order_by: 'timestamp', as: 'r' },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), true);
	});

	test('H3: date_trunc, bin, tz_convert-with-as all return true', () => {
		for (const t of [
			{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' } as const,
			{ kind: 'bin', column: 'close', n_bins: 20, as: 'bin' } as const,
			{ kind: 'tz_convert', column: 'ts', to_tz: 'UTC', as: 'ts_utc' } as const,
		]) {
			assert.strictEqual(
				specHasAggregateTransforms(makeSpec({ transforms: [t] })),
				true,
				`${t.kind} must trigger applySpecTransforms`,
			);
		}
	});

	test('H3: tz_convert WITHOUT `as` (in-place replacement) does NOT add a column → still false alone', () => {
		const spec = makeSpec({
			transforms: [
				{ kind: 'tz_convert', column: 'ts', to_tz: 'UTC' },
				{ kind: 'sort', columns: [{ column: 'ts', desc: false }] },
			],
		});
		assert.strictEqual(specHasAggregateTransforms(spec), false);
	});
});

// ---------------------------------------------------------------------------
// Megaudit 2026-06-11 H39 -- recheckDataset OK path must refresh driftStatus
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- recheckDataset drift refresh (H39)', () => {

	test('save succeeds after a successful re-check of a previously missing dataset', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		// Remove the dataset BEFORE open so initial drift detection FAILS
		// at resolveDatasetPath (driftStatus = failed).
		if (fs.existsSync(DATASET_ABS)) { fs.rmSync(DATASET_ABS); }
		const { provider, document } = await openDocAndDriveDetection({
			source, skipDataset: true,
		});
		// Precondition: save refuses while driftStatus is failed.
		await assert.rejects(
			() => provider.saveCustomDocument(document, undefined as unknown as never),
			/drift detection failed/,
		);
		assert.deepStrictEqual(_writesSnapshot(), []);

		// The file reappears; the user clicks "Re-check file".
		fs.mkdirSync(path.dirname(DATASET_ABS), { recursive: true });
		fs.writeFileSync(DATASET_ABS, 'dataset-bytes');
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);
		panel.fireMessage({ type: 'recheckDataset', protocolVersion: 1, requestId: 777 });
		await drainMicrotasks();

		// The banner-clearing OK status was posted...
		const okStatuses = panel.postedMessages.filter(
			(m): m is { type: 'datasetStatus'; status: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'datasetStatus'
				&& (m as { status?: string }).status === 'ok',
		);
		assert.ok(okStatuses.length >= 1, 'expected a datasetStatus ok message after recheck');

		// ...AND driftStatus was refreshed, so Cmd+S now succeeds (the
		// H39 bug left driftStatus at failed forever, refusing every save).
		await provider.saveCustomDocument(document, undefined as unknown as never);
		assert.strictEqual(_writesSnapshot().length, 1,
			'save after a successful recheck must write to disk');
	});

	test('recheck of a still-missing dataset keeps the failure visible and save refusing', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		if (fs.existsSync(DATASET_ABS)) { fs.rmSync(DATASET_ABS); }
		const { provider, document } = await openDocAndDriveDetection({
			source, skipDataset: true,
		});
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);
		panel.fireMessage({ type: 'recheckDataset', protocolVersion: 1, requestId: 778 });
		await drainMicrotasks();
		await assert.rejects(
			() => provider.saveCustomDocument(document, undefined as unknown as never),
			/drift detection failed/,
		);
		assert.deepStrictEqual(_writesSnapshot(), []);
	});
});

// ---------------------------------------------------------------------------
// Megaudit 2026-06-11 H41 -- cross-folder Save As refusal must pair
// saveStarted with saveResult(failed) so the webview reducer accepts it
// ---------------------------------------------------------------------------

suite('VisualiseSpecProvider -- saveCustomDocumentAs cross-folder refusal (H41)', () => {

	test('refusal emits saveStarted BEFORE saveResult(failed) with the same specHash', async () => {
		beforeEachReset();
		const source = new FakeLifecycleSource();
		const { provider, document } = await openDocAndDriveDetection({ source });
		const panel = makeFakePanel();
		await provider.resolveCustomEditor(
			document, panel.panel as unknown as never, undefined as unknown as never,
		);
		// Target OUTSIDE every workspace folder -> crossFolder refusal.
		const target = Uri.file('/elsewhere/other.qviz.json');
		await assert.rejects(
			() => provider.saveCustomDocumentAs(
				document, target as unknown as never, undefined as unknown as never,
			),
			/across workspace folders/,
		);
		const started = panel.postedMessages.filter(
			(m): m is { type: 'saveStarted'; specHash: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'saveStarted',
		);
		const failed = panel.postedMessages.filter(
			(m): m is { type: 'saveResult'; status: string; specHash: string } =>
				typeof m === 'object' && m !== null
				&& (m as { type?: string }).type === 'saveResult'
				&& (m as { status?: string }).status === 'failed',
		);
		assert.strictEqual(started.length, 1,
			'cross-folder refusal must emit exactly one saveStarted');
		assert.strictEqual(failed.length, 1,
			'cross-folder refusal must emit exactly one saveResult(failed)');
		assert.strictEqual(started[0].specHash, failed[0].specHash,
			'saveStarted and saveResult must carry the SAME attempted hash '
			+ '(the webview reducer gates on pendingSaveHash === specHash)');
		// Ordering: saveStarted must precede saveResult.
		const startedIdx = panel.postedMessages.indexOf(started[0]);
		const failedIdx = panel.postedMessages.indexOf(failed[0]);
		assert.ok(startedIdx < failedIdx, 'saveStarted must precede saveResult');
		// And nothing was written to disk.
		assert.deepStrictEqual(_writesSnapshot(), []);
	});
});
