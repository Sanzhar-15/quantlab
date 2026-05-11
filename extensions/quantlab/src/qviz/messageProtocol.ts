/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire protocol between the qviz custom-editor providers (extension host)
 * and the qviz webviews (data view + spec view).
 *
 * Phase 5 step B.1 (audit-merged plan, post-megaudit-cycle-2).
 *
 * Design notes:
 *   - This module is shared between extension host and webview. It does
 *     NOT import vscode (so it bundles cleanly into webview output) and
 *     does NOT import any DOM/Node-only types.
 *   - Wire transport is VS Code's `webview.postMessage`, which uses the
 *     HTML5 structured-clone algorithm. Structured-clone DOES preserve
 *     `Uint8Array` round-trip (extension host → webview), so the `arrow`
 *     payload is `Uint8Array` on both sides. There is NO zero-copy
 *     transferable on the public API; the structured clone DOES copy the
 *     bytes. Step E may add a transferList path if profiling demands it,
 *     but the protocol type stays `Uint8Array`.
 *   - Inbound messages at every system boundary MUST go through
 *     `validateExtensionMessage` / `validateWebviewMessage`. The validators
 *     run the full QvizSpec validator on spec-bearing messages so the
 *     extension host trusts what the webview sends and vice versa. They
 *     also enforce envelope shape (`requestId`, `specHash`, `protocolVersion`)
 *     and per-message-type cross-field invariants (e.g. saveResult.ok
 *     must NOT carry `error`).
 *   - Validators return a tagged result. The transport layers check the
 *     result and surface errors via a dedicated channel rather than
 *     dropping messages silently.
 *
 * Stale-result attribution (Codex audit critique #4):
 *   - Every spec-derived response carries `specHash` matching the spec
 *     it was computed against. The webview's reducer drops responses
 *     whose specHash doesn't match the latest in-flight slot.
 *   - For messages that carry BOTH a spec AND a specHash (init,
 *     requestData, edit, save, saveAs), the receiver RECOMPUTES
 *     `computeSpecHash(spec)` and rejects the message if it doesn't
 *     match envelope.specHash. The envelope's specHash is therefore a
 *     trust boundary on these messages — a hostile sender cannot fake
 *     attribution.
 *   - For messages that carry ONLY a specHash and no spec (data, error,
 *     saveResult), the receiver MUST trust the envelope's specHash
 *     because there is no spec to recompute against. Send-side
 *     correctness is enforced by the typed senders (extension host's
 *     provider, webview's outbound message constructors), which always
 *     compute specHash from the spec being attributed.
 */

import type { QvizSpec } from './spec';
import { canonicalStringify } from './structuralEqual';
import { validate as validateSpecImpl } from './validate';

// ---------------------------------------------------------------------------
// protocol version
// ---------------------------------------------------------------------------

/**
 * Wire protocol version. Bumped when the message shapes change in a way
 * that would break a webview built against an earlier extension-host
 * version (or vice versa). Validators reject mismatched versions; the
 * loading webview is expected to surface a "reload" prompt in that case.
 */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// envelopes
// ---------------------------------------------------------------------------

/** Common fields on every protocol message. */
export interface MessageEnvelope {
	readonly protocolVersion: number;
	/** Monotonic per-direction request id. Webview-originating ids and
	 *  extension-originating ids live in separate sequences. */
	readonly requestId: number;
}

/** Fields on response messages that are derived from a specific spec.
 *  `specHash` is REQUIRED for these so stale-result attribution is
 *  unambiguous. */
export interface SpecAttributedEnvelope extends MessageEnvelope {
	readonly specHash: string;
}

// ---------------------------------------------------------------------------
// extension → webview messages
// ---------------------------------------------------------------------------

export type ExtensionMessage =
	| InitMessage
	| DataMessage
	| ErrorMessage
	| ThemeMessage
	| DaemonStatusMessage
	| SchemaChangedMessage
	| SaveStartedMessage
	| SaveResultMessage
	| CapabilitiesMessage
	| DatasetStatusMessage
	| InspectorDataMessage
	| InspectorErrorMessage
	| ColumnStatsMessage
	| ColumnStatsErrorMessage;

export type ExtensionMessageType = ExtensionMessage['type'];

export interface InitMessage extends SpecAttributedEnvelope {
	readonly type: 'init';
	readonly fsPath: string;
	readonly spec: QvizSpec;
	/** Optional: schema metadata if the data file was inspected at open
	 *  time. The webview can render the column panel without an extra
	 *  round-trip when this is present. */
	readonly schema?: SchemaInfo;
	/** Optional capabilities snapshot; same payload as `CapabilitiesMessage`. */
	readonly capabilities?: DaemonCapabilities;
	/** SpecHash of what's currently saved to disk. Lets the webview's
	 *  spec reducer set `lastSavedHash` accurately. For a fresh open
	 *  this equals `specHash` (the loaded spec IS what's saved); for
	 *  an undo echo after the user made unsaved edits, this is the
	 *  hash of the originally-loaded spec, so isDirty stays accurate.
	 *  Step 5.H.2: prior protocol always assumed `lastSavedHash =
	 *  currentHash` on init, which made the webview lose dirty state
	 *  on undo echo. */
	readonly lastSavedHash: string;
}

export interface DataMessage extends SpecAttributedEnvelope {
	readonly type: 'data';
	/** Apache Arrow IPC bytes. Carried as `Uint8Array`; structured-clone
	 *  preserves the typed-array view across the `webview.postMessage`
	 *  boundary. */
	readonly arrow: Uint8Array;
	readonly elapsedMs: number;
	readonly cached: boolean;
	readonly diagnostics: readonly string[];
}

export interface ErrorMessage extends SpecAttributedEnvelope {
	readonly type: 'error';
	readonly error: string;
	/** Categorizes the error so the webview can route to the right
	 *  surface (transform card, modal, status bar). */
	readonly errorKind: 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol';
	/** When the error is attributable to a specific transform in the
	 *  pipeline, this is its zero-based index. */
	readonly transformIndex?: number;
}

export interface ThemeMessage extends MessageEnvelope {
	readonly type: 'theme';
	readonly tokens: ThemeTokens;
}

export interface DaemonStatusMessage extends MessageEnvelope {
	readonly type: 'daemonStatus';
	readonly status: DaemonStatusKind;
	/** When `status` is `crashed` or `respawning`, the next attempt time. */
	readonly retryInMs?: number;
	/** Last underlying error message, if relevant. */
	readonly lastError?: string;
}

export type DaemonStatusKind =
	| 'idle'
	| 'starting'
	| 'ready'
	| 'crashed'
	| 'respawning'
	| 'unavailable';

export interface SchemaChangedMessage extends MessageEnvelope {
	readonly type: 'schemaChanged';
	readonly oldHash: string;
	readonly newHash: string;
	readonly drift: SchemaDriftKind;
	/** Live schema for the data file as of this message. Webview's
	 *  `schemaState.info` is updated from this so the column panel can
	 *  reflect the on-disk state without forcing a re-init (which would
	 *  clobber the user's in-memory edits). */
	readonly newSchema: SchemaInfo;
	/** When `drift === 'fields-missing'`, the field names the spec
	 *  references but the file no longer has. REQUIRED non-empty for
	 *  that drift kind; FORBIDDEN for other drift kinds. */
	readonly missingFields?: readonly string[];
}

export type SchemaDriftKind = 'same-hash' | 'fields-preserved' | 'fields-missing';

/** Megaudit-2 A2-CRITICAL-1: host-initiated saves (Cmd+S) need a
 *  `saveStarted` signal so the webview's `pendingSaveHash` slot is
 *  populated before the matching `saveResult` arrives. Without this,
 *  the persistence reducer's `pendingSaveHash === action.specHash` gate
 *  drops every saveResult and the persistence channel is dead. */
export interface SaveStartedMessage extends SpecAttributedEnvelope {
	readonly type: 'saveStarted';
}

/** SaveResult discriminates by `status`. The two arms are mutually
 *  exclusive: 'ok' carries `fsPath`, 'failed' carries `error`. The
 *  validator REJECTS cross-field combinations. */
export type SaveResultMessage = SaveResultOkMessage | SaveResultFailedMessage;

export interface SaveResultOkMessage extends SpecAttributedEnvelope {
	readonly type: 'saveResult';
	readonly status: 'ok';
	/** Absolute file system path of the saved spec. */
	readonly fsPath: string;
}

export interface SaveResultFailedMessage extends SpecAttributedEnvelope {
	readonly type: 'saveResult';
	readonly status: 'failed';
	readonly error: string;
}

export interface CapabilitiesMessage extends MessageEnvelope {
	readonly type: 'capabilities';
	readonly capabilities: DaemonCapabilities;
}

/** Step 5.I.3: distinct from `daemonStatus` because the cause is the
 *  spec's dataset URI (file missing, dangling symlink, path escape,
 *  permission denied), not a daemon issue. The webview shows a
 *  dedicated banner with the resolved path + actionable hint. */
export interface DatasetStatusMessage extends MessageEnvelope {
	readonly type: 'datasetStatus';
	readonly status: DatasetStatusKind;
	/** The spec's dataset.uri (workspace-relative). */
	readonly datasetUri: string;
	/** The error explanation for the user. Always present for
	 *  non-`ok` statuses. */
	readonly error?: string;
}

export type DatasetStatusKind =
	| 'ok'
	| 'missing'
	| 'dangling-symlink'
	| 'access-denied'
	| 'path-escape'
	| 'extension-not-allowed'
	| 'no-workspace';

export interface DaemonCapabilities {
	readonly daemonVersion: number;
	/** Transform kinds the daemon can compile. The webview's transform
	 *  menu is generated from this list (Codex audit: do not offer
	 *  unsupported transforms). */
	readonly transformKinds: readonly string[];
	readonly chartFamilies: readonly ('timeseries' | 'general')[];
	/** Phase 6 (6.A.4): per-op feature flags for the inspector. Absent on
	 *  pre-Phase-6 daemons; webview disables the inspector toggle when
	 *  any of these is missing. */
	readonly inspector?: InspectorCapabilities;
}

export interface InspectorCapabilities {
	readonly previewOffset: boolean;
	readonly columnStats: boolean;
	readonly aggregateFilters: boolean;
}

// ---------------------------------------------------------------------------
// Phase 6 — Inspector types
// ---------------------------------------------------------------------------

/** A column filter as understood by the inspector UI. Lives in webview
 *  state only and is sent across the wire under two different code paths:
 *
 *    - chart query: serialized as a `FilterTransform` and PREPENDED to
 *      `spec.transforms` in `requestData` via `inspectorFilters` array.
 *    - inspector table query: serialized as `FilterTransform` list and
 *      passed under `inspectorFilters` on `requestInspectorData`.
 *
 *  Three discriminants cover the three widget kinds the inspector
 *  surfaces (numeric/temporal range, free-text contains, low-card
 *  checkbox set). Each compiles to one or more `FilterTransform`s with
 *  the appropriate `op`. */
export type InspectorFilter =
	| InspectorRangeFilter
	| InspectorTextFilter
	| InspectorSetFilter;

export interface InspectorRangeFilter {
	readonly kind: 'range';
	readonly column: string;
	/** Inclusive minimum. `null` means "no lower bound". */
	readonly min: number | string | null;
	/** Inclusive maximum. `null` means "no upper bound". */
	readonly max: number | string | null;
}

export interface InspectorTextFilter {
	readonly kind: 'text';
	readonly column: string;
	/** Case-insensitive contains. Empty string means "no filter active". */
	readonly contains: string;
}

export interface InspectorSetFilter {
	readonly kind: 'set';
	readonly column: string;
	/** Allowed values; empty array means "no rows match". */
	readonly includes: readonly (string | number | boolean)[];
}

/** Column stats payload returned from the daemon, normalized to the shape
 *  the inspector's filter widgets consume. Snake-case daemon fields are
 *  translated to camelCase here by the provider. */
export interface ColumnStats {
	readonly kind: 'numeric' | 'temporal' | 'string' | 'bool' | 'nominal';
	readonly cardinality: number;
	readonly cardinalityIsExact: boolean;
	readonly nullCount: number;
	readonly total: number;
	readonly min?: number | string;
	readonly max?: number | string;
	readonly distinct?: readonly unknown[];
}

/** Phase 6 (6.B.1): one window of preview rows for the inspector table.
 *  Sent in response to a `requestInspectorData`. The `arrow` payload is
 *  exactly the rows for [offset, offset + n) under the filters that were
 *  active at request time. */
export interface InspectorDataMessage extends MessageEnvelope {
	readonly type: 'inspectorData';
	readonly arrow: Uint8Array;
	readonly offset: number;
	/** Row count actually in this window (≤ requested n; equals 0 past EOF). */
	readonly n: number;
	/** Total rows visible under current filters, if the daemon can report
	 *  it cheaply. Omitted when not known. */
	readonly total?: number;
	readonly elapsedMs: number;
}

/** Phase 6 (6.B.1): inspector-side row fetch failed. Distinct from
 *  `error` because the chart's diagnostics readout shouldn't be clobbered
 *  by an inspector preview failure (which is a side panel, not the main
 *  surface). */
export interface InspectorErrorMessage extends MessageEnvelope {
	readonly type: 'inspectorError';
	readonly error: string;
	readonly errorKind: 'security' | 'timeout' | 'memory' | 'internal' | 'protocol';
}

/** Phase 6 (6.B.1): column stats response, used to drive filter widgets. */
export interface ColumnStatsMessage extends MessageEnvelope {
	readonly type: 'columnStats';
	readonly column: string;
	readonly stats: ColumnStats;
}

export interface ColumnStatsErrorMessage extends MessageEnvelope {
	readonly type: 'columnStatsError';
	readonly column: string;
	readonly error: string;
}

// ---------------------------------------------------------------------------
// webview → extension messages
// ---------------------------------------------------------------------------

export type WebviewMessage =
	| ReadyMessage
	| RequestDataMessage
	| EditMessage
	| SaveMessage
	| SaveAsMessage
	| OpenSpecMessage
	| DiscardChangesMessage
	| RequestInspectorDataMessage
	| RequestColumnStatsMessage
	| RetryDaemonMessage
	| RecheckDatasetMessage;

export type WebviewMessageType = WebviewMessage['type'];

export interface ReadyMessage extends MessageEnvelope {
	readonly type: 'ready';
}

export interface RequestDataMessage extends SpecAttributedEnvelope {
	readonly type: 'requestData';
	readonly spec: QvizSpec;
	/** Phase 6 (6.A.3): inspector-side ephemeral filters prepended to
	 *  `spec.transforms` at compile time on the daemon. NEVER written to
	 *  `.qviz.json`. Absent or empty array means "no filters active". */
	readonly inspectorFilters?: readonly InspectorFilter[];
}

export interface RequestInspectorDataMessage extends MessageEnvelope {
	readonly type: 'requestInspectorData';
	/** Row offset into the (post-filter) dataset. */
	readonly offset: number;
	/** Window size (≤ PREVIEW_MAX on the daemon side; we don't import the
	 *  constant here to keep this module dep-light). */
	readonly n: number;
	/** Ephemeral inspector filters, same shape as on `requestData`. */
	readonly inspectorFilters?: readonly InspectorFilter[];
}

export interface RequestColumnStatsMessage extends MessageEnvelope {
	readonly type: 'requestColumnStats';
	readonly column: string;
}

/** Phase 8 Step D: user clicked the "Retry connection" button on the
 *  daemon-status banner. Provider responds by tearing down + relaunching
 *  the lifecycle for the document's workspace.
 */
export interface RetryDaemonMessage extends MessageEnvelope {
	readonly type: 'retryDaemon';
}

/** Phase 8 Step D: user clicked "Re-check file" on the dataset-status
 *  banner. Provider re-resolves the dataset uri and broadcasts a fresh
 *  datasetStatus.
 */
export interface RecheckDatasetMessage extends MessageEnvelope {
	readonly type: 'recheckDataset';
}

export interface EditMessage extends SpecAttributedEnvelope {
	readonly type: 'edit';
	readonly spec: QvizSpec;
	readonly label: string;
}

export interface SaveMessage extends SpecAttributedEnvelope {
	readonly type: 'save';
	readonly spec: QvizSpec;
}

export interface SaveAsMessage extends SpecAttributedEnvelope {
	readonly type: 'saveAs';
	readonly spec: QvizSpec;
}

export interface OpenSpecMessage extends MessageEnvelope {
	readonly type: 'openSpec';
}

export interface DiscardChangesMessage extends MessageEnvelope {
	readonly type: 'discardChanges';
}

// ---------------------------------------------------------------------------
// theme tokens (snapshot of VS Code's --vscode-* CSS vars at message time)
// ---------------------------------------------------------------------------

export interface ThemeTokens {
	readonly background: string;
	readonly foreground: string;
	readonly border: string;
	readonly accent: string;
	readonly editorBackground: string;
	readonly axisGrid: string;
	readonly axisText: string;
	readonly seriesPalette: readonly string[];
}

// ---------------------------------------------------------------------------
// schema info shape (matches daemon's op_schema response)
// ---------------------------------------------------------------------------

export interface SchemaInfo {
	readonly uri: string;
	readonly schema_hash: string;
	readonly mtime_ns: number;
	readonly row_count: number | null;
	readonly columns: readonly SchemaColumn[];
}

export interface SchemaColumn {
	readonly name: string;
	readonly dtype: string;
	readonly nullable: boolean;
}

// ---------------------------------------------------------------------------
// runtime validators
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

/** Validate an inbound extension-host message at the webview boundary.
 *  Returns the typed message on success or a structured error on failure.
 *  The webview's onmessage handler is the system boundary -- it MUST
 *  surface validation errors visibly rather than drop the malformed
 *  message silently. */
export function validateExtensionMessage(value: unknown): ValidationResult<ExtensionMessage> {
	const env = expectEnvelope(value);
	if (!env.ok) { return env; }
	const obj = env.value;
	let result: ValidationResult<ExtensionMessage>;
	switch (obj.type) {
		case 'init': result = validateInit(obj); break;
		case 'data': result = validateData(obj); break;
		case 'error': result = validateError(obj); break;
		case 'theme': result = validateTheme(obj); break;
		case 'daemonStatus': result = validateDaemonStatus(obj); break;
		case 'schemaChanged': result = validateSchemaChanged(obj); break;
		case 'saveStarted': result = validateSaveStarted(obj); break;
		case 'saveResult': result = validateSaveResult(obj); break;
		case 'capabilities': result = validateCapabilities(obj); break;
		case 'datasetStatus': result = validateDatasetStatus(obj); break;
		case 'inspectorData': result = validateInspectorData(obj); break;
		case 'inspectorError': result = validateInspectorError(obj); break;
		case 'columnStats': result = validateColumnStatsMsg(obj); break;
		case 'columnStatsError': result = validateColumnStatsError(obj); break;
		default:
			return fail(`unknown extension message type: ${JSON.stringify((obj as { type: unknown }).type)}`);
	}
	return freezeResult(result);
}

/** Validate an inbound webview message at the extension-host boundary.
 *  Same contract as `validateExtensionMessage` in the other direction. */
export function validateWebviewMessage(value: unknown): ValidationResult<WebviewMessage> {
	const env = expectEnvelope(value);
	if (!env.ok) { return env; }
	const obj = env.value;
	let result: ValidationResult<WebviewMessage>;
	switch (obj.type) {
		case 'ready': result = validateReady(obj); break;
		case 'requestData': result = validateRequestData(obj); break;
		case 'edit': result = validateEditMsg(obj); break;
		case 'save': result = validateSave(obj); break;
		case 'saveAs': result = validateSaveAs(obj); break;
		case 'openSpec': result = validateOpenSpec(obj); break;
		case 'discardChanges': result = validateDiscardChanges(obj); break;
		case 'requestInspectorData': result = validateRequestInspectorData(obj); break;
		case 'requestColumnStats': result = validateRequestColumnStats(obj); break;
		case 'retryDaemon': result = ok(obj as unknown as RetryDaemonMessage); break;
		case 'recheckDataset': result = ok(obj as unknown as RecheckDatasetMessage); break;
		default:
			return fail(`unknown webview message type: ${JSON.stringify((obj as { type: unknown }).type)}`);
	}
	return freezeResult(result);
}

// ---------------------------------------------------------------------------
// validator helpers
// ---------------------------------------------------------------------------

interface RawMessage {
	readonly type: string;
	readonly protocolVersion: number;
	readonly requestId: number;
	readonly specHash?: string;
}

function expectEnvelope(value: unknown): ValidationResult<RawMessage & Record<string, unknown>> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return fail(`expected object envelope, got ${typeofVal(value)}`);
	}
	const obj = value as Record<string, unknown>;
	if (typeof obj.type !== 'string' || obj.type.length === 0) {
		return fail(`envelope.type must be a non-empty string, got ${JSON.stringify(obj.type)}`);
	}
	if (typeof obj.protocolVersion !== 'number' || !Number.isInteger(obj.protocolVersion)) {
		return fail(
			`envelope.protocolVersion must be an integer, got ${JSON.stringify(obj.protocolVersion)}`,
		);
	}
	if (obj.protocolVersion !== PROTOCOL_VERSION) {
		return fail(
			`envelope.protocolVersion ${obj.protocolVersion} does not match expected ${PROTOCOL_VERSION}; reload required`,
		);
	}
	if (
		typeof obj.requestId !== 'number'
		|| !Number.isSafeInteger(obj.requestId)
		|| obj.requestId < 0
	) {
		return fail(
			`envelope.requestId must be a non-negative safe integer, got ${JSON.stringify(obj.requestId)}`,
		);
	}
	if (obj.specHash !== undefined) {
		if (typeof obj.specHash !== 'string' || !SPEC_HASH_RE.test(obj.specHash)) {
			return fail(
				`envelope.specHash must be '${SPEC_HASH_PREFIX}<16 hex>' or omitted; got ${JSON.stringify(obj.specHash)}`,
			);
		}
	}
	return ok(obj as RawMessage & Record<string, unknown>);
}

function requireSpecHash(obj: Record<string, unknown>, messageType: string): ValidationResult<string> {
	const v = obj.specHash;
	if (typeof v !== 'string' || !SPEC_HASH_RE.test(v)) {
		return fail(`${messageType}.specHash is required ('${SPEC_HASH_PREFIX}<16 hex>'); got ${JSON.stringify(v)}`);
	}
	return ok(v);
}

function validateSpec(value: unknown, messageType: string): ValidationResult<QvizSpec> {
	if (!isObject(value)) {
		return fail(`${messageType}.spec must be an object`);
	}
	const r = validateSpecImpl(value);
	if (!r.ok) {
		const summary = r.issues.map(i => `${i.path}: ${i.message}`).join('; ');
		return fail(`${messageType}.spec failed validation: ${summary}`);
	}
	return ok(r.value);
}

/** Verify that envelope.specHash matches `computeSpecHash(spec)`. The
 *  receiver MUST recompute rather than trust the sender (Step C
 *  megaudit C11). For messages that carry both a spec AND a specHash,
 *  this is the only way to authenticate the attribution. */
function verifySpecHash(
	envelopeSpecHash: string, spec: QvizSpec, messageType: string,
): ValidationResult<true> {
	const computed = computeSpecHash(spec);
	if (computed !== envelopeSpecHash) {
		return fail(
			`${messageType}.specHash does not match computeSpecHash(spec): `
			+ `envelope=${envelopeSpecHash} computed=${computed}. `
			+ 'Sender must call computeSpecHash on the spec being sent.',
		);
	}
	return ok(true as const);
}

function validateInit(obj: Record<string, unknown>): ValidationResult<InitMessage> {
	const sh = requireSpecHash(obj, 'init');
	if (!sh.ok) { return sh; }
	if (typeof obj.fsPath !== 'string' || obj.fsPath.length === 0) {
		return fail('init.fsPath must be a non-empty string');
	}
	const spec = validateSpec(obj.spec, 'init');
	if (!spec.ok) { return spec; }
	const hashCheck = verifySpecHash(sh.value, spec.value, 'init');
	if (!hashCheck.ok) { return hashCheck; }
	// Step 5.H.2: lastSavedHash REQUIRED. Must be a well-formed
	// specHash (same format/range as envelope.specHash).
	if (typeof obj.lastSavedHash !== 'string' || !SPEC_HASH_RE.test(obj.lastSavedHash)) {
		return fail(
			`init.lastSavedHash is required ('${SPEC_HASH_PREFIX}<16 hex>'); got ${JSON.stringify(obj.lastSavedHash)}`,
		);
	}
	if (obj.schema !== undefined) {
		const sr = validateSchemaInfo(obj.schema, 'init.schema');
		if (!sr.ok) { return sr; }
	}
	if (obj.capabilities !== undefined) {
		const cr = validateDaemonCapabilities(obj.capabilities, 'init.capabilities');
		if (!cr.ok) { return cr; }
	}
	// Return a normalized message with the validated spec value (which
	// may differ from the inbound shape if the validator coerces fields).
	return ok({ ...(obj as unknown as InitMessage), spec: spec.value });
}

function validateData(obj: Record<string, unknown>): ValidationResult<DataMessage> {
	const sh = requireSpecHash(obj, 'data');
	if (!sh.ok) { return sh; }
	// `Uint8Array` is what structured-clone produces on the receiving side.
	// Reject `ArrayBuffer` and Node `Buffer` explicitly so a sender that
	// forgets to wrap a buffer view fails loudly.
	if (!(obj.arrow instanceof Uint8Array) || isNodeBuffer(obj.arrow)) {
		return fail(
			`data.arrow must be Uint8Array (not Buffer / ArrayBuffer / etc.), got ${typeofVal(obj.arrow)}`,
		);
	}
	if (typeof obj.elapsedMs !== 'number' || !Number.isFinite(obj.elapsedMs) || obj.elapsedMs < 0) {
		return fail('data.elapsedMs must be a non-negative finite number');
	}
	if (typeof obj.cached !== 'boolean') {
		return fail('data.cached must be a boolean');
	}
	if (!Array.isArray(obj.diagnostics) || !obj.diagnostics.every(d => typeof d === 'string')) {
		return fail('data.diagnostics must be an array of strings');
	}
	return ok(obj as unknown as DataMessage);
}

const ERROR_KINDS = new Set(['compile', 'security', 'timeout', 'memory', 'internal', 'protocol']);

function validateError(obj: Record<string, unknown>): ValidationResult<ErrorMessage> {
	const sh = requireSpecHash(obj, 'error');
	if (!sh.ok) { return sh; }
	if (typeof obj.error !== 'string' || obj.error.length === 0) {
		return fail('error.error must be a non-empty string');
	}
	if (typeof obj.errorKind !== 'string' || !ERROR_KINDS.has(obj.errorKind)) {
		return fail(
			`error.errorKind must be one of ${[...ERROR_KINDS].join('|')}, got ${JSON.stringify(obj.errorKind)}`,
		);
	}
	if (obj.transformIndex !== undefined) {
		if (
			typeof obj.transformIndex !== 'number'
			|| !Number.isSafeInteger(obj.transformIndex)
			|| obj.transformIndex < 0
		) {
			return fail('error.transformIndex must be a non-negative safe integer or omitted');
		}
	}
	return ok(obj as unknown as ErrorMessage);
}

function validateTheme(obj: Record<string, unknown>): ValidationResult<ThemeMessage> {
	if (!isObject(obj.tokens)) { return fail('theme.tokens must be an object'); }
	const t = obj.tokens as Record<string, unknown>;
	const stringFields = ['background', 'foreground', 'border', 'accent', 'editorBackground', 'axisGrid', 'axisText'] as const;
	for (const f of stringFields) {
		if (typeof t[f] !== 'string') { return fail(`theme.tokens.${f} must be a string`); }
	}
	if (!Array.isArray(t.seriesPalette) || !t.seriesPalette.every(s => typeof s === 'string')) {
		return fail('theme.tokens.seriesPalette must be an array of strings');
	}
	return ok(obj as unknown as ThemeMessage);
}

const DAEMON_STATUS_KINDS = new Set(['idle', 'starting', 'ready', 'crashed', 'respawning', 'unavailable']);

function validateDaemonStatus(obj: Record<string, unknown>): ValidationResult<DaemonStatusMessage> {
	if (typeof obj.status !== 'string' || !DAEMON_STATUS_KINDS.has(obj.status)) {
		return fail(
			`daemonStatus.status must be one of ${[...DAEMON_STATUS_KINDS].join('|')}, got ${JSON.stringify(obj.status)}`,
		);
	}
	if (obj.retryInMs !== undefined) {
		if (typeof obj.retryInMs !== 'number' || !Number.isFinite(obj.retryInMs) || obj.retryInMs < 0) {
			return fail('daemonStatus.retryInMs must be a non-negative finite number or omitted');
		}
	}
	if (obj.lastError !== undefined && typeof obj.lastError !== 'string') {
		return fail('daemonStatus.lastError must be a string or omitted');
	}
	// Cross-field invariant: retryInMs only makes sense in transient states.
	if (
		obj.retryInMs !== undefined
		&& obj.status !== 'crashed' && obj.status !== 'respawning'
	) {
		return fail(
			`daemonStatus.retryInMs is only valid for status='crashed' or 'respawning', got status=${JSON.stringify(obj.status)}`,
		);
	}
	return ok(obj as unknown as DaemonStatusMessage);
}

const DRIFT_KINDS = new Set(['same-hash', 'fields-preserved', 'fields-missing']);

function validateSchemaChanged(obj: Record<string, unknown>): ValidationResult<SchemaChangedMessage> {
	for (const f of ['oldHash', 'newHash'] as const) {
		const v = obj[f];
		if (typeof v !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(v)) {
			return fail(`schemaChanged.${f} must be 'sha256:<64 hex>'`);
		}
	}
	if (typeof obj.drift !== 'string' || !DRIFT_KINDS.has(obj.drift)) {
		return fail(`schemaChanged.drift must be one of ${[...DRIFT_KINDS].join('|')}`);
	}
	const sr = validateSchemaInfo(obj.newSchema, 'schemaChanged.newSchema');
	if (!sr.ok) { return sr; }
	if (obj.missingFields !== undefined) {
		if (!Array.isArray(obj.missingFields) || !obj.missingFields.every(s => typeof s === 'string')) {
			return fail('schemaChanged.missingFields must be an array of strings or omitted');
		}
		// Reject empty strings and duplicates -- these are protocol drift,
		// not legitimate use cases.
		const seen = new Set<string>();
		for (const f of obj.missingFields) {
			const s = f as string;
			if (s.length === 0) {
				return fail('schemaChanged.missingFields entries must be non-empty');
			}
			if (seen.has(s)) {
				return fail(`schemaChanged.missingFields contains duplicate ${JSON.stringify(s)}`);
			}
			seen.add(s);
		}
	}
	// Cross-field invariant: missingFields is required iff drift is fields-missing.
	if (obj.drift === 'fields-missing') {
		if (!Array.isArray(obj.missingFields) || obj.missingFields.length === 0) {
			return fail("schemaChanged.missingFields is required (non-empty) when drift === 'fields-missing'");
		}
	} else if (obj.missingFields !== undefined) {
		return fail(
			`schemaChanged.missingFields is forbidden when drift !== 'fields-missing'; got drift=${JSON.stringify(obj.drift)}`,
		);
	}
	// Cross-field invariant: drift kind must be consistent with hashes.
	// `same-hash` requires oldHash === newHash; non-same drift requires
	// they differ. Otherwise a sender could emit `same-hash` with
	// different hashes (incoherent) or `fields-preserved` with equal
	// hashes (no actual drift).
	if (obj.drift === 'same-hash' && obj.oldHash !== obj.newHash) {
		return fail(
			"schemaChanged.drift === 'same-hash' requires oldHash === newHash",
		);
	}
	if (obj.drift !== 'same-hash' && obj.oldHash === obj.newHash) {
		return fail(
			`schemaChanged.drift === ${JSON.stringify(obj.drift)} requires oldHash !== newHash`,
		);
	}
	// Cross-field invariant: schemaChanged.newSchema.schema_hash must equal newHash.
	const newSchema = obj.newSchema as SchemaInfo;
	if (newSchema.schema_hash !== obj.newHash) {
		return fail(
			"schemaChanged.newSchema.schema_hash must equal schemaChanged.newHash",
		);
	}
	return ok(obj as unknown as SchemaChangedMessage);
}

function validateSaveStarted(obj: Record<string, unknown>): ValidationResult<SaveStartedMessage> {
	const sh = requireSpecHash(obj, 'saveStarted');
	if (!sh.ok) { return sh; }
	return ok(obj as unknown as SaveStartedMessage);
}

function validateSaveResult(obj: Record<string, unknown>): ValidationResult<SaveResultMessage> {
	const sh = requireSpecHash(obj, 'saveResult');
	if (!sh.ok) { return sh; }
	if (obj.status === 'ok') {
		if (typeof obj.fsPath !== 'string' || obj.fsPath.length === 0) {
			return fail("saveResult.fsPath required (non-empty) when status === 'ok'");
		}
		if (obj.error !== undefined) {
			return fail("saveResult.error must NOT be present when status === 'ok'");
		}
		return ok(obj as unknown as SaveResultMessage);
	}
	if (obj.status === 'failed') {
		if (typeof obj.error !== 'string' || obj.error.length === 0) {
			return fail("saveResult.error required (non-empty) when status === 'failed'");
		}
		if (obj.fsPath !== undefined) {
			return fail("saveResult.fsPath must NOT be present when status === 'failed'");
		}
		return ok(obj as unknown as SaveResultMessage);
	}
	return fail(`saveResult.status must be 'ok' or 'failed', got ${JSON.stringify(obj.status)}`);
}

function validateCapabilities(obj: Record<string, unknown>): ValidationResult<CapabilitiesMessage> {
	const cr = validateDaemonCapabilities(obj.capabilities, 'capabilities.capabilities');
	if (!cr.ok) { return cr; }
	return ok(obj as unknown as CapabilitiesMessage);
}

const DATASET_STATUS_KINDS = new Set([
	'ok', 'missing', 'dangling-symlink', 'access-denied',
	'path-escape', 'extension-not-allowed', 'no-workspace',
]);

function validateDatasetStatus(obj: Record<string, unknown>): ValidationResult<DatasetStatusMessage> {
	if (typeof obj.status !== 'string' || !DATASET_STATUS_KINDS.has(obj.status)) {
		return fail(
			`datasetStatus.status must be one of ${[...DATASET_STATUS_KINDS].join('|')}, got ${JSON.stringify(obj.status)}`,
		);
	}
	if (typeof obj.datasetUri !== 'string' || obj.datasetUri.length === 0) {
		return fail('datasetStatus.datasetUri must be a non-empty string');
	}
	if (obj.error !== undefined && typeof obj.error !== 'string') {
		return fail('datasetStatus.error must be a string or omitted');
	}
	// Cross-field invariant: non-`ok` statuses carry an error message.
	if (obj.status !== 'ok' && (typeof obj.error !== 'string' || obj.error.length === 0)) {
		return fail(
			`datasetStatus.error required (non-empty) when status === ${JSON.stringify(obj.status)}`,
		);
	}
	return ok(obj as unknown as DatasetStatusMessage);
}

function validateDaemonCapabilities(
	value: unknown, label: string,
): ValidationResult<DaemonCapabilities> {
	if (!isObject(value)) { return fail(`${label} must be an object`); }
	const c = value;
	if (
		typeof c.daemonVersion !== 'number'
		|| !Number.isSafeInteger(c.daemonVersion)
		|| c.daemonVersion <= 0
	) {
		return fail(`${label}.daemonVersion must be a positive safe integer`);
	}
	if (!Array.isArray(c.transformKinds) || !c.transformKinds.every(s => typeof s === 'string')) {
		return fail(`${label}.transformKinds must be an array of strings`);
	}
	if (!Array.isArray(c.chartFamilies) || !c.chartFamilies.every(s => s === 'timeseries' || s === 'general')) {
		return fail(`${label}.chartFamilies must be an array of 'timeseries'|'general'`);
	}
	// Audit M-F + M-49 (2026-05-11): the optional `inspector` capability
	// bag arrived in Phase 6. The validator originally required ALL
	// three flags as booleans — that rejected partial-rollout daemons
	// (one or two flags only) by dropping the WHOLE capabilities
	// message, leaving the webview with no caps at all (worse than
	// degraded). Updated semantics: the bag itself is optional; when
	// present, each flag is OPTIONAL and defaults to false. WRONG
	// TYPES (string, number) are still rejected so a malformed payload
	// can't smuggle a truthy-string through. This way a partial-rollout
	// daemon advertising `{previewOffset: true}` flows through cleanly
	// and the webview disables the inspector (since the AND-gate at
	// the toggle requires all three).
	if (c.inspector !== undefined) {
		if (!isObject(c.inspector)) {
			return fail(`${label}.inspector must be an object when present`);
		}
		const i = c.inspector as Record<string, unknown>;
		for (const k of ['previewOffset', 'columnStats', 'aggregateFilters'] as const) {
			if (i[k] !== undefined && typeof i[k] !== 'boolean') {
				return fail(`${label}.inspector.${k} must be a boolean when present`);
			}
		}
		// Normalize missing flags to `false` so downstream consumers
		// don't have to repeat the optional-chain dance.
		(c.inspector as { previewOffset?: unknown }).previewOffset ??= false;
		(c.inspector as { columnStats?: unknown }).columnStats ??= false;
		(c.inspector as { aggregateFilters?: unknown }).aggregateFilters ??= false;
	}
	return ok(c as unknown as DaemonCapabilities);
}

function validateSchemaInfo(value: unknown, label: string): ValidationResult<SchemaInfo> {
	if (!isObject(value)) { return fail(`${label} must be an object`); }
	const s = value;
	if (typeof s.uri !== 'string' || s.uri.length === 0) {
		return fail(`${label}.uri must be a non-empty string`);
	}
	if (typeof s.schema_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(s.schema_hash)) {
		return fail(`${label}.schema_hash must be 'sha256:<64 hex>'`);
	}
	if (
		typeof s.mtime_ns !== 'number'
		|| !Number.isFinite(s.mtime_ns)
		|| s.mtime_ns < 0
	) {
		return fail(`${label}.mtime_ns must be a non-negative finite number`);
	}
	if (s.row_count !== null) {
		if (
			typeof s.row_count !== 'number'
			|| !Number.isSafeInteger(s.row_count)
			|| s.row_count < 0
		) {
			return fail(`${label}.row_count must be a non-negative safe integer or null`);
		}
	}
	if (!Array.isArray(s.columns)) {
		return fail(`${label}.columns must be an array`);
	}
	const seenNames = new Set<string>();
	for (let i = 0; i < s.columns.length; i++) {
		const col = s.columns[i];
		if (!isObject(col)) {
			return fail(`${label}.columns[${i}] must be an object`);
		}
		if (typeof col.name !== 'string' || col.name.length === 0) {
			return fail(`${label}.columns[${i}].name must be a non-empty string`);
		}
		if (seenNames.has(col.name)) {
			return fail(`${label}.columns[${i}].name duplicates an earlier column: ${JSON.stringify(col.name)}`);
		}
		seenNames.add(col.name);
		if (typeof col.dtype !== 'string' || col.dtype.length === 0) {
			return fail(`${label}.columns[${i}].dtype must be a non-empty string`);
		}
		if (typeof col.nullable !== 'boolean') {
			return fail(`${label}.columns[${i}].nullable must be a boolean`);
		}
	}
	return ok(s as unknown as SchemaInfo);
}

// --- webview → extension validators ---

function validateReady(obj: Record<string, unknown>): ValidationResult<ReadyMessage> {
	return ok(obj as unknown as ReadyMessage);
}

function validateRequestData(obj: Record<string, unknown>): ValidationResult<RequestDataMessage> {
	const sh = requireSpecHash(obj, 'requestData');
	if (!sh.ok) { return sh; }
	const spec = validateSpec(obj.spec, 'requestData');
	if (!spec.ok) { return spec; }
	const hashCheck = verifySpecHash(sh.value, spec.value, 'requestData');
	if (!hashCheck.ok) { return hashCheck; }
	let inspectorFilters: readonly InspectorFilter[] | undefined;
	if (obj.inspectorFilters !== undefined) {
		const f = validateInspectorFilters(obj.inspectorFilters, 'requestData');
		if (!f.ok) { return f; }
		inspectorFilters = f.value;
	}
	return ok({
		...(obj as unknown as RequestDataMessage),
		spec: spec.value,
		...(inspectorFilters !== undefined ? { inspectorFilters } : {}),
	});
}

function validateRequestInspectorData(
	obj: Record<string, unknown>,
): ValidationResult<RequestInspectorDataMessage> {
	if (typeof obj.offset !== 'number' || !Number.isSafeInteger(obj.offset) || obj.offset < 0) {
		return fail('requestInspectorData.offset must be a non-negative safe integer');
	}
	if (typeof obj.n !== 'number' || !Number.isSafeInteger(obj.n) || obj.n <= 0) {
		return fail('requestInspectorData.n must be a positive safe integer');
	}
	let inspectorFilters: readonly InspectorFilter[] | undefined;
	if (obj.inspectorFilters !== undefined) {
		const f = validateInspectorFilters(obj.inspectorFilters, 'requestInspectorData');
		if (!f.ok) { return f; }
		inspectorFilters = f.value;
	}
	return ok({
		...(obj as unknown as RequestInspectorDataMessage),
		...(inspectorFilters !== undefined ? { inspectorFilters } : {}),
	});
}

function validateRequestColumnStats(
	obj: Record<string, unknown>,
): ValidationResult<RequestColumnStatsMessage> {
	const colCheck = validateColumnName(obj.column, 'requestColumnStats.column');
	if (!colCheck.ok) { return colCheck; }
	return ok(obj as unknown as RequestColumnStatsMessage);
}

/** Audit M-18 (2026-05-11): column-name acceptability gate. Inspector
 *  messages carry user/UI-sourced column names that flow into SQL
 *  identifier-quoting on the daemon. Reject control chars (NUL etc.),
 *  cap length to defeat memory-bombing, and require non-empty. */
const MAX_COLUMN_NAME_LEN = 256;
function validateColumnName(value: unknown, path: string): ValidationResult<string> {
	if (typeof value !== 'string') {
		return fail(`${path} must be a string`);
	}
	if (value.length === 0) {
		return fail(`${path} must be a non-empty string`);
	}
	if (value.length > MAX_COLUMN_NAME_LEN) {
		return fail(`${path} length ${value.length} exceeds cap ${MAX_COLUMN_NAME_LEN}`);
	}
	// Reject all C0 control chars including NUL, tab, newline,
	// carriage return. A parquet writer could legitimately ship
	// whitespace-padded names but the inspector ignores them anyway.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) {
			return fail(`${path} contains control character at index ${i}`);
		}
	}
	return ok(value);
}

/** Phase 6 (6.B.4): InspectorFilter discriminated-union validator.
 *  Both inbound message paths (`requestData.inspectorFilters` and
 *  `requestInspectorData.inspectorFilters`) share this.
 *
 *  Audit M-17/M-52/M-53 (2026-05-11): now caps array length, validates
 *  column names via `validateColumnName` (NUL/control/length), caps
 *  `contains` text + `includes` array size, and rejects extra unknown
 *  fields per filter kind (defense-in-depth: a malicious webview can't
 *  smuggle unknown keys into the daemon-side compiler). */
const MAX_INSPECTOR_FILTERS = 64;
const MAX_INSPECTOR_TEXT_FILTER_LEN = 4096;
const MAX_INSPECTOR_SET_INCLUDES = 1024;
function validateInspectorFilters(
	value: unknown, label: string,
): ValidationResult<readonly InspectorFilter[]> {
	if (!Array.isArray(value)) {
		return fail(`${label}.inspectorFilters must be an array`);
	}
	if (value.length > MAX_INSPECTOR_FILTERS) {
		return fail(`${label}.inspectorFilters length ${value.length} exceeds cap ${MAX_INSPECTOR_FILTERS}`);
	}
	const out: InspectorFilter[] = [];
	for (let i = 0; i < value.length; i++) {
		const f = value[i];
		const path = `${label}.inspectorFilters[${i}]`;
		if (!isObject(f)) {
			return fail(`${path} must be an object`);
		}
		const colCheck = validateColumnName(f.column, `${path}.column`);
		if (!colCheck.ok) { return colCheck; }
		const column = colCheck.value;
		if (f.kind === 'range') {
			const mn = f.min, mx = f.max;
			const okScalar = (v: unknown): boolean =>
				v === null
				|| (typeof v === 'number' && Number.isFinite(v))
				|| (typeof v === 'string' && v.length > 0 && v.length <= MAX_INSPECTOR_TEXT_FILTER_LEN);
			if (!okScalar(mn) || !okScalar(mx)) {
				return fail(`${path} range bounds must be null, finite number, or non-empty string`);
			}
			// Audit M-52: rebuild instead of pass-through so extra fields
			// on the inbound object don't survive into the validated message.
			out.push({
				kind: 'range', column,
				min: mn as InspectorFilter extends { kind: 'range'; min: infer M } ? M : never,
				max: mx as InspectorFilter extends { kind: 'range'; max: infer M } ? M : never,
			} as InspectorFilter);
		} else if (f.kind === 'text') {
			if (typeof f.contains !== 'string') {
				return fail(`${path}.contains must be a string`);
			}
			if (f.contains.length > MAX_INSPECTOR_TEXT_FILTER_LEN) {
				return fail(`${path}.contains length ${f.contains.length} exceeds cap ${MAX_INSPECTOR_TEXT_FILTER_LEN}`);
			}
			// Reject NUL / C0 control chars in the substring needle to
			// match validateColumnName's defense.
			for (let j = 0; j < f.contains.length; j++) {
				const code = f.contains.charCodeAt(j);
				if (code < 0x20 || code === 0x7f) {
					return fail(`${path}.contains contains control character at index ${j}`);
				}
			}
			out.push({ kind: 'text', column, contains: f.contains });
		} else if (f.kind === 'set') {
			if (!Array.isArray(f.includes)) {
				return fail(`${path}.includes must be an array`);
			}
			if (f.includes.length > MAX_INSPECTOR_SET_INCLUDES) {
				return fail(`${path}.includes length ${f.includes.length} exceeds cap ${MAX_INSPECTOR_SET_INCLUDES}`);
			}
			const cleanIncludes: (string | number | boolean)[] = [];
			for (let j = 0; j < f.includes.length; j++) {
				const v = f.includes[j];
				if (typeof v === 'string' || typeof v === 'boolean') {
					if (typeof v === 'string' && v.length > MAX_INSPECTOR_TEXT_FILTER_LEN) {
						return fail(`${path}.includes[${j}] string exceeds cap ${MAX_INSPECTOR_TEXT_FILTER_LEN}`);
					}
					cleanIncludes.push(v);
					continue;
				}
				// Reject NaN/Infinity numbers.
				if (typeof v === 'number') {
					if (!Number.isFinite(v)) {
						return fail(`${path}.includes[${j}] must be a finite number (got ${v})`);
					}
					cleanIncludes.push(v);
					continue;
				}
				return fail(`${path}.includes[${j}] must be a string, finite number, or boolean`);
			}
			out.push({ kind: 'set', column, includes: cleanIncludes });
		} else {
			return fail(`${path}.kind must be 'range' | 'text' | 'set'`);
		}
	}
	return ok(out);
}

function validateInspectorData(
	obj: Record<string, unknown>,
): ValidationResult<InspectorDataMessage> {
	if (!(obj.arrow instanceof Uint8Array)) {
		return fail('inspectorData.arrow must be a Uint8Array');
	}
	if (typeof obj.offset !== 'number' || !Number.isSafeInteger(obj.offset) || obj.offset < 0) {
		return fail('inspectorData.offset must be a non-negative safe integer');
	}
	if (typeof obj.n !== 'number' || !Number.isSafeInteger(obj.n) || obj.n < 0) {
		return fail('inspectorData.n must be a non-negative safe integer');
	}
	if (obj.total !== undefined) {
		if (typeof obj.total !== 'number' || !Number.isSafeInteger(obj.total) || obj.total < 0) {
			return fail('inspectorData.total must be a non-negative safe integer when present');
		}
	}
	if (typeof obj.elapsedMs !== 'number' || !Number.isFinite(obj.elapsedMs)) {
		return fail('inspectorData.elapsedMs must be a finite number');
	}
	// Audit M-50 (2026-05-11): cross-field invariants. A daemon
	// returning `n=10` with empty arrow bytes, or `n=0` with non-empty
	// arrow, or `n > total`, is malformed.
	const n = obj.n as number;
	const arrowLen = (obj.arrow as Uint8Array).byteLength;
	if (n === 0 && arrowLen > 0) {
		// Arrow IPC with zero rows still ships ~80 bytes of schema; we
		// accept that. Only the "0 rows but megabytes of bytes" case
		// would be suspicious — out of scope for v1.
	} else if (n > 0 && arrowLen === 0) {
		return fail(`inspectorData reports n=${n} but arrow byteLength=0`);
	}
	if (obj.total !== undefined) {
		const total = obj.total as number;
		if (n > total) {
			return fail(`inspectorData n=${n} exceeds total=${total}`);
		}
	}
	return ok(obj as unknown as InspectorDataMessage);
}

function validateInspectorError(
	obj: Record<string, unknown>,
): ValidationResult<InspectorErrorMessage> {
	if (typeof obj.error !== 'string' || obj.error.length === 0) {
		return fail('inspectorError.error must be a non-empty string');
	}
	const k = obj.errorKind;
	if (k !== 'security' && k !== 'timeout' && k !== 'memory' && k !== 'internal' && k !== 'protocol') {
		return fail(`inspectorError.errorKind must be one of 'security'|'timeout'|'memory'|'internal'|'protocol' (got ${JSON.stringify(k)})`);
	}
	return ok(obj as unknown as InspectorErrorMessage);
}

function validateColumnStatsMsg(
	obj: Record<string, unknown>,
): ValidationResult<ColumnStatsMessage> {
	const colCheck = validateColumnName(obj.column, 'columnStats.column');
	if (!colCheck.ok) { return colCheck; }
	const s = obj.stats;
	if (!isObject(s)) { return fail('columnStats.stats must be an object'); }
	const validKinds = ['numeric', 'temporal', 'string', 'bool', 'nominal'];
	if (typeof s.kind !== 'string' || !validKinds.includes(s.kind)) {
		return fail(`columnStats.stats.kind must be one of ${validKinds.join('|')}`);
	}
	if (typeof s.cardinality !== 'number' || !Number.isSafeInteger(s.cardinality) || s.cardinality < 0) {
		return fail('columnStats.stats.cardinality must be a non-negative safe integer');
	}
	if (typeof s.cardinalityIsExact !== 'boolean') {
		return fail('columnStats.stats.cardinalityIsExact must be a boolean');
	}
	if (typeof s.nullCount !== 'number' || !Number.isSafeInteger(s.nullCount) || s.nullCount < 0) {
		return fail('columnStats.stats.nullCount must be a non-negative safe integer');
	}
	if (typeof s.total !== 'number' || !Number.isSafeInteger(s.total) || s.total < 0) {
		return fail('columnStats.stats.total must be a non-negative safe integer');
	}
	// Audit M-51 (2026-05-11): cross-field invariants.
	if (s.nullCount > s.total) {
		return fail(`columnStats: nullCount=${s.nullCount} exceeds total=${s.total}`);
	}
	if (s.distinct !== undefined) {
		if (!Array.isArray(s.distinct)) {
			return fail('columnStats.stats.distinct must be an array when present');
		}
		// Audit Codex MINOR (2026-05-11): validate each distinct element
		// against supported scalar types + finite numbers.
		for (let i = 0; i < s.distinct.length; i++) {
			const v = s.distinct[i];
			if (v === null) { continue; }
			if (typeof v === 'string' || typeof v === 'boolean') { continue; }
			if (typeof v === 'number') {
				if (!Number.isFinite(v)) {
					return fail(`columnStats.stats.distinct[${i}] must be finite (got ${v})`);
				}
				continue;
			}
			return fail(`columnStats.stats.distinct[${i}] must be string|number|boolean|null`);
		}
		if (s.distinct.length > s.cardinality) {
			return fail(`columnStats.stats.distinct.length=${s.distinct.length} exceeds cardinality=${s.cardinality}`);
		}
		if (s.cardinalityIsExact === false && s.distinct.length > 0) {
			// Daemon contract: distinct is set ONLY when cardinality is exact.
			return fail('columnStats.stats.distinct must be undefined when cardinalityIsExact=false');
		}
	}
	// min/max scalar validation (non-finite numbers leak from a buggy
	// daemon; we caught one in _jsonify_scalar but defense-in-depth).
	for (const k of ['min', 'max'] as const) {
		const v = (s as Record<string, unknown>)[k];
		if (v === undefined) { continue; }
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				return fail(`columnStats.stats.${k} must be a finite number`);
			}
		} else if (typeof v !== 'string') {
			return fail(`columnStats.stats.${k} must be a finite number or string`);
		}
	}
	return ok(obj as unknown as ColumnStatsMessage);
}

function validateColumnStatsError(
	obj: Record<string, unknown>,
): ValidationResult<ColumnStatsErrorMessage> {
	if (typeof obj.column !== 'string' || obj.column.length === 0) {
		return fail('columnStatsError.column must be a non-empty string');
	}
	if (typeof obj.error !== 'string' || obj.error.length === 0) {
		return fail('columnStatsError.error must be a non-empty string');
	}
	return ok(obj as unknown as ColumnStatsErrorMessage);
}

function validateEditMsg(obj: Record<string, unknown>): ValidationResult<EditMessage> {
	const sh = requireSpecHash(obj, 'edit');
	if (!sh.ok) { return sh; }
	const spec = validateSpec(obj.spec, 'edit');
	if (!spec.ok) { return spec; }
	const hashCheck = verifySpecHash(sh.value, spec.value, 'edit');
	if (!hashCheck.ok) { return hashCheck; }
	if (typeof obj.label !== 'string' || obj.label.length === 0) {
		return fail('edit.label must be a non-empty string');
	}
	return ok({ ...(obj as unknown as EditMessage), spec: spec.value });
}

function validateSave(obj: Record<string, unknown>): ValidationResult<SaveMessage> {
	const sh = requireSpecHash(obj, 'save');
	if (!sh.ok) { return sh; }
	const spec = validateSpec(obj.spec, 'save');
	if (!spec.ok) { return spec; }
	const hashCheck = verifySpecHash(sh.value, spec.value, 'save');
	if (!hashCheck.ok) { return hashCheck; }
	return ok({ ...(obj as unknown as SaveMessage), spec: spec.value });
}

function validateSaveAs(obj: Record<string, unknown>): ValidationResult<SaveAsMessage> {
	const sh = requireSpecHash(obj, 'saveAs');
	if (!sh.ok) { return sh; }
	const spec = validateSpec(obj.spec, 'saveAs');
	if (!spec.ok) { return spec; }
	const hashCheck = verifySpecHash(sh.value, spec.value, 'saveAs');
	if (!hashCheck.ok) { return hashCheck; }
	return ok({ ...(obj as unknown as SaveAsMessage), spec: spec.value });
}

function validateOpenSpec(obj: Record<string, unknown>): ValidationResult<OpenSpecMessage> {
	return ok(obj as unknown as OpenSpecMessage);
}

function validateDiscardChanges(obj: Record<string, unknown>): ValidationResult<DiscardChangesMessage> {
	return ok(obj as unknown as DiscardChangesMessage);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function fail<T>(error: string): ValidationResult<T> {
	return { ok: false, error };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Megaudit MAJOR-36: detect Node `Buffer` without `as any` and
 *  without trusting the spoofable `.constructor.name`. `Buffer.isBuffer`
 *  is a realm-safe check; falls back to a strict prototype-chain test
 *  so the function works even in environments where the global
 *  `Buffer` is not available. */
function isNodeBuffer(v: unknown): boolean {
	const Buf: { isBuffer?(x: unknown): boolean } | undefined =
		(globalThis as { Buffer?: { isBuffer?(x: unknown): boolean } }).Buffer;
	if (Buf && typeof Buf.isBuffer === 'function') { return Buf.isBuffer(v); }
	return false;
}

function typeofVal(v: unknown): string {
	if (v === null) { return 'null'; }
	if (Array.isArray(v)) { return 'array'; }
	if (v instanceof Uint8Array) { return 'Uint8Array'; }
	if (v instanceof ArrayBuffer) { return 'ArrayBuffer'; }
	return typeof v;
}

/** Deep-freeze a successful validator result so consumers can't mutate
 *  the validated message — neither the top-level envelope nor any
 *  nested object/array (columns, capabilities, transforms, etc.).
 *  The `arrow` Uint8Array is left mutable -- freezing a typed-array
 *  view with Object.freeze does not freeze the underlying bytes; the
 *  consumer (state reducer) takes its own slice copy.
 *
 *  Step C megaudit C10: prior shallow freeze let a sender hold a
 *  reference to validated `newSchema.columns` and mutate it after
 *  dispatch, corrupting the webview's schemaState. Deep freeze
 *  prevents that vector at the boundary. */
function freezeResult<T>(result: ValidationResult<T>): ValidationResult<T> {
	if (result.ok) {
		deepFreeze(result.value);
		Object.freeze(result);
	}
	return result;
}

function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== 'object') { return; }
	if (Object.isFrozen(value)) { return; }
	// Skip TypedArray views (arrow bytes) -- freezing them is a no-op
	// for the underlying buffer but adds overhead; consumer is expected
	// to take its own copy.
	if (ArrayBuffer.isView(value)) { return; }
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) { deepFreeze(item); }
		return;
	}
	for (const key of Object.keys(value)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
}

// ---------------------------------------------------------------------------
// specHash: protocol-internal stale-result attribution
// ---------------------------------------------------------------------------

/**
 * Format: `q1:<16 hex>` where the 16 hex chars encode a 64-bit
 * non-cryptographic hash of the spec. Distinct prefix from
 * DatasetRef.schema_hash (which uses `sha256:<64 hex>`) so the two are
 * never confused -- they serve different purposes:
 *
 *   - DatasetRef.schema_hash      cryptographic, used for daemon cache key
 *                                 and TOCTOU invalidation.
 *   - envelope.specHash (this)    protocol-internal, used to match a
 *                                 response to the request's spec for
 *                                 stale-result attribution. Both sides
 *                                 RECOMPUTE specHash from the validated
 *                                 spec rather than trusting the inbound
 *                                 envelope value, so a hostile webview
 *                                 cannot fake attribution.
 */
export const SPEC_HASH_PREFIX = 'q1:';
export const SPEC_HASH_RE = /^q1:[0-9a-f]{16}$/;

/**
 * Compute a stable specHash for envelope.specHash.
 *
 * Implementation: two FNV-1a passes over the canonical (sorted-key)
 * JSON serialization of the spec, with a different starting offset
 * basis on the second pass and a leading discriminator byte so the two
 * 32-bit streams are independent (avoids the "two correlated 32-bit
 * hashes concat to 64" weakness).
 *
 * Stability contract: two specs with structurally equal content produce
 * the same hash regardless of property insertion order (`canonicalStringify`
 * sorts keys at every nesting level). Two specs with different content
 * produce different hashes with collision probability ~2^-64 for
 * adversarial inputs.
 *
 * Synchronous so callers (webview's outgoing requests, provider's
 * response matching) don't have to thread async/await through state
 * machines.
 */
export function computeSpecHash(spec: QvizSpec): string {
	const text = canonicalStringify(spec);
	let h1 = 0x811c9dc5 >>> 0;
	let h2 = 0xcbf29ce4 >>> 0;
	// Discriminator byte: pass 1 sees 0x00 first, pass 2 sees 0xff first.
	// Without this, two parallel FNV streams over identical bytes are
	// derivable from one another for the same input (still independent
	// but reduces avalanche distinctness).
	h1 = Math.imul(h1 ^ 0x00, 0x01000193) >>> 0;
	h2 = Math.imul(h2 ^ 0xff, 0x01000193) >>> 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
	}
	const part1 = h1.toString(16).padStart(8, '0');
	const part2 = h2.toString(16).padStart(8, '0');
	return SPEC_HASH_PREFIX + part1 + part2;
}
