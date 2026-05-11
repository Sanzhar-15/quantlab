/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Action types for the qviz webview store (Phase 5 step B.2).
 *
 * One discriminated union covers actions for every slice. Each slice's
 * reducer receives the full union; reducers that don't recognize an
 * action return their state unchanged (the standard reducer pattern).
 *
 * Actions arrive from two sources:
 *   1. The provider via postMessage (after `validateExtensionMessage`).
 *      These are wrapped as `applyExtensionMessage`-style actions.
 *   2. The webview UI (column drag, transform edit, save click, etc).
 *      These dispatch directly with a per-action shape.
 *
 * Actions are vscode-free and JSON-serializable -- but they don't need
 * to cross the postMessage boundary. The provider sends ExtensionMessage
 * envelopes; an adapter translates them into Actions and dispatches.
 */

import type {
	DaemonStatusKind, DatasetStatusKind,
	SchemaDriftKind, SchemaInfo, ThemeTokens, DaemonCapabilities,
	InspectorFilter, ColumnStats,
} from '../../../src/qviz/messageProtocol';
import type { ChartFamily, ChartType, Encoding, QvizSpec, Transform } from '../../../src/qviz/spec';

// ---------------------------------------------------------------------------
// extension → webview messages, lifted into actions
// ---------------------------------------------------------------------------

/** Provider sent the initial state (file path + spec, possibly schema). */
export interface ActionInit {
	readonly type: 'init';
	readonly fsPath: string;
	readonly spec: QvizSpec;
	readonly schema?: SchemaInfo;
	readonly capabilities?: DaemonCapabilities;
	/** SpecHash of the spec currently on disk. Determines initial
	 *  `lastSavedHash` in the spec slice. When omitted, the reducer
	 *  treats the loaded spec AS the saved spec (fresh open
	 *  semantics). Step 5.H.2: distinguishes "fresh open" from
	 *  "undo echo with the user's unsaved edits already on top". */
	readonly lastSavedHash?: string;
}

/** Provider sent fresh data for the most recent request. The payload
 *  carries the Arrow IPC bytes; the webview's renderer adaptor extracts
 *  columns from them. */
export interface ActionDataReceived {
	readonly type: 'dataReceived';
	readonly requestId: number;
	readonly specHash: string;
	readonly arrow: Uint8Array;
	readonly elapsedMs: number;
	readonly cached: boolean;
	readonly diagnostics: readonly string[];
}

export interface ActionError {
	readonly type: 'errorReceived';
	readonly requestId: number;
	/** Required: errors are spec-attributed in the post-megaudit-2 protocol.
	 *  The reducer drops errors whose specHash doesn't match the in-flight
	 *  slot, same as `dataReceived`. */
	readonly specHash: string;
	readonly error: string;
	readonly errorKind: 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol';
	readonly transformIndex?: number;
}

/** Megaudit residual: webview-local error (extract / render) that fired
 *  AFTER `dataReceived` cleared inflight. The protocol-level
 *  `errorReceived` requires inflight match; for these post-data
 *  failures there's no inflight to match. This action updates the
 *  same lastError* fields so the diagnostics readout + announcer
 *  surface the failure. */
export interface ActionLocalError {
	readonly type: 'localErrorReceived';
	readonly specHash: string;
	readonly error: string;
	readonly errorKind: 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol';
}

export interface ActionThemeUpdated {
	readonly type: 'themeUpdated';
	readonly tokens: ThemeTokens;
}

export interface ActionDaemonStatus {
	readonly type: 'daemonStatus';
	readonly status: DaemonStatusKind;
	readonly retryInMs?: number;
	readonly lastError?: string;
}

export interface ActionSchemaChanged {
	readonly type: 'schemaChanged';
	readonly oldHash: string;
	readonly newHash: string;
	readonly drift: SchemaDriftKind;
	readonly newSchema: SchemaInfo;
	readonly missingFields?: readonly string[];
}

/** Save result, attributed to the spec that was saved.
 *  - On `ok`: `fsPath` MUST be set, `error` MUST be omitted.
 *  - On `failed`: `error` MUST be set, `fsPath` MUST be omitted.
 *  - `specHash` is REQUIRED so the persistence reducer can match the
 *    result against the spec that was sent for save. A late-arriving
 *    `saveResult` for a stale spec must NOT mark the document clean
 *    (Step B megaudit C8: silent data loss). */
export type ActionSaveResult =
	| {
		readonly type: 'saveResult';
		readonly status: 'ok';
		readonly specHash: string;
		readonly fsPath: string;
	}
	| {
		readonly type: 'saveResult';
		readonly status: 'failed';
		readonly specHash: string;
		readonly error: string;
	};

export interface ActionCapabilities {
	readonly type: 'capabilitiesUpdated';
	readonly capabilities: DaemonCapabilities;
}

/** Step 5.I.3: dataset-availability status. */
export interface ActionDatasetStatus {
	readonly type: 'datasetStatus';
	readonly status: DatasetStatusKind;
	readonly datasetUri: string;
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// webview UI actions
// ---------------------------------------------------------------------------

/** A new request is being sent to the provider; track its id + specHash
 *  so we can drop stale responses. */
export interface ActionRequestStarted {
	readonly type: 'requestStarted';
	readonly requestId: number;
	readonly specHash: string;
}

/** The user's ChartType picker fired. */
export interface ActionSetChartType {
	readonly type: 'setChartType';
	readonly family: ChartFamily;
	readonly chartType: ChartType;
}

/** The user assigned a column to an encoding shelf (or cleared it). */
export interface ActionSetEncoding {
	readonly type: 'setEncoding';
	readonly channel: 'x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col';
	readonly encoding: Encoding | null;
}

/** Replace the OHLCV cluster (candlestick path). */
export interface ActionSetOhlcv {
	readonly type: 'setOhlcv';
	readonly ohlcv: { time: string; open: string; high: string; low: string; close: string; volume?: string } | null;
}

/** Insert/replace/delete a transform at `index`. */
export interface ActionUpsertTransform {
	readonly type: 'upsertTransform';
	readonly index: number;
	readonly transform: Transform;
}

export interface ActionDeleteTransform {
	readonly type: 'deleteTransform';
	readonly index: number;
}

export interface ActionMoveTransform {
	readonly type: 'moveTransform';
	readonly fromIndex: number;
	readonly toIndex: number;
}

/** UI focus actions. */
export interface ActionFocusColumn {
	readonly type: 'focusColumn';
	readonly columnName: string | null;
}

export interface ActionOpenTransformEditor {
	readonly type: 'openTransformEditor';
	readonly index: number | null;
}

export interface ActionSetActiveShelf {
	readonly type: 'setActiveShelf';
	readonly channel: 'x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col' | null;
}

/** Persistence intent actions (translated to provider messages by the
 *  message-adapter layer). `specHash` records which spec was sent so
 *  the matching saveResult can be authenticated. */
export interface ActionSaveStarted {
	readonly type: 'saveStarted';
	readonly specHash: string;
}

export interface ActionRendererSwapped {
	readonly type: 'rendererSwapped';
	readonly family: ChartFamily | null;
}

/** Emitted by the renderer host after `applyTimeseriesPlan` /
 *  `applyGeneralPlan` resolves; tracks "is there a live view handle?". */
export interface ActionRendererHandleChanged {
	readonly type: 'rendererHandleChanged';
	readonly hasViewHandle: boolean;
}

// ---------------------------------------------------------------------------
// the union
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 6 inspector actions
// ---------------------------------------------------------------------------

export interface ActionInspectorToggle {
	readonly type: 'toggleInspector';
	/** When omitted, the reducer toggles the current value. */
	readonly visible?: boolean;
}

export interface ActionSetColumnFilter {
	readonly type: 'setColumnFilter';
	readonly column: string;
	/** `null` clears the column's filter entirely. */
	readonly filter: InspectorFilter | null;
}

export interface ActionClearAllFilters {
	readonly type: 'clearAllFilters';
}

export interface ActionSetSelection {
	readonly type: 'setSelection';
	/** `null` clears the selection. Must always carry the actual value,
	 *  not a row index, because the chart can be aggregated. */
	readonly x: unknown;
}

export interface ActionClearSelection {
	readonly type: 'clearSelection';
}

export interface ActionSetScrollOffset {
	readonly type: 'setScrollOffset';
	readonly offset: number;
}

export interface ActionInspectorDataReceived {
	readonly type: 'inspectorDataReceived';
	readonly arrow: Uint8Array;
	readonly offset: number;
	readonly n: number;
	readonly total?: number;
	readonly elapsedMs: number;
}

export interface ActionInspectorError {
	readonly type: 'inspectorError';
	readonly error: string;
}

export interface ActionColumnStatsRequested {
	readonly type: 'columnStatsRequested';
	readonly column: string;
}

export interface ActionColumnStatsReceived {
	readonly type: 'columnStatsReceived';
	readonly column: string;
	readonly stats: ColumnStats;
}

export interface ActionColumnStatsError {
	readonly type: 'columnStatsError';
	readonly column: string;
	readonly error: string;
}

/** Phase 8 Step B: undo / redo for UI-state changes (inspector toggle,
 *  selection). Spec edits remain on VS Code's native CustomDocument
 *  undo stack and are reached by Ctrl+Z falling through to VS Code
 *  whenever the webview's UI history is empty.
 */
export interface ActionUndoUiHistory {
	readonly type: 'undoUiHistory';
}
export interface ActionRedoUiHistory {
	readonly type: 'redoUiHistory';
}

export type Action =
	| ActionInit
	| ActionDataReceived
	| ActionError
	| ActionLocalError
	| ActionThemeUpdated
	| ActionDaemonStatus
	| ActionSchemaChanged
	| ActionSaveResult
	| ActionCapabilities
	| ActionDatasetStatus
	| ActionRequestStarted
	| ActionSetChartType
	| ActionSetEncoding
	| ActionSetOhlcv
	| ActionUpsertTransform
	| ActionDeleteTransform
	| ActionMoveTransform
	| ActionFocusColumn
	| ActionOpenTransformEditor
	| ActionSetActiveShelf
	| ActionSaveStarted
	| ActionRendererSwapped
	| ActionRendererHandleChanged
	| ActionInspectorToggle
	| ActionSetColumnFilter
	| ActionClearAllFilters
	| ActionSetSelection
	| ActionClearSelection
	| ActionSetScrollOffset
	| ActionInspectorDataReceived
	| ActionInspectorError
	| ActionColumnStatsRequested
	| ActionColumnStatsReceived
	| ActionColumnStatsError
	| ActionUndoUiHistory
	| ActionRedoUiHistory;
