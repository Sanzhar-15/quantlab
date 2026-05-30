/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- TypeScript declarations mirroring the
 * `ql-bindings-node` napi-rs surface (Rust crate at
 * `quantlab-quantbook/quantbook-engine/crates/ql-bindings-node`).
 *
 * **Source of truth**: the Rust crate. If you edit this file, also
 * update `crates/ql-bindings-node/src/lib.rs` (and vice versa). V2
 * will add a generator (`@napi-rs/cli typegen`) to keep them in sync
 * automatically.
 *
 * **V1 surface**: a single class `CollabSession` exposing the minimum
 * round-trip methods. See the Rust crate's module docs for V1 surface
 * rationale + V2 deferred list.
 */

/**
 * A peer-to-peer collaboration session. Wraps the engine's
 * `ql_collab::CollabSession`.
 *
 * **Failure modes** (constructors throw JS `Error`):
 * - `peerId == 0n` -- PeerId reserves 0 (Loro sentinel)
 * - `peerId < 0n` -- PeerId is u64-domain
 * - `peerId` exceeds u64 -- lossy BigInt conversion
 *
 * Method failures (engine-level errors, e.g., merge of malformed
 * bytes) surface as JS `Error` exceptions with the engine's error
 * message string.
 */

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- JS-side mirror of the engine
 * `PresenceState` struct.**
 *
 * All fields are required.  Cursor coords are `(sheet, row, col)`;
 * selection-rectangle opposite corner is `(selectionEndRow,
 * selectionEndCol)`.  When no range is selected, set `selectionEnd*`
 * to match the cursor coords (collapsed selection).
 *
 * `typing` is a soft hint for IDE cursor styling (true while peer is
 * mid-edit, e.g., formula bar focused or in-cell edit mode).
 *
 * Engine pairs this type with napi conversion at the FFI boundary
 * (`crates/ql-bindings-node/src/lib.rs` `PresenceStateJson` struct +
 * `From<CorePresenceState>` impls).
 */
export interface PresenceStateJson {
	sheet: number;
	row: number;
	col: number;
	selectionEndRow: number;
	selectionEndCol: number;
	typing: boolean;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-side mirror of the engine
 * `CellValueJson` napi struct.**
 *
 * Discriminated-union shape: `kind` is one of `"number" | "boolean" |
 * "text" | "error" | "pending"`; exactly one of the optional payload
 * fields is set per non-pending variant; `pending` has all four
 * payloads absent (napi-rs serializes Rust `Option::None` as ABSENT
 * properties; the fields are `undefined`, NOT `null`).  Mirrors the
 * V3.4.0.2 `exportSnapshot` JSON output's per-cell value discriminator,
 * promoted to a typed napi(object) at V3.5.0.2 for the
 * `WorkbookSnapshotJson` surface.
 */
export interface CellValueJson {
	// Phase 6.3-1c (2026-05-30): 'blank' added to mirror the engine's full
	// CellValue variant set -- the napi converter (cell_value_json_from_session)
	// emits kind:'blank' (all payloads absent) for CellValue::Blank. Snapshots
	// still OMIT blank cells (CellSnapshot.value absent), so 'blank' surfaces on
	// the wire only via a columnar query_range read (reserved for v1.5); declared
	// now for forward DTO field-parity with the engine.
	kind: 'number' | 'boolean' | 'text' | 'error' | 'pending' | 'blank';
	// napi-rs serializes Rust Option<T>::None as ABSENT (undefined) at the JS
	// layer, NOT null.  Declared as optional (?:) to reflect this.  IDE
	// consumers MUST switch on `kind` to know which payload field is set.
	number?: number;
	boolean?: boolean;
	text?: string;
	error?: string;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- one cell entry in a sheet snapshot.**
 *
 * `value` absent = formula-only cell (formula text, no cached literal).
 * `formula` absent = pure literal cell (PutValue, no formula text).
 * Both present = formula evaluated to a literal (formula text + cached
 * value coexist).  All three (value + formula + format) absent cannot
 * occur (V3.4.0.X MEDIUM-1 closure extended at V3.5.0.5 to format --
 * such empty CellState entries are removed from the cache).
 *
 * **napi-rs absence convention** (V3.5.0.X audit-closure A-LOW-1 doc
 * hygiene, 2026-05-24): Rust `Option<T>::None` serializes to ABSENT
 * JS properties (the field is `undefined`, NOT `null`).  Tests assert
 * `=== undefined`.  Use TypeScript's optional `?:` syntax to model
 * this contract.
 */
export interface CellSnapshotJson {
	row: number;
	col: number;
	// napi-rs Option<T>::None -> absent (undefined) at the JS layer.  Declared
	// as optional (?:) to reflect this.  `value: undefined` = formula-only
	// cell; `formula: undefined` = pure literal cell; ALL THREE undefined
	// cannot occur (V3.4.0.X MEDIUM-1 closure extended at V3.5.0.5 -- such
	// empty CellState entries are removed from the cache).
	value?: CellValueJson;
	formula?: string;
	/**
	 * **Phase 5.7 V3.5.0.5 (2026-05-24)** -- per-cell format passthrough.
	 *
	 * `undefined` = no explicit format (cell renders with FormatId::GENERAL
	 * default per the engine).  Set via `Op::SetCellFormat { id: Some(_) }`;
	 * cleared via `Op::SetCellFormat { id: None }`.  Round-trips through
	 * V3.6+ format-aware rendering.
	 */
	format?: FormatIdJson;
	/**
	 * **Phase 5.7 V3.6.0.5 D4 (2026-05-23)** -- engine-pre-rendered
	 * formatted string for this cell value.
	 *
	 * Populated by the engine via `ql_functions::format::render(value,
	 * parsed_format, eval_context)` where:
	 * - `eval_context.date_system` comes from the workbook (see
	 *   {@link WorkbookSnapshotJson.dateSystem}).
	 * - `eval_context.locale` comes from the workbook (post
	 *   V3.6.0.X audit-of-D4 CONVERGENT-MED-1 closure; pre-closure
	 *   was hardcoded `EnUs`).  Render layer ignores locale today
	 *   (English month names hardcoded) but the passthrough prevents
	 *   silent forward-compat regression when locale-aware rendering
	 *   lands at V3.6.1+.
	 * - `eval_context.now_provider = System` (NOW()/TODAY() in
	 *   format strings get system clock).
	 *
	 * **Per-call cost** (post V3.6.0.X audit-of-D4 CONVERGENT-MED-2
	 * closure): `format::parse` runs ONCE per unique `FormatId` per
	 * `workbookSnapshot()` call via per-snapshot parsed-format cache.
	 * Pre-closure: per-cell parse.  V3.7+ may promote the cache to
	 * `CollabSession` for cross-call reuse if profiling justifies.
	 *
	 * **`undefined` cases** (silent fallback per Phase 5.6
	 * conservative discipline; IDE consumer falls back to
	 * value-based default rendering when `rendered` is absent):
	 * - cell has no `format` (no format registered)
	 * - cell has no `value` (formula-only cell awaiting evaluation)
	 * - cell value `is_pending()` (post V3.6.0.X audit-of-D4
	 *   CONVERGENT-HIGH-3 closure: pending cells skip pre-render so
	 *   the IDE's `"(pending)"` fallback fires; pre-closure pending
	 *   cells with number formats rendered as `"0.00"`)
	 * - cell's `format` id is missing from
	 *   {@link WorkbookSnapshotJson.formats}
	 * - the registered format string fails to parse (V2 token,
	 *   malformed grammar)
	 * - cell value carries an unknown error sigil
	 *
	 * **CSP-safe consumer contract**: IDE renderers MUST `escapeHtml`
	 * the rendered string before inserting into innerHTML (per the
	 * V3.2.a webview discipline).
	 *
	 * **Edit-flow note** (V3.6.0.X audit-of-D4 OPUS-HIGH-2 closure):
	 * IDE consumers presenting click-to-edit MUST source the input
	 * value from `data-raw-value` (the parseable raw representation),
	 * NOT from the rendered display string -- `parseCellRawInput` does
	 * `Number(trimmed)` which NaN's on `"$1,234.56"` / `"50.00%"` /
	 * `"1,234"` / date strings.  See `cellGridHtml.ts` `renderRows`
	 * + `beginEdit` client function for the pattern.
	 */
	rendered?: string;
}

/**
 * **Phase 5.7 V3.5.0.5 (2026-05-24)** -- JS-side mirror of the engine
 * `FormatIdJson` napi struct (which mirrors `ql_storage::FormatId`).
 *
 * Discriminated-union shape: `kind` is `"builtin"` or `"custom"`; for
 * builtin the `builtin` field is set (other fields absent); for custom
 * the `customPeer` (bigint -- u64 widened) and `customCounter` (u32)
 * fields are set.
 *
 * napi-rs Option<T>::None -> absent JS property; the alternative-variant
 * fields are `undefined` (not null).  Discriminate via `kind`.
 */
export interface FormatIdJson {
	kind: 'builtin' | 'custom';
	/** Set when `kind === 'builtin'`; undefined otherwise. */
	builtin?: number;
	/** Set when `kind === 'custom'`; undefined otherwise.  u64 widened to bigint. */
	customPeer?: bigint;
	/** Set when `kind === 'custom'`; undefined otherwise. */
	customCounter?: number;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- one sheet entry in the workbook snapshot.**
 *
 * `id` is the sheet's u16 SheetId widened to JS number (lossless;
 * 0..65535 range fits in JS number safely).  `name` is the sheet's
 * display name (carries the latest RenameSheet effect).  `cells` is
 * sorted (row, col) ascending per snapshot_cells contract.  Empty
 * sheets (created via addSheet but no PutValue/PutFormula) DO appear
 * with `cells: []` (V3.5.0.2 enumerates via Workbook::sheet_count(),
 * not list_sheets_from_cache).
 */
export interface SheetSnapshotJson {
	id: number;
	name: string;
	cells: CellSnapshotJson[];
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- flattened workbook snapshot for
 * IDE-side rendering.**
 *
 * Returned by {@link CollabSessionInstance.workbookSnapshot}.  Per
 * V3.5.0.1 D3: chosen over the alternative (mirror full ql-storage
 * Workbook API across FFI) because the flattened view is pre-shaped
 * for the IDE renderer.
 *
 * **V3.5.0.2 ship**: `sheets` only.  **V3.6.0.3 D2 (2026-05-24) adds
 * `formats: FormatDefJson[]`** -- session-wide format registry merging
 * Builtin (ids 0..=163) + Custom (`Op::RegisterFormat`-registered)
 * entries.  Additive (V3.5 consumers that destructure `.sheets` only
 * keep working).  V3.6+ format-aware buildHtml rendering will use
 * this list to interpret `CellSnapshotJson.format`.
 *
 * **Performance note (R-V3.5-1)**: large workbooks produce large JSON.
 * Callers MUST batch (do NOT call per-keystroke); the napi method's
 * per-call cost is O(N) in op count from rebuild_workbook + O(N_formats)
 * for the formats array (typically < 100).  V3.7+ may add incremental
 * deltas.
 */
export interface WorkbookSnapshotJson {
	sheets: SheetSnapshotJson[];
	/**
	 * **V3.6.0.3 D2 (2026-05-24)**: session-wide format registry.
	 * Populated from the rebuilt+repaired engine `Workbook.FormatTable`
	 * (authoritative source merging Excel-canonical Builtin ids in the
	 * 0..=163 reserved range with Custom ids registered via
	 * `Op::RegisterFormat`).  Note that ~20 of the 0..=163 Builtin ids
	 * are actually preloaded at engine startup; the remainder are
	 * reserved per Excel spec but absent from the table until a
	 * producer emits an `Op::RegisterFormat` for them.
	 *
	 * **Sort order** (V3.6.0.X audit-of-D2 closure, 2026-05-23,
	 * CONVERGENT-MED-1): sorted by `FormatId` via the engine's derived
	 * `Ord` -- Builtin variants first (by id), then Custom variants
	 * lexicographically by `(peer, counter)`.  Pre-closure this was
	 * raw HashMap iteration order which varied across consecutive
	 * `workbookSnapshot()` calls (per-instance random hasher).  Post-
	 * closure: deterministic + stable shape across snapshots (hashable,
	 * diffable, JSON-stringify-equal).
	 *
	 * **V3.6.0.5 D4 format-aware buildHtml rendering SHIPPED**: the
	 * engine pre-renders cells with format + value via
	 * `ql_functions::format::render` (post-D4 audit-of-D4 closures:
	 * locale passthrough + per-snapshot parse cache + Pending skip).
	 * IDE consumers should PREFER {@link CellSnapshotJson.rendered}
	 * (engine-pre-rendered display string) over walking
	 * `formats[]` themselves.  The `formats[]` array stays for:
	 * (a) registry / debug / fixture-introspection use cases,
	 * (b) V3.7+ direct-rendering scenarios (e.g., format-picker
	 *     UI showing format strings to the user),
	 * (c) consumers needing the format string for their own
	 *     external rendering pipelines.
	 */
	formats: FormatDefJson[];
	/**
	 * **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: workbook-level date system.
	 *
	 * Mapped from the engine's `ql_types::DateSystem`:
	 * - `"Excel1900"`: 1900 epoch (1899-12-30 = serial 0); Windows
	 *   Excel default; includes the phantom 1900-02-29 = serial 60.
	 * - `"Excel1904"`: 1904 epoch (1904-01-01 = serial 0); legacy
	 *   macOS Excel default.
	 *
	 * Used by the engine's `format::render` EvalContext when
	 * pre-rendering date/time formats via {@link CellSnapshotJson.rendered}.
	 * IDE consumers needing to render dates directly (e.g., date
	 * pickers) should consult this field; cells with a date format
	 * are already pre-rendered.
	 */
	dateSystem: 'Excel1900' | 'Excel1904';
	/**
	 * **Phase 5.7 V3.6.0.8.4 OPUS-HIGH-2 closure (2026-05-25)**:
	 * opaque Loro version-vector token captured at the moment of this
	 * snapshot.  Pass back as `lastSeenVersion` on the next
	 * {@link CollabSessionInstance.workbookSnapshotDelta} call.  The
	 * IDE should NOT decode this -- it's a raw `Buffer` of Loro's
	 * `VersionVector::encode()` output.
	 *
	 * **Why on the snapshot reply**: V3.6.0.8.3 shipped without a
	 * `currentVersion()` accessor; the mocha tests probed via empty-
	 * Buffer delta calls.  V3.6.0.8.4 Opus audit flagged that probe
	 * as a race-window risk in multi-window collab (engine could
	 * receive a remote op between snapshot + probe).  Bundling
	 * `version` here makes populate-and-capture atomic against the
	 * engine's lock-held cache populate.
	 *
	 * **TypeScript-side optional** (napi-side always populated):
	 * marked optional so fixture-literal unit tests that construct
	 * `WorkbookSnapshotJson` by hand don't need an opaque
	 * `Buffer.alloc(0)` placeholder.  Real napi calls ALWAYS populate
	 * `version`; the shape-pinning tests at the napi boundary (suites
	 * `quantbook V3.5.0.2 -- workbookSnapshot napi contract` +
	 * `quantbook V3.6.0.5 -- WorkbookSnapshotJson shape`) verify
	 * presence via `Object.keys(snap)`.  Consumers reading `version`
	 * for delta calls should treat it as required when the snapshot
	 * came from a real `workbookSnapshot()` invocation.
	 */
	version?: Buffer;
	/**
	 * **Phase 6.3-1c M5 (2026-05-30)**: the contract DTO schema version
	 * (engine `ql_session::SCHEMA_VERSION`) every DTO crossing the boundary
	 * carries (contract section 4.1). The IDE asserts this matches
	 * {@link QUANTBOOK_SCHEMA_VERSION} on snapshot ingest; a mismatch is a
	 * fail-loud `unsupported_schema_version` (the IDE is that code's producer),
	 * never a silent shape drift.
	 *
	 * **TypeScript-side optional** (napi-side always populated): marked optional
	 * so fixture-literal unit tests that hand-construct `WorkbookSnapshotJson`
	 * need not set it. Real napi calls ALWAYS populate it.
	 */
	schemaVersion?: number;
}

/**
 * **Phase 5.7 V3.6.0.3 D2 (2026-05-24) -- one format registration in
 * the WorkbookSnapshot's `formats` array.**
 *
 * Pairs a {@link FormatIdJson} (V3.5.0.5 wire shape) with its format
 * string.  V3.6+ buildHtml rendering uses this for number / date /
 * currency display.
 */
export interface FormatDefJson {
	/**
	 * The FormatId in V3.5.0.5 wire shape (kind = "builtin" |
	 * "custom"; payload fields per kind).
	 */
	id: FormatIdJson;
	/**
	 * The format string (e.g., `"0.00%"`, `"yyyy-mm-dd"`).  Used by
	 * V3.6+ engine-side `FormatTable::render_value` for number / date
	 * / currency display.
	 */
	string: string;
}

/**
 * **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- one cell entry in a
 * delta payload.**
 *
 * Pairs a sheet id with the per-cell snapshot data.  The IDE merges
 * each into its prior render keyed by `(sheet, row, col)`.
 */
export interface ChangedCellJson {
	sheet: number;
	cell: CellSnapshotJson;
}

/**
 * **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- one removed-cell entry.**
 *
 * IDE clears its cached cell at `(sheet, row, col)`.  Always empty
 * at V3.6.0.8.3 (V3.7+ feature).
 */
export interface RemovedCellJson {
	sheet: number;
	row: number;
	col: number;
}

/**
 * **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- incremental WorkbookSnapshot
 * delta reply.**
 *
 * Returned by {@link CollabSessionInstance.workbookSnapshotDelta}.
 * See the napi method's docstring for the two-call IDE consumer
 * protocol + V3.6.0.8.3 scope limitations.
 *
 * **Additive over V3.5/V3.6 WorkbookSnapshotJson** -- no shape break;
 * older consumers continue to call `workbookSnapshot()` and ignore
 * this delta surface entirely.
 */
export interface WorkbookSnapshotDeltaJson {
	/**
	 * Cells that newly exist OR whose value / formula / format /
	 * rendered changed since `lastSeenVersion`.
	 */
	changedCells: ChangedCellJson[];
	/**
	 * Cells that no longer exist at their `(sheet, row, col)`.
	 * Always empty at V3.6.0.8.3 (V3.7+ feature -- true removals
	 * invalidate the cache via `force_clear_workbook_cache` so the
	 * next delta call returns `fullRebuildRequired=true`).
	 */
	removedCells: RemovedCellJson[];
	/**
	 * Sheets whose metadata changed since `lastSeenVersion`.  Always
	 * empty in the V3.6.0.8.3 cell-only path (cell ops don't change
	 * sheet metadata); full-rebuild paths surface sheets via
	 * `fullRebuildRequired=true` + the IDE's full `workbookSnapshot()`
	 * re-fetch.
	 */
	sheetsChanged: SheetSnapshotJson[];
	/**
	 * Sheet ids tombstoned since `lastSeenVersion` (Op::RemoveSheet).
	 * The IDE removes its sheet entry for each.
	 */
	sheetsRemoved: number[];
	/**
	 * Formats registered since `lastSeenVersion` (Op::RegisterFormat
	 * for Custom ids; Builtin ids are not emitted per the V3.6.0.X
	 * audit-of-D2 closure).  IDE merges each into its `formats`
	 * table by FormatId.
	 */
	formatsAdded: FormatDefJson[];
	/**
	 * Opaque version-vector token.  IDE stores + passes back as
	 * `lastSeenVersion` on the next call.  Encoded via Loro's
	 * `VersionVector::encode()` (stable wire format).
	 */
	version: Buffer;
	/**
	 * `true` when the engine could not produce a delta and the IDE
	 * MUST call `workbookSnapshot()` instead.  Sources: first call
	 * (empty `lastSeenVersion`), cache miss, staleness (version
	 * mismatch), malformed `lastSeenVersion`, rename op in delta.
	 *
	 * When `true`, all other arrays are empty; `version` carries the
	 * engine's CURRENT VV so the IDE can retry the delta call right
	 * after the `workbookSnapshot()` re-fetch (no race window).
	 */
	fullRebuildRequired: boolean;
	/**
	 * **Phase 6.3-1c (2026-05-30, contract section 4.3)**: when
	 * `fullRebuildRequired` is `true` for an ENUMERATED, designed resync state,
	 * the reason. `undefined` when `fullRebuildRequired` is `false`, or for a
	 * full-rebuild case that is not one of the four designed states (a malformed
	 * token -- which the contract reserves for a fail-loud `invalid_version_token`
	 * but the legacy collab path treats as a recoverable resync -- a rename, or a
	 * defensive cache-invariant guard).
	 */
	fullRebuildReason?: 'no_prior_version' | 'cache_cleared' | 'stale_horizon' | 'epoch_mismatch';
	/**
	 * **Phase 6.3-1c M5 (2026-05-30)**: contract DTO schema version -- see
	 * {@link WorkbookSnapshotJson.schemaVersion}. Optional TS-side (napi always
	 * populates) for hand-constructed fixture literals.
	 */
	schemaVersion?: number;
}

export interface CollabSessionInstance {
	/**
	 * V1 convenience: append a `PutValue` op with a numeric value.
	 * Full Op enum binding is V2 work; V1 exposes this single variant
	 * because it's the minimum that demonstrates the round-trip.
	 */
	appendPutValue(sheet: number, row: number, col: number, value: number): void;

	/**
	 * **Phase 5.7 V3.6.0.6 D5 (2026-05-24)** -- append an `Op::PutFormula`
	 * to this session.  The cell at `(sheet, row, col)` receives the
	 * formula text `text` (e.g., `"=SUM(A1:B10)"`); the engine stores
	 * it verbatim and `rebuild_workbook` materializes the formula via
	 * Phase 5.3 `repair_sheet_rename_chain` at snapshot time so
	 * cross-sheet refs to renamed sheets surface repaired text in
	 * {@link WorkbookSnapshotJson.sheets}`[].cells[].formula`.
	 *
	 * Use the typed wrapper {@link putFormula} from `./session` for
	 * JS-side validation BEFORE the napi boundary (napi-rs's ToUint32
	 * coercion silently wraps negative/non-integer sheet/row/col args,
	 * so pre-validation surfaces precise `[bad_argument]` errors).
	 *
	 * **No wire change**: `Op::PutFormula` is unchanged since
	 * Phase 4.6.x.  Cross-peer convergence handled by the existing
	 * cell-keyed CacheEffect path.
	 *
	 * **V3.5.0.X A-HIGH-2 closure**: this method unblocks end-to-end
	 * repaired-formula verification from the IDE.  Pre-D5 the repair
	 * was tested only by Rust ql-collab regressions because the IDE
	 * had no PutFormula write-path.
	 *
	 * **Edit-flow companion** (V3.6.0.X audit-of-D4 OPUS-HIGH-2 section G.2):
	 * IDE renderers MUST emit `data-raw-formula` for cells with
	 * formula text so `beginEdit` shows formula source on click-to-
	 * edit, NOT the cached literal value.
	 *
	 * @throws `[bad_argument]` if `row` or `col` is non-integer / out
	 *         of u32 range / NaN / Infinity.
	 * @throws `[session_oplog]` if the underlying `append_op` fails.
	 */
	appendPutFormula(sheet: number, row: number, col: number, text: string): void;

	/**
	 * **Phase 5.7 V3.4.0.4a (2026-05-23)** -- append an `Op::AddSheet`
	 * to the session.  Sheet ids are deterministic + assigned by the
	 * engine on replay in op-log append order (first `addSheet` call
	 * creates sheet 0, second creates sheet 1, ...).
	 *
	 * Surfaced at V3.4.0.4a because `to_qbook` -> `rebuild_workbook`
	 * replay requires sheets to exist before any `PutValue` on them.
	 * Callers building sessions for .qbook persistence MUST `addSheet`
	 * before `appendPutValue` for that sheet.
	 *
	 * `chunkRows`: per-sheet row partition size for the Workbook's
	 * internal storage (Phase 2A optimization).  Pass 1000 for typical
	 * V3.4 scale.
	 */
	addSheet(name: string, chunkRows: number): void;

	/**
	 * **Phase 5.7 V3.5.0.3a (2026-05-24)** -- append an `Op::RenameSheet`
	 * to this session.  The sheet at `id` is renamed to `newName` at
	 * replay time.  `id` is the current u16 sheet id (the index assigned
	 * by `addSheet` in append order).
	 *
	 * **Contract divergence from engine `WorkbookRuntime::rename_sheet`**:
	 * this napi is a THIN wrapper that appends ONLY `Op::RenameSheet` --
	 * formula text referencing the old sheet name stays stale in the
	 * cache until the next `workbookSnapshot` / `exportToQbook` call,
	 * which triggers Phase 5.3 `repair_sheet_rename_chain` at
	 * rebuild_workbook time.  For V3.5.0.3a scope this is acceptable
	 * (IDE flow always reads through workbookSnapshot).
	 *
	 * **CRDT convergence**: cross-peer renames converge via Phase 5.3
	 * step 3 chain repair; concurrent renames to different names
	 * produce deterministic post-merge state.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet.
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	renameSheet(id: number, newName: string): void;

	/**
	 * **Phase 5.7 V3.5.0.3b (2026-05-24)** -- append an `Op::RemoveSheet`
	 * to this session (tombstone the sheet at `id`).
	 *
	 * **CRDT semantic (V3.5.0.3b decision lock)**: tombstone preserves
	 * the sheet's id slot (subsequent ops can still reference it by id;
	 * the cell-keyed apply_op handlers silently no-op writes to
	 * tombstoned sheets).  Concurrent re-delete is idempotent.
	 *
	 * **workbookSnapshot filter**: tombstoned sheets are SKIPPED in
	 * the returned snapshot (the IDE renderer doesn't see deleted
	 * sheets).
	 *
	 * **Formula references**: V3.5.0.3b leaves cross-sheet formula
	 * text intact (no `#REF!` substitution).  V3.6+ may extend
	 * repair_sheet_rename_chain to rewrite references to deleted
	 * sheets.
	 *
	 * **No restore**: V3.5.0.3b does not support undo-delete.  Cell
	 * storage is preserved internally but no `restoreSheet` napi
	 * exists.  V3.6+ may add this if a user-facing flow is justified.
	 *
	 * Use the typed wrapper {@link deleteSheet} from `./session`.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet (already-tombstoned is OK -- the
	 *         second delete is an idempotent no-op).
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	deleteSheet(id: number): void;

	/**
	 * **Phase 5.7 V3.6.0.10 D8 (2026-05-25)** -- append an
	 * `Op::RestoreSheet` to this session (un-tombstone a sheet
	 * previously deleted via `deleteSheet`).
	 *
	 * **CRDT semantic (V3.6.0.10 D8 decision lock)**: reverses the
	 * V3.5.0.3b tombstone effect.  Cells written BEFORE the original
	 * `deleteSheet` are preserved by the tombstone semantic and
	 * reappear on restore.  Cells silently-no-op'd while tombstoned do
	 * NOT reappear -- they never reached storage.
	 *
	 * **Cross-peer**: concurrent {`deleteSheet`, `restoreSheet`}
	 * resolved by Loro's causal-merge order; whichever op replays
	 * second wins.  Both peers converge to the same final tombstone
	 * state.  Already-restored or never-tombstoned ids are NOT a
	 * bad_argument (CRDT idempotency).
	 *
	 * **Cache + delta interaction**: `Op::RestoreSheet` is in the
	 * `workbookSnapshotDelta` fullRebuild allowlist (V3.6.0.10 D8
	 * `classify_delta_op` closure).  The next `workbookSnapshotDelta`
	 * call after a `restoreSheet` returns `fullRebuildRequired=true`;
	 * the IDE should call `workbookSnapshot()` to get the un-
	 * tombstoned sheet's cells back.
	 *
	 * Use the typed wrapper `restoreSheet` from `./session`.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a never-created sheet (already-restored / never-deleted
	 *         is OK -- the resulting op is an idempotent no-op).
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	restoreSheet(id: number): void;

	/**
	 * **Phase 5.7 V3.5.0.3c (2026-05-24)** -- append an `Op::MoveSheet`
	 * to this session (reorder sheet's display position; id stays
	 * stable).
	 *
	 * **CRDT semantic (V3.5.0.3c decision lock)**: display-order
	 * overlay -- the underlying `Workbook.sheets` vec is UNCHANGED;
	 * only a separate `sheet_display_order: Vec<SheetId>` is mutated.
	 * Subsequent ops referencing the moved sheet by id keep landing
	 * on the correct sheet (id stability preserved like V3.5.0.3b
	 * tombstone).
	 *
	 * **`newIndex` semantics**: 0-based position in the post-move
	 * display order.  Out-of-range values clamp to end (CRDT
	 * idempotency).
	 *
	 * **Move-tombstoned-sheet**: silently applies (display order
	 * remembers the user's intent even for deleted sheets; snapshot
	 * filters tombstones after display-order resolution).
	 *
	 * **workbookSnapshot**: iterates `sheet_display_order` so the
	 * IDE renderer sees sheets in the user's reorder order.
	 *
	 * Use the typed wrapper {@link moveSheet} from `./session`.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet.  `newIndex >= sheet_count` is OK
	 *         (clamped at replay time).  Tombstoned sheets are OK.
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	moveSheet(id: number, newIndex: number): void;

	/** Full snapshot export. Use for initial sync / handshake. */
	exportBytes(): Uint8Array;

	/**
	 * **Phase 5.7 V3.2.a (2026-05-22) -- cell-snapshot export for the
	 * IDE grid widget.**
	 *
	 * Returns a JSON-serialized snapshot of the latest `PutValue` per
	 * `(row, col)` on the requested sheet. Use `exportCellSnapshot()`
	 * from `./session` to parse the return value into the typed
	 * {@link QuantbookCellSnapshot} shape.
	 *
	 * V3.2.a scope: PutValue ops only (the only Op variant V1 binding
	 * exposes). V3.2.b+ may upgrade to route through
	 * `rebuild_workbook` when the full Op enum lands.
	 *
	 * Entries are sorted by `(row, col)` for deterministic output.
	 *
	 * @param sheet u16 sheet ID (0-based).
	 * @returns JSON string conforming to {@link QuantbookCellSnapshot}.
	 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
	 *         if the op log iterator or JSON serializer fails.
	 */
	exportSnapshot(sheet: number): string;

	/**
	 * **Phase 5.7 V3.3.0.2 (2026-05-22) -- enumerate distinct sheets
	 * present in the local op log.**
	 *
	 * Returns a sorted ascending array of u16 sheet IDs that have at
	 * least one `PutValue` op in the local op log.  Use the typed
	 * wrapper {@link listSheets} from `./session` rather than calling
	 * this method directly -- the wrapper returns `number[]` with
	 * proper TS typing on the array contents.
	 *
	 * V3.3.0 design decision D3 (LOCKED): u16-only return.  Display
	 * name + color + hidden flags wait for V3.4+'s `SheetMetadata` Op
	 * variant + a separate `listSheetsMetadata()` accessor.
	 *
	 * @returns sorted ascending Vec<u16> of distinct sheets referenced
	 *          by `PutValue` ops; empty array if no `PutValue` ops have
	 *          been appended.
	 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
	 *         if the op log iterator fails.
	 */
	listSheets(): number[];

	/**
	 * Merge a snapshot (or delta) from another peer. Returns the
	 * session's `opCount` AFTER the merge (NOT the number of newly
	 * merged ops -- duplicates are deduped by Loro but the return
	 * value is the post-merge total).
	 *
	 * **V1 audit closure (Codex M2, 2026-05-22)**: the original
	 * docstring claimed "count of ops actually merged" implying a
	 * delta. Verified empirically by calling `mergeBytes` twice with
	 * the same snapshot: both calls return the same `opCount` value.
	 * V2 may add a `mergeBytesDelta` companion that returns just the
	 * newly merged count, once the use case (e.g., "warn if peer
	 * sent us X new ops") materializes.
	 */
	mergeBytes(bytes: Uint8Array): number;

	/** Local op log length (visible LoroList). */
	opCount(): number;

	/**
	 * V2 V4 V1 step 2 helper: count of ops added since the last
	 * successful flush. Uses VV math (monotonic under undo). Sibling
	 * invariant: `pendingOpCount() > 0` iff `hasPendingFlush() === true`.
	 *
	 * V1 has no Transport binding, so this returns the count vs the
	 * empty baseline (same as `opCount()` for a never-flushed session).
	 * V2 makes this interesting once Transport surface is bound.
	 */
	pendingOpCount(): number;

	/** V2 V3 step 3 helper: `true` when local ops haven't been flushed. */
	hasPendingFlush(): boolean;

	/** Peer ID of this session, as a BigInt (u64-domain). */
	peerId(): bigint;

	/**
	 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- undo the session's last
	 * local op.**
	 *
	 * Returns `true` if the Loro `UndoManager` stack item was consumed
	 * (an inverse op got appended to the visible log) and `false` if
	 * the stack was empty (caller's "Cmd-Z when nothing to undo"
	 * no-op).  LOCAL-ONLY: remote ops merged via `mergeBytes` /
	 * `pollRemote` are NOT affected.
	 *
	 * **Post-consumed invariant**: the V3.3.0.X HIGH-1 closure ensures
	 * the engine rebuilds `last_snapshot` (V3.4.0.2 `CellState` shape)
	 * BEFORE returning, so a subsequent `exportSnapshot` reads the
	 * post-undo view atomically.
	 *
	 * **Auto-flush**: if a transport is attached via `attachTransport`
	 * + `setAutoFlushPolicy('onAppend')`, a consumed undo triggers
	 * auto-flush (peers receive the inverse op).  Empty-stack undo
	 * never attempts the flush -- closed transport cannot turn
	 * "nothing to undo" into a spurious error.
	 *
	 * Use the typed wrapper {@link undo} from `./session`.
	 *
	 * @throws Error with `parseQuantbookError(err).code` per the
	 *         engine's CollabSessionError kind (e.g., `transport_closed`
	 *         during auto-flush after a consumed undo).
	 */
	undo(): boolean;

	/**
	 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- redo the last undone op.**
	 *
	 * Mirrors {@link undo} for the redo direction; same consumed-bool
	 * return + cache + auto-flush + error semantics.
	 *
	 * Use the typed wrapper {@link redo} from `./session`.
	 */
	redo(): boolean;

	// =====================================================================
	// Phase 5.7 V3.4.0.5 (2026-05-23) -- presence surface (engine napi only)
	// IDE wiring (cell-grid decoration, sweep cadence, race guard) lands in
	// V3.4.0.5 IDE follow-up.
	// =====================================================================

	/**
	 * Write this session's own presence state into the shared LoroMap.
	 *
	 * Uses the session's PeerId as the map key (16-hex Display form).
	 * Subsequent calls overwrite the prior value (LWW per peer); merges
	 * with other peers' presence writes preserve all distinct peers.
	 *
	 * Use the typed wrapper {@link updatePresence} from `./session`.
	 */
	updatePresence(state: PresenceStateJson): void;

	/**
	 * Read a peer's most recent presence state.
	 *
	 * Returns `null` if the peer has never updated presence in this
	 * session (or was removed via {@link clearPresence} /
	 * {@link sweepPresence}).
	 */
	peerPresence(peer: bigint): PresenceStateJson | null;

	/**
	 * Remove this session's own presence entry from the shared map.
	 *
	 * Use when the peer leaves the session (window close, disconnect).
	 * After removal, other peers' `peerPresence(selfId)` returns `null`.
	 */
	clearPresence(): void;

	/**
	 * Remove ALL presence entries from the shared map.  Returns the
	 * count of peers removed.
	 *
	 * V1 contract: sweeps every entry unconditionally (no threshold).
	 * Use after {@link fromSnapshot} for "rejoin with clean presence":
	 * presence persists in the LoroDoc snapshot (V1 known limitation).
	 *
	 * Auto-flush triggers ONCE after the batch removal (not per-key).
	 */
	sweepPresence(): number;

	/**
	 * Enumerate peer-ids that have presence entries.
	 *
	 * Iteration order is Loro-internal (NOT guaranteed sorted).
	 * Callers needing determinism should `.sort((a, b) => a < b ? -1 :
	 * a > b ? 1 : 0)` (BigInt comparison).
	 *
	 * Use as the enumeration primitive for "who's here" panels: first
	 * call this, then call {@link peerPresence} per returned id.
	 */
	peersWithPresence(): bigint[];

	// =====================================================================
	// Phase 5.7 V3.5.0.2 (2026-05-24) -- workbook snapshot napi (D3)
	// =====================================================================

	/**
	 * Return the full workbook flattened to a JSON-serializable
	 * snapshot for IDE rendering.  See {@link WorkbookSnapshotJson}.
	 *
	 * Per-call cost is O(N) in op count (rebuild_workbook materializes
	 * a fresh Workbook to enumerate sheet names + count); per-sheet
	 * cells come from the V3.3.0.3 incremental cache.
	 *
	 * Use the typed wrapper {@link workbookSnapshot} from `./session`.
	 *
	 * @throws Error with `parseQuantbookError(err).code === 'session_oplog'`
	 *         if rebuild_workbook fails (replay error / rename-repair).
	 */
	workbookSnapshot(): WorkbookSnapshotJson;

	/**
	 * **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- incremental workbook snapshot
	 * delta.**
	 *
	 * Returns the cells / sheets / formats that changed since the
	 * caller's `lastSeenVersion`, or `fullRebuildRequired=true` when
	 * the engine can't produce a delta (cache miss, staleness,
	 * rename op in delta).  See {@link WorkbookSnapshotDeltaJson} for
	 * the consumer protocol.
	 *
	 * **Two-call IDE discipline**:
	 * 1. First call: pass `Buffer.alloc(0)`.  Returns
	 *    `fullRebuildRequired=true`.
	 * 2. IDE calls `workbookSnapshot()` (which populates the engine
	 *    cache + returns full state); IDE stores the `version` token
	 *    returned alongside (NB: V3.6.0.8.3 surfaces the version via
	 *    a follow-up delta call's `version` field; a dedicated
	 *    `currentVersion()` accessor is V3.6.0.8.4+ scope -- for
	 *    V3.6.0.8.3 IDEs probe by passing empty Buffer and reading
	 *    the returned `version`).
	 * 3. Subsequent calls: pass the stored `version`.  Returns either
	 *    a real delta (merge into prior render keyed by sheet/row/col)
	 *    OR `fullRebuildRequired=true` (discard local state, call
	 *    `workbookSnapshot()` again).
	 *
	 * **V3.6.0.8.3 cell-only fast-path**: when ops since cache are all
	 * cell-keyed (PutValue / PutFormula / ClearFormula / SetCellFormat
	 * / RegisterFormat / RemoveSheet, NOT rename ops), this is O(N_new_ops)
	 * + per-changed-cell rendering instead of full O(N_total_ops)
	 * rebuild_workbook + repair walks.  Any rename op in the delta
	 * triggers `fullRebuildRequired=true` (the IDE then falls back to
	 * `workbookSnapshot()`).
	 *
	 * **V3.6.0.8.3 scope limitations**:
	 * - `removedCells` is always empty (V3.7+ feature).
	 * - `sheetsChanged` is always empty in the cell-only path (cell
	 *   ops don't change sheet metadata).
	 *
	 * Use the typed wrapper `workbookSnapshotDelta` from `./session` once it lands.
	 *
	 * @throws Error with `parseQuantbookError(err).code === 'session_replay'`
	 *         if the cell-only fast-path's `apply_ops_in_range` fails
	 *         partway.  The engine clears its cache in this case so
	 *         the next call returns `fullRebuildRequired=true`.
	 */
	workbookSnapshotDelta(lastSeenVersion: Buffer): WorkbookSnapshotDeltaJson;

	// =====================================================================
	// Phase 5.7 V3.4.0.4a (2026-05-23) -- .qbook persistence (save side)
	// (load side is the {@link CollabSessionConstructor.fromQbook} factory).
	// =====================================================================

	/**
	 * Save this session to a `.qbook` directory at `path`.
	 *
	 * Atomic two-file write (workbook.toml + oplog.bin) via the Tier
	 * D3 envelope format.  The persistence helper requires a fully-
	 * rebuilt Workbook; the napi impl calls `rebuild_workbook` +
	 * `default_registry` internally (V3.4.0.4 plan note: engine-side
	 * Workbook materialization at save IS allowed even though
	 * IDE-side Workbook consumption stays V3.5+ scope).
	 *
	 * Throws engine errors with structured codes via parseQuantbookError:
	 * - `[session_oplog]` rebuild_workbook failure (replay or repair)
	 * - `[qbook_error]` persistence layer failure (I/O, schema)
	 */
	toQbook(path: string): void;

	// =====================================================================
	// Phase 5.7 V2.1 (2026-05-22) -- Transport surface (sync portion)
	// =====================================================================

	/**
	 * Attach a Transport to this session. The `transport` instance is
	 * CONSUMED -- subsequent calls with the same wrapper throw.
	 *
	 * Resets the session's per-transport VV baseline (Phase 5.5 V2 V3
	 * step 1 contract): the next flush sends from empty VV, delivering
	 * all local ops including any appended while no transport was
	 * attached. Loro's CRDT op log IS the implicit offline queue.
	 *
	 * @throws Error if `transport` has already been consumed.
	 */
	attachTransport(transport: TransportInstance): void;

	/**
	 * Detach the currently-attached transport. Returns `true` if one
	 * was attached (now released, its background tasks dropped),
	 * `false` if there was nothing to detach.
	 *
	 * V2.1 drops the returned `Box<dyn Transport>` Rust-side -- JS
	 * does not receive the prior transport.
	 */
	detachTransport(): boolean;

	/** `true` iff a transport is currently attached. */
	hasTransport(): boolean;

	/**
	 * Full-snapshot flush to the attached transport. Returns `true` if
	 * bytes were sent, `false` if no transport is attached.
	 *
	 * **Use the upcoming `flushDeltaToTransport` instead in production**
	 * once V2.2 ships -- delta flushes are O(per-op delta) vs O(full
	 * state).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushToTransport(): boolean;

	/**
	 * Drain inbound BLOBS from the attached transport (single-pass).
	 * Returns the count of BLOBS drained (NOT the count of ops),
	 * capped by the engine's default poll limit (`DEFAULT_POLL_REMOTE_LIMIT
	 * = 64`). Each blob is one snapshot/delta that may contain many ops;
	 * to count ops, compare `opCount()` before vs after.
	 *
	 * `0` if no transport is attached or no bytes were queued.
	 *
	 * **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: the prior
	 * docstring said "count of ops merged" which contradicted the
	 * engine's semantics (`poll_remote_with_limit` returns `merged <=
	 * max_blobs`). Mocha test "three-mutation chain across LoopbackPair"
	 * empirically discovered this and now pins the blob-count contract.
	 *
	 * @throws Error if the transport's `try_recv` or the merge step
	 *               returns an error.
	 */
	pollRemote(): number;

	// =====================================================================
	// Phase 5.7 V2.2 (2026-05-22) -- full sync Transport surface
	// =====================================================================

	/**
	 * Delta flush to the attached transport. Sends ONLY the ops added
	 * since the last successful flush. Returns `true` if bytes were
	 * actually sent.
	 *
	 * **Production default**. Prefer this over `flushToTransport`
	 * (full-snapshot) which is O(full state). Delta flushes are
	 * O(per-op delta).
	 *
	 * Idempotency: no state changed since last flush -> returns
	 * `false` without invoking `transport.send` (closes the V2 V2
	 * audit echo-loop concern).
	 *
	 * Per V2 V3 step 1: `attachTransport` resets the per-transport
	 * VV baseline, so the next `flushDeltaToTransport` after an attach
	 * sends from empty -- delivering ALL ops including any appended
	 * while offline (Loro's op log IS the implicit offline queue).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushDeltaToTransport(): boolean;

	/**
	 * Like `pollRemote` but with an explicit per-call cap on the
	 * number of blobs to drain. Returns the blob count, `<= limit`.
	 *
	 * Returned-count semantics:
	 * - `limit === 0` -> always returns 0 (no-op even if blobs queued).
	 * - Returned count `=== limit` -> more blobs may be queued; call again.
	 * - Returned count `< limit` -> queue drained.
	 *
	 * @param limit Non-negative integer in `[0, u32::MAX]`. NaN /
	 *              Infinity / fractional / negative throw.
	 *
	 * @throws Error if `limit` is invalid OR transport `try_recv` errors.
	 */
	pollRemoteWithLimit(limit: number): number;

	/**
	 * The attached transport's most recent error message, or `null` if
	 * no transport is attached OR the transport reports no error.
	 *
	 * **Use case**: after a mutator throws `Error("transport closed")`
	 * (or similar), call this to distinguish underlying causes (peer
	 * reset vs auth rejection vs capacity exceeded for V2.3+
	 * WebSocketTransport) and pick the reconnect strategy.
	 *
	 * **V2.2 audit-deferred caveat (Opus MEDIUM-3)**: error strings are
	 * lossy `Display` projections of the underlying enum. IDE callers
	 * today must substring-match to distinguish categories. V2.3+ will
	 * add structured discrimination via napi `Error.code`.
	 */
	transportLastError(): string | null;

	/**
	 * Set the auto-flush policy. Returns the prior policy as a string.
	 *
	 * Accepted: `'disabled'` (default) or `'onAppend'`. Other strings
	 * throw with a precise error.
	 *
	 * `'onAppend'` semantics (V2 V2 + V2 V3 steps 1+2): every public
	 * mutator auto-fires a delta flush after the mutation. Idempotency
	 * short-circuits no-op state changes; `pollRemote*` fires once
	 * after the batch (not per-blob).
	 *
	 * @throws Error on unknown policy string.
	 */
	setAutoFlushPolicy(policy: AutoFlushPolicy): AutoFlushPolicy;

	/**
	 * Read the current auto-flush policy. `'disabled'` is the default.
	 *
	 * **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: throws if the
	 * engine reports a variant unknown to this binding (forward-compat
	 * skew -- engine ships a new variant ahead of the binding crate
	 * being upgraded). Prior version returned `'unknown'` as a silent
	 * sentinel; per CLAUDE.md no-fallback rule that was wrong (JS
	 * `policy === 'onAppend'` would silently fall through to the
	 * `disabled` branch). Throwing surfaces the skew loudly and forces
	 * a binding upgrade.
	 *
	 * @throws Error if the engine variant is unknown to this binding.
	 */
	autoFlushPolicy(): AutoFlushPolicy;

	// =====================================================================
	// Phase 5.7 V2.5 (2026-05-22) -- async Transport surface, V8-BLOCK CLOSED
	// =====================================================================

	/**
	 * Async flush-pending. Waits for the attached transport's writer
	 * task to drain blobs queued AT THIS CALL (Codex M1 contract:
	 * target captured at handle extraction, NOT at wait-start).
	 *
	 * **V2.5 V8-block closure (2026-05-22)**: V2.4 reintroduced this
	 * soundly (closed V2.3 UB + tokio-starvation HIGHs via the
	 * `Arc<parking_lot::Mutex<...>>` refactor) BUT held the session
	 * lock during the Condvar wait -- Opus V2.4 HIGH-1 flagged the
	 * resulting V8-block UX hazard. V2.5 closes it: the binding now
	 * extracts a detached `FlushAck` handle while holding the session
	 * lock, drops the lock, then performs the Condvar wait without
	 * the session lock held. Concurrent JS sync method calls on the
	 * same session acquire the lock immediately -- the V8 event loop
	 * stays responsive.
	 *
	 * **V2.3 + V2.4 soundness retained**:
	 * - `&self`, not `&mut self`. napi-rs codegen produces shared `&`;
	 *   no aliasing UB possible.
	 * - `spawn_blocking` runs the wait on tokio's blocking pool, NOT
	 *   the worker pool. No runtime starvation.
	 *
	 * **Resolution / rejection contract** (V2.8 megaudit Codex Lane A
	 * MEDIUM-1 closure, 2026-05-22):
	 *
	 * Resolves when:
	 * - the writer has completed `send` for every blob queued AT THIS
	 *   CALL (V2.5 Codex M1: target captured at handle extraction);
	 * - there is no attached transport, OR the attached transport
	 *   returns `None` from `ack_handle()` (Loopback, Noop -- no
	 *   async-drain semantics; flush is synchronous-on-attach).
	 *
	 * Rejects with:
	 * - `parseQuantbookError(err).code === 'transport_closed'` if the
	 *   transport's closed flag is set on entry to the wait OR is
	 *   tripped while waiting. This is the correct reconnect signal.
	 * - `'transport_io'` for non-closed transport errors surfaced by
	 *   the underlying handle.
	 * - `'unknown'` (with `parseQuantbookError` walking the
	 *   `Error.cause` chain via V2.8 closure) if the `spawn_blocking`
	 *   task panics -- the wrapper Error has no bracket prefix, but
	 *   the cause does.
	 *
	 * @throws Error -- see the rejection contract above.
	 */
	flushPendingToTransport(): Promise<void>;
}

// ============================================================================
// Phase 5.7 V3.2.a (2026-05-22) -- cell-snapshot types for IDE grid widget
// ============================================================================

/**
 * Tagged-union mirror of the engine's `ql_oplog::CellWireValue`.
 *
 * Used inside {@link QuantbookCellSnapshot.entries[].value}. The
 * `kind` discriminator + `value` payload pattern matches the engine's
 * `serde_json` serialization at
 * `crates/ql-bindings-node/src/lib.rs::CollabSession::export_snapshot`.
 *
 * **Pending**: cell has a formula but no evaluated value yet
 * (recompute pending). V3.2.a binding does not emit formulas (V1
 * binding's only Op variant is `PutValue`), so `pending` is
 * structurally defined but not currently produced; V3.2.b+ will
 * surface it once formula support is added.
 */
export type QuantbookCellValue =
	| { kind: 'number'; value: number }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'text'; value: string }
	| { kind: 'error'; value: string }
	| { kind: 'pending' };

/**
 * Decoded shape of `CollabSession.exportSnapshot(sheet)` (V3.2.a).
 *
 * Use {@link exportCellSnapshot} in `./session` rather than parsing
 * by hand -- the helper handles JSON parsing + type narrowing.
 *
 * **snapshot_format_version = 1**: the engine pins this; future
 * changes must bump the version and the IDE must check it. Treat
 * any non-1 version as a binding-drift error.
 *
 * Entries are sorted by `(row, col)` ascending; virtualized grid
 * renderers can rely on this ordering for stable row-based slicing.
 */
export interface QuantbookCellSnapshot {
	readonly snapshot_format_version: 1;
	readonly sheet: number;
	readonly entries: ReadonlyArray<{
		readonly row: number;
		readonly col: number;
		readonly value: QuantbookCellValue;
		/**
		 * **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: engine-pre-rendered
		 * formatted string (mirrors {@link CellSnapshotJson.rendered}).
		 * `undefined` = no format-aware rendering available (see
		 * CellSnapshotJson.rendered docstring for the fallback cases).
		 * `buildHtml` consumers use this if present, fall back to
		 * `formatCellValue(value)` otherwise.
		 */
		readonly rendered?: string;
		/**
		 * **Phase 5.7 V3.6.0.6 D5 (2026-05-24)**: formula source text
		 * (mirrors {@link CellSnapshotJson.formula}).
		 *
		 * `undefined` = pure literal cell (no `Op::PutFormula` ever
		 * appended for this cell, or cleared via `Op::ClearFormula`).
		 *
		 * Present = the cell has formula text from `appendPutFormula`.
		 * Carries the engine's POST-REPAIR text (post Phase 5.3
		 * `repair_sheet_rename_chain` -- references to renamed sheets
		 * surface as the new sheet name).
		 *
		 * **Edit-flow contract** (V3.6.0.X audit-of-D4 OPUS-HIGH-2
		 * section G.2): `buildHtml` consumers MUST emit `data-raw-formula`
		 * when this field is set so click-to-edit's `beginEdit` shows
		 * formula source, NOT the cached literal value.
		 *
		 * `extractSheetSnapshot` (which produces this shape) only
		 * sets the property when the engine populates it; absent
		 * properties stay absent (deepStrictEqual shape-stability
		 * tests pin this).
		 */
		readonly formula?: string;
		/**
		 * **Phase 6.4-3d Step 5 (2026-05-29)**: a per-cell diagnostic MESSAGE
		 * (e.g. `"no Python worker is configured for this session"` or
		 * `"ValueError: boom"`), sourced from `Event::CellDiagnostic` via
		 * {@link SessionInstance.pollEvents} and merged onto error-valued cells
		 * by `attachCellDiagnostics` (in `cellGrid/cellGridLogic`). `undefined`
		 * for the common case (no diagnostic / non-error cell). `buildHtml`'s
		 * `renderRows` surfaces it as a `title=` tooltip while KEEPING the
		 * `#CALC!`/`#TIMEOUT!` text -- so a failed UDF explains WHY on hover.
		 *
		 * NOT produced by `extractSheetSnapshot` (the snapshot carries values,
		 * not events); the conditional-key discipline (absent when unset) keeps
		 * the existing shape-stability `deepStrictEqual` tests intact.
		 */
		readonly diagnostic?: string;
	}>;
}

// ============================================================================
// Phase 5.7 V2.6 (2026-05-22) -- BlockingTransportFixture (test fixture)
// ============================================================================

/**
 * V2.6 test fixture for V2.5 contract testing. Wraps the engine-side
 * `BlockingTransport` (feature-gated behind `test-fixtures` on ql-collab).
 *
 * **NOT for production use** -- the underlying transport blocks
 * `flush_pending` indefinitely until `release()` is called (or the
 * constructor's `blockMs` upper bound elapses). Production callers
 * would deadlock.
 *
 * Mirrors V2.1 `LoopbackPair`'s single-use take pattern: construct
 * the fixture, call `takeTransport()` once to obtain a `Transport`
 * for `attachTransport(t)`, then drive `release()` + `waitUntilBlocked()`
 * from test code.
 */
export interface BlockingTransportFixtureInstance {
	/**
	 * Take ownership of the inner `BlockingTransport`, wrapped in a
	 * `Transport` instance attachable to a `CollabSession`.
	 *
	 * Single-use: errors on the second call. The fixture controller
	 * retains its `release` + `blocked` Condvars after the take so
	 * `release()` + `waitUntilBlocked()` can drive the transport
	 * that now lives inside a `CollabSession`.
	 *
	 * @throws Error on the second call.
	 */
	takeTransport(): TransportInstance;

	/**
	 * Flip the release Condvar so any in-progress `flush_pending`
	 * or `wait_for_drain` exits. Idempotent (calling twice is safe).
	 */
	release(): void;

	/**
	 * Async wait until the fixture's wait routine has actually
	 * entered the Condvar wait (engine-side `wait_blocked` set the
	 * `blocked` flag + notified).
	 *
	 * **Codex M3 fix (2026-05-22)**: deterministic synchronization
	 * point for V2.5 contract tests. Without it, an `opCount()` call
	 * during a pending `flushPendingToTransport` could race ahead of
	 * the `spawn_blocking` task and pass vacuously.
	 */
	waitUntilBlocked(): Promise<void>;
}

export interface BlockingTransportFixtureConstructor {
	/**
	 * Construct a fresh `BlockingTransportFixture`.
	 *
	 * @param blockMs Upper-bound wait duration in milliseconds. Must be
	 *                a finite integer in `[1, u32::MAX]` (strictly
	 *                positive). `0` is REJECTED at the napi boundary
	 *                with a `[bad_argument]` error (V2.5 audit closure
	 *                Codex MEDIUM-1: zero would allow indefinite
	 *                blocking from JS -- bounded self-DoS footgun).
	 *                The engine-side `BlockingTransport::new(0, ...)`
	 *                remains for Rust unit tests that explicitly want
	 *                the indefinite-wait path; the napi fixture caps
	 *                the surface to `[1, u32::MAX]`.
	 * @throws Error with code `'bad_argument'` if `blockMs` is `0`,
	 *               non-finite, negative, fractional, or out-of-u32.
	 */
	new(blockMs: number): BlockingTransportFixtureInstance;
}

/**
 * Auto-flush policy string union. Mirrors `ql_collab::AutoFlushPolicy`
 * (Rust enum), bound as JS strings via the napi
 * `setAutoFlushPolicy` / `autoFlushPolicy` methods.
 *
 * - `'disabled'`: explicit-drive (V2 V1 behavior). Caller invokes
 *   `flushDeltaToTransport` + `pollRemote*` on a tick.
 * - `'onAppend'`: every mutator + `pollRemote*` auto-fires a delta
 *   flush.
 *
 * The engine's underlying enum is `#[non_exhaustive]`. Future variants
 * require this union to be widened AND the napi binding's
 * `parse_auto_flush_policy` + `auto_flush_policy_to_string` helpers to
 * be updated. Until both layers are upgraded, `autoFlushPolicy()`
 * throws on the new variant (V2.2 closure of Opus HIGH-1: no
 * silent-sentinel fall-through).
 */
export type AutoFlushPolicy = 'disabled' | 'onAppend';

export interface CollabSessionConstructor {
	new(peerId: bigint): CollabSessionInstance;

	/** Reconstruct a session from a previously-exported snapshot. */
	fromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance;

	/**
	 * **Phase 5.7 V3.4.0.4a (2026-05-23) -- load a session from a
	 * `.qbook` directory at `path`.**
	 *
	 * `peerIdOverride` MUST be a fresh / stored-previously BigInt
	 * peer-id.  V3.4.0.4a engine layer is peer-id-agnostic;
	 * V3.4.0.4b IDE commands generate UUID-derived BigInts via
	 * `crypto.randomUUID()` for cross-restart collision-resistance
	 * (closes R-V3.3-5 / V3.4.0.1 D5).
	 *
	 * Throws engine errors with structured codes via parseQuantbookError:
	 * - `[bad_argument]` peerIdOverride zero / negative / exceeds u64
	 * - `[qbook_error]` workbook.toml missing/malformed/schema mismatch
	 * - `[qbook_unsupported_version]` / `[qbook_truncated_header]`
	 *    oplog.bin Tier D3 header issues
	 * - `[session_oplog]` Loro snapshot decode failure
	 */
	fromQbook(path: string, peerIdOverride: bigint): CollabSessionInstance;
}

// =====================================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding type declarations
// =====================================================================

/**
 * Opaque wrapper for a `Box<dyn ql_collab::Transport + Send>`.
 *
 * **Single-use semantics**: an instance owns its boxed trait object.
 * `CollabSession.attachTransport(t)` MOVES the box out, leaving the
 * wrapper consumed. After consumption, `isAttachable()` returns
 * `false` and subsequent `attachTransport` calls with the same
 * wrapper throw.
 *
 * Instances are obtained from factory classes (V2.1: `LoopbackPair`;
 * V2.3+: `Transport.websocketConnect(url)`).
 */
export interface TransportInstance {
	/**
	 * `true` while this wrapper still owns its inner transport.
	 * `false` after passing to `attachTransport` (or any other
	 * future API that consumes the wrapper).
	 *
	 * Useful for branching without exception handling:
	 * ```ts
	 * if (transport.isAttachable()) {
	 *   session.attachTransport(transport);
	 * }
	 * ```
	 */
	isAttachable(): boolean;
}

/**
 * Two-ended in-process Transport pair (`LoopbackTransport`).
 *
 * **V2.1 entry point** for obtaining paired Transport instances. The
 * pair's two ends share an in-process queue: bytes sent on end A
 * arrive at end B's `try_recv` and vice versa.
 *
 * Each end can be `take`-n once. Calling `takeA` (or `takeB`) a
 * second time on the same pair throws. The two takes are
 * independent (taking A doesn't affect taking B).
 */
export interface LoopbackPairInstance {
	/**
	 * Take ownership of end A. Each `LoopbackPair` instance can have
	 * `takeA` called once.
	 * @throws Error on the second call.
	 */
	takeA(): TransportInstance;

	/**
	 * Take ownership of end B. Each `LoopbackPair` instance can have
	 * `takeB` called once.
	 * @throws Error on the second call.
	 */
	takeB(): TransportInstance;
}

export interface LoopbackPairConstructor {
	new(): LoopbackPairInstance;
}

// ============================================================================
// Phase 6.1B inc.2d (2026-05-28) -- the owning `WorkbookSession` over napi.
//
// `Session` is the single-engine OWNING session (`ql_exec::WorkbookSession`),
// the product-neutral surface 6.1+ bindings build against -- distinct from
// `CollabSession` (the CRDT collab facade, v1.5). It exposes the
// edit -> recalc -> snapshot loop directly. Source of truth: the Rust crate
// `crates/ql-bindings-node/src/lib.rs` (the `Session` `#[napi]` class).
//
// Contract gaps surfaced by this migration (tracked for 6.1C): unlike
// `CollabSession`, `Session` exposes NO `workbookSnapshotDelta`, transport,
// presence, merge, or undo over napi yet -- only full `snapshot()`. The live
// `CellGridPanel` delta/presence/transport render path therefore cannot be
// driven by `Session` until those land (a later increment / 6.3).
// ============================================================================

/**
 * One sheet's identity in {@link SessionInstance.listSheets}. Mirrors the
 * engine `SheetInfoJson` (`{ id, name }`) -- RICHER than
 * `CollabSession.listSheets()`, which returns bare `number[]` ids.
 */
export interface SheetInfoJson {
	id: number;
	name: string;
}

/**
 * Value argument to {@link SessionInstance.setValue}. Mirrors the engine
 * `CellValueJson` INPUT shape (a flat struct discriminated by `kind`), with
 * `'blank'` ADDED (blank clears the cell's value). The snapshot-OUTPUT
 * {@link CellValueJson} never carries `'blank'` -- blanks are simply absent.
 * Unknown `kind` is rejected fail-loud by the engine (`[bad_argument]`).
 */
export interface SessionCellValueInput {
	kind: 'number' | 'boolean' | 'text' | 'blank';
	number?: number;
	boolean?: boolean;
	text?: string;
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: config for the out-of-process Python-UDF
 * worker the IDE injects via {@link SessionInstance.setUdfWorker}. Mirrors the
 * engine `PythonWorkerConfigJson` (napi object; optional fields are OMITTED, NOT
 * `null`/`undefined`-valued -- napi-rs rejects an explicit `null`). The IDE
 * resolves these from trusted-workspace config (the `quantlab.pythonPath`
 * cascade + the workspace UDF dir); see `udfWorker.ts`.
 */
export interface PythonWorkerConfigJson {
	/** Absolute path to the Python interpreter to launch (required). */
	python: string;
	/** `-m` module that runs the worker loop. Defaults to `"quantbook.worker"`. */
	module?: string;
	/**
	 * Directories prepended to `PYTHONPATH` (the worker module + `quantbook`
	 * package must resolve). Typically the engine's `quantbook-py/python` plus
	 * the workspace UDF dir.
	 */
	pythonpath?: string[];
	/** Trusted user module the worker imports to register UDFs by handle. */
	udfModule?: string;
	/** Handshake timeout in ms (HELLO_ACK wait). Engine default 5000; capped at 600000. */
	handshakeTimeoutMs?: number;
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: severity of a {@link DiagnosticJson}.
 * Mirrors the engine `Severity` (`snake_case` serde).
 */
export type DiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: a cell address as carried by an
 * {@link EventJson} / {@link DiagnosticJson}. Mirrors the engine `CellAddrJson`
 * (`sheet` widened u16->u32; `row`/`col` 0-indexed). Distinct from the
 * snapshot's per-cell `{ row, col }` (which omits `sheet`).
 */
export interface CellAddrJson {
	sheet: number;
	row: number;
	col: number;
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: a per-cell diagnostic. Mirrors the
 * engine `DiagnosticJson` (contract section 9). `addr` is absent for a workbook-level
 * diagnostic. For UDFs the `code` is one of `udf_no_worker` / `udf_raised` /
 * `udf_timeout` / `udf_worker_died` / `udf_cancelled` / `udf_handshake` /
 * `udf_protocol` / `udf_codec`; `message` carries the human-readable reason
 * (e.g. `"ValueError: boom"` for a raised UDF).
 */
export interface DiagnosticJson {
	addr?: CellAddrJson;
	severity: DiagnosticSeverity;
	code: string;
	message: string;
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: an operation's terminal/running state
 * carried by an `operation_completed` {@link EventJson}. Mirrors the engine
 * `OperationStateJson`. `error` is the `[code] message` display ONLY when
 * `state === 'failed'` (parse via {@link parseQuantbookError}).
 */
export interface OperationStateJson {
	state: 'running' | 'completed' | 'canceled' | 'failed';
	error?: string;
}

/**
 * **Phase 6.3-2a (2026-05-30)**: the session lifecycle state (contract section 2.3),
 * the wire string returned by {@link SessionInstance.lifecycleState}. `busy` means
 * a long op owns mutable state (mutating/recalc rejected; reads + cancel legal);
 * `closed`/`faulted` are terminal.
 */
export type QuantbookLifecycleState = 'new' | 'ready' | 'busy' | 'closed' | 'faulted';

/**
 * **Phase 6.3-2a (2026-05-30)**: a rectangular range within one sheet (mirrors
 * the engine `CellRangeJson`). All five coordinates are 0-indexed; bounds are
 * inclusive. Input to {@link SessionInstance.queryRange}.
 */
export interface CellRangeJson {
	sheet: number;
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

/**
 * **Phase 6.3-2a (2026-05-30)**: which extras a `queryRange` read includes
 * (mirrors the engine `RangeQueryOptionsJson`). In v1 every field MUST be
 * `false` -- the engine fail-loud rejects a `true` with
 * `[not_implemented_in_v1_core]` (only the columnar value read is the v1 surface).
 */
export interface RangeQueryOptionsJson {
	includeFormulas: boolean;
	includeFormats: boolean;
	includeRendered: boolean;
}

/**
 * **Phase 6.3-2a (2026-05-30)**: one column of a {@link RangeResultJson}
 * (columnar layout; mirrors the engine `RangeColumnJson`). `values` is
 * top-to-bottom with length `RangeResultJson.nRows`; each entry is the
 * discriminated {@link CellValueJson} (incl. `blank` / `pending`).
 */
export interface RangeColumnJson {
	values: CellValueJson[];
}

/**
 * **Phase 6.3-2a (2026-05-30)**: a batch-shaped columnar range read (mirrors the
 * engine `RangeResultJson`). `columns` has length `nCols`; each column has length
 * `nRows`. Carries `schemaVersion` (contract section 4.1 / section 4b field-parity)
 * -- the IDE asserts it at ingest. Returned by {@link SessionInstance.queryRange}.
 */
export interface RangeResultJson {
	schemaVersion?: number;
	range: CellRangeJson;
	nRows: number;
	nCols: number;
	columns: RangeColumnJson[];
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: one structured event drained from the
 * session's event ring (contract section 9). Mirrors the engine `EventJson`: a tagged
 * union keyed by `kind`; only that variant's payload fields are populated.
 * - `'recalc_progress'`: `op`, `done`, `total`
 * - `'cell_diagnostic'`: `diagnostic`
 * - `'operation_completed'`: `op`, `state`
 * - `'provenance'`: `addr`, `source`
 * - `'structure_changed'`: `structureKind`, `target`
 * - `'full_resync_required'`: (no payload -- reseed via `snapshot()`)
 *
 * `op`/`done`/`total` are engine `u64` ids surfaced as JS `bigint` (napi BigInt).
 */
export interface EventJson {
	kind:
	| 'recalc_progress'
	| 'cell_diagnostic'
	| 'operation_completed'
	| 'provenance'
	| 'structure_changed'
	| 'full_resync_required';
	op?: bigint;
	done?: bigint;
	total?: bigint;
	diagnostic?: DiagnosticJson;
	state?: OperationStateJson;
	addr?: CellAddrJson;
	source?: string;
	structureKind?: string;
	target?: string;
}

/**
 * **Phase 6.4-3d Step 5 (2026-05-29)**: a page of events read from a cursor.
 * Mirrors the engine `EventPageJson`. Reading does NOT drain the ring; pass
 * `nextCursor` to the next {@link SessionInstance.pollEvents} call. `dropped`
 * pairs with a `full_resync_required` event (consumer fell behind -- reseed via
 * `snapshot()`; v1's ring is unbounded so this never fires yet).
 */
export interface EventPageJson {
	events: EventJson[];
	nextCursor: bigint;
	dropped: boolean;
}

/**
 * The owning `WorkbookSession` napi class (Phase 6.1B inc.2d). Wraps
 * `Arc<Mutex<ql_exec::WorkbookSession>>`; single-writer; the product-neutral
 * session contract from the 6.1 decision-lock. Engine errors surface as JS
 * `Error` with a `"[code] message"` body (parse via {@link parseQuantbookError}).
 */
export interface SessionInstance {
	/**
	 * Append a sheet; returns the new SheetId. (Note: `CollabSession.addSheet`
	 * returns `void` -- this returned id is a surfaced shape difference.)
	 * @param chunkRows storage chunk height (>= 1).
	 */
	addSheet(name: string, chunkRows: number): number;

	/**
	 * Set a cell's value. `kind:'blank'` clears the value. Unknown `kind`
	 * throws `[bad_argument]` (No-Fallbacks).
	 */
	setValue(sheet: number, row: number, col: number, value: SessionCellValueInput): void;

	/**
	 * Set a cell's formula. `text` is the formula BODY with NO leading `=`
	 * (engine/op-log convention; the engine canonicalizes e.g. `"A1+1"` ->
	 * `"A1 + 1"`). Mirrors `CollabSession.appendPutFormula`.
	 */
	setFormula(sheet: number, row: number, col: number, text: string): void;

	/**
	 * Convert-to-literal: remove the cell's FORMULA but PRESERVE its last
	 * computed value (inc.2c-6 contract). To also clear the value, call
	 * `setValue(..., { kind: 'blank' })`.
	 */
	clear(sheet: number, row: number, col: number): void;

	/** Recompute only dirty cells; returns the operation id. */
	recalcDirty(): bigint;

	/** Recompute the whole workbook; returns the operation id. */
	recalcAll(): bigint;

	/**
	 * **Phase 6.3-1b/6.3-1c (2026-05-30):** reserve an incremental (dirty-set)
	 * recalc WITHOUT running it; returns the operation id. Opens a pre-start
	 * cancel window -- call {@link cancel} with this id before {@link awaitRecalc}
	 * to prevent the run (contract section 6.4). You MUST then call `awaitRecalc`
	 * (even after a `cancel`) to run-or-skip the recompute and release the session
	 * from `Busy`. For the common no-cancel path prefer {@link recalcDirty}.
	 */
	startRecalcDirty(): bigint;

	/** Reserve a full recalc WITHOUT running it; see {@link startRecalcDirty}. */
	startRecalcAll(): bigint;

	/**
	 * Run (or skip) the recalc reserved by `startRecalcDirty` / `startRecalcAll`.
	 * If a {@link cancel} won the pre-start window the recompute is SKIPPED (the
	 * op surfaces `canceled` via {@link operationStatus}); otherwise it runs to
	 * `completed` / `failed`. Throws `[bad_argument]` if `op` is not the in-flight
	 * recalc, `[invalid_state]` if the session went terminal mid-window.
	 */
	awaitRecalc(op: bigint): void;

	/**
	 * Cancel an operation by id. Returns `true` if it was `running` and is now
	 * `canceled`, `false` if already terminal. For in-engine recalc this is
	 * honored only in the pre-start window (before `awaitRecalc` begins the
	 * synchronous pass -- contract section 6.4). Throws `[operation_not_found]`
	 * for an unknown id.
	 */
	cancel(op: bigint): boolean;

	/**
	 * **Phase 6.3-1c (2026-05-30):** read an operation's state by id. This is how
	 * the `startRecalc*` / `awaitRecalc` + `cancel` outcome is observed: after
	 * `awaitRecalc(op)` the op is `completed` (or `canceled` if a cancel won the
	 * window, or `failed` with the engine error string). Legal while `Busy`.
	 */
	operationStatus(op: bigint): OperationStateJson;

	/** Full workbook snapshot (sheets + formats + dateSystem + opaque version). */
	snapshot(): WorkbookSnapshotJson;

	/** Single-cell read; `null` when the cell is absent. */
	cell(sheet: number, row: number, col: number): CellSnapshotJson | null;

	/** Live (non-tombstoned) sheets, each as `{ id, name }`. */
	listSheets(): SheetInfoJson[];

	// --- Phase 6.3-2a (2026-05-30): read / lifecycle / format / validate ---

	/**
	 * Current lifecycle state as a wire string (contract section 2.3). Infallible
	 * -- legal in every state including the terminal ones; this is the only read
	 * that works on a `faulted` / `closed` session.
	 */
	lifecycleState(): QuantbookLifecycleState;

	/**
	 * Parse + bind a formula WITHOUT mutating (the keystroke-validation path).
	 * Returns diagnostics as DATA -- a malformed formula yields a non-empty
	 * `DiagnosticJson[]`, NOT a thrown error; an empty array means valid. `text`
	 * is the formula BODY with no leading `=` (engine convention).
	 */
	validateFormula(sheet: number, row: number, col: number, text: string): DiagnosticJson[];

	/**
	 * Batch-shaped columnar range read (contract section 3.6). Returns a
	 * {@link RangeResultJson} (`nRows` x `nCols`, column-major: `columns` has
	 * length `nCols`, each `column.values` has length `nRows`). In v1 every
	 * `include*` option MUST be `false` -- a `true` is rejected loud with
	 * `[not_implemented_in_v1_core]`. `[bad_argument]` for an invalid range.
	 */
	queryRange(range: CellRangeJson, options: RangeQueryOptionsJson): RangeResultJson;

	/** Mark every volatile function dirty (so the next recalc recomputes them). */
	markVolatilesDirty(): void;

	/**
	 * Set a cell's format to a registered {@link FormatIdJson} (a builtin index or
	 * a session-custom id from {@link registerFormat}). `[bad_argument]` for
	 * invalid coords / a malformed format id; `[not_found]` for an unknown custom id.
	 */
	setFormat(sheet: number, row: number, col: number, formatId: FormatIdJson): void;

	/**
	 * Register a session-wide custom number format, returning its
	 * {@link FormatIdJson} for use with {@link setFormat}. The engine may dedup a
	 * well-known string to a builtin index. `[bad_argument]` for an invalid string.
	 */
	registerFormat(formatString: string): FormatIdJson;

	/**
	 * **Phase 6.4-3d Step 5**: attach an out-of-process Python-UDF worker built
	 * from `config`. The worker is spawned + handshaked EAGERLY (fail-loud), so
	 * a missing interpreter / protocol mismatch surfaces NOW (`[worker_spawn_failed]`
	 * / `[worker_handshake]`), not later as a silent `#CALC!`. After injecting,
	 * call {@link recalcAll} so existing UDF cells pick up the worker
	 * (`recalcDirty` will NOT heal an already-computed `#CALC!`). Re-calling
	 * REPLACES the worker (the prior child is killed).
	 *
	 * **SYNCHRONOUS + BLOCKING**: this is a synchronous napi method that blocks
	 * the calling thread up to the handshake timeout. The IDE MUST NOT call it on
	 * the UI/keystroke path -- go through the async `injectUdfWorker` helper
	 * (`udfWorker.ts`), which also enforces the workspace-trust gate.
	 *
	 * Errors: `[worker_spawn_failed]` / `[worker_handshake]` / `[bad_argument]`
	 * (bad `handshakeTimeoutMs`) / `[invalid_state]` (session not Ready) /
	 * `[session_busy]`.
	 */
	setUdfWorker(config: PythonWorkerConfigJson): void;

	/**
	 * **Phase 6.4-3d Step 5**: drain a page of structured events from the
	 * session's event ring (contract section 9) starting at `cursor` (`0n` reads from
	 * the start; pass the returned `nextCursor` each subsequent call). Reading
	 * does NOT drain the ring. The IDE consumes this to surface `cell_diagnostic`
	 * events (the UDF no-worker/raised/timeout/died sink) as cell tooltips. A
	 * negative/lossy cursor is rejected `[bad_argument]`.
	 */
	pollEvents(cursor: bigint): EventPageJson;

	// --- Phase 6.3-2b (2026-05-30): persistence ---

	/**
	 * Open a `.qbook` workbook from `path` (New -> Ready). The engine re-mints the
	 * epoch (any prior delta token full-rebuilds) and recomputes on load. A missing
	 * file / bad envelope / corrupt op-log sidecar throws a structured
	 * `[persistence]` error (No-Fallbacks); `[invalid_state]` off an openable state.
	 */
	open(path: string): void;

	/**
	 * Import a workbook from in-memory `bytes` in `format` -- v1 supports `'xlsx'`
	 * (recomputed best-effort on import) and `'csv'` (no formulas). Any other format
	 * throws `[bad_argument]`; malformed bytes throw `[persistence]`. Adopts the
	 * imported workbook as a fresh session (epoch re-minted).
	 */
	import(bytes: Uint8Array, format: string): void;

	/**
	 * Save the live workbook + this session's op-log to a `.qbook` directory at
	 * `path` (atomic rename). The workbook name is derived from the path's file
	 * stem -- a path with no stem throws `[bad_argument]`. `[invalid_state]` off a
	 * readable state; I/O / serialization failures throw `[persistence]`.
	 */
	save(path: string): void;

	/**
	 * Export the live workbook to bytes in `format` -- v1 supports `'csv'` (single
	 * live sheet; more than one throws `[bad_argument]`) and `'xlsx'` (whole
	 * workbook, only when the engine is built with the `xlsx-write` feature;
	 * otherwise the honest `[not_implemented_in_v1_core]`). Any other format throws
	 * `[bad_argument]`.
	 */
	export(format: string): Uint8Array;
}

export interface SessionConstructor {
	/** Construct an empty owning workbook session. */
	new(): SessionInstance;
}

/**
 * Top-level exports from the native `.dylib` / `.so` / `.dll`. Loaded
 * via {@link loadQuantbookEngine} in `./loader`.
 */
export interface QuantbookNativeModule {
	/** Smoke method exposing the binding crate's own version. */
	version(): string;

	/** Session class -- see {@link CollabSessionInstance}. */
	readonly CollabSession: CollabSessionConstructor;

	/**
	 * Phase 6.1B inc.2d: the owning `WorkbookSession` over napi -- the
	 * product-neutral single-writer session. See {@link SessionInstance}.
	 * Distinct from `CollabSession` (the collab facade). Additive over the
	 * V1+ surface; the loader validates its presence (fail-at-boundary).
	 */
	readonly Session: SessionConstructor;

	/**
	 * V2.1: opaque Transport wrapper. JS-side this is mostly used
	 * as a parameter type to `CollabSession.attachTransport`.
	 * The constructor is NOT directly exposed -- obtain instances
	 * via factories like `LoopbackPair`.
	 *
	 * **V2.3 (2026-05-22)**: added `websocketConnect(url)` static
	 * async factory that resolves with a Transport wrapping a
	 * `WebSocketTransport`. See `flushPendingToTransport` for the
	 * matching async drain helper.
	 */
	readonly Transport: {
		prototype: TransportInstance;
		/**
		 * Async factory: connect to a WebSocket peer and return a
		 * Transport wrapping the live connection.
		 *
		 * @param url `ws://host:port` URL. No TLS in V2.3.
		 * @returns Promise resolving with the Transport (single-use;
		 *          pass to `attachTransport` once).
		 * @throws  Error with WebSocket failure category in the
		 *          message (`WebSocket connection failed`,
		 *          `WebSocket handshake failed`, `invalid WebSocket URL`).
		 */
		websocketConnect(url: string): Promise<TransportInstance>;
	};

	/**
	 * V2.1: LoopbackPair class -- factory for paired in-process
	 * Transport ends.
	 */
	readonly LoopbackPair: LoopbackPairConstructor;

	/**
	 * V2.6 (2026-05-22): BlockingTransportFixture class -- test
	 * fixture for V2.5 V8-block contract testing. See
	 * {@link BlockingTransportFixtureInstance}.
	 *
	 * **NOT for production code** -- the underlying transport blocks
	 * `flush_pending` indefinitely until released.
	 *
	 * **V2.8 megaudit closure (Opus-B Lane C HIGH-1 + Lane A LOW-1
	 * convergent, 2026-05-22)**: this constructor is now OPTIONAL on
	 * the loaded module. Production cdylib builds (built without
	 * `--features test-fixtures` on `ql-bindings-node`) do NOT carry
	 * `BlockingTransportFixture` -- eliminating the self-DoS surface
	 * where in-process JS could park tokio blocking-pool threads for
	 * u32::MAX milliseconds via `attachTransport(fixture.takeTransport())`.
	 * Mocha + contention contract tests MUST rebuild the cdylib with
	 * `cargo build -p ql-bindings-node --release --features test-fixtures`
	 * and check `if (engine.BlockingTransportFixture) { ... }` before
	 * use. Production runtime code MUST NOT touch this constructor.
	 */
	readonly BlockingTransportFixture?: BlockingTransportFixtureConstructor;
}

// ============================================================================
// Phase 5.7 V2.7 (2026-05-22) -- structured error-code discrimination
// ============================================================================

/**
 * Stable string identifier for an engine error variant, extracted from
 * the bracketed prefix that the napi binding prepends to thrown
 * `Error.message`. IDE reconnect logic can switch on these codes
 * without substring-matching the human-readable `Display` text.
 *
 * **Codes are SemVer-stable.** Engine-side
 * `crates/ql-collab/src/transport.rs::TransportError::kind`,
 * `crates/ql-collab-ws/src/lib.rs::WebSocketError::kind`, and
 * `crates/ql-collab/src/session.rs::CollabSessionError::kind` are
 * the authoritative sources; this union mirrors them.
 *
 * **Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards**: prior to
 * V2.7, IDE callers had to substring-match error messages to
 * distinguish transport-closed from transport-io etc. This was
 * lossy and fragile across Display-string edits.
 */
export type QuantbookErrorCode =
	// Transport-layer errors (`TransportError::kind`)
	| 'transport_io'
	| 'transport_closed'
	// WebSocket-layer errors (`WebSocketError::kind`).
	// Surfaced by `Transport.websocketConnect` on rejection.
	//
	// **V2.7 audit note (Codex LOW-1 + Opus LOW-3)**: today's only
	// reachable websocket codes via napi rejection paths are
	// invalid_url, connect_failed, handshake_failed. The
	// `websocket_runtime_error` code is structurally defined for
	// when V2 backlog adds a structured `transportLastError()`
	// accessor that produces the prefix; today, runtime task
	// failures surface as raw strings via the unstructured
	// `transportLastError()` method (no prefix). Reachability
	// boundary documented at engine `WebSocketTransport::last_error`.
	| 'websocket_invalid_url'
	| 'websocket_connect_failed'
	| 'websocket_handshake_failed'
	| 'websocket_runtime_error'
	// Session-layer errors (`CollabSessionError::kind`).
	// Note: `Transport(_)` passes through to the inner transport
	// kind (e.g. `transport_closed`), not a wrapper string. IDE
	// callers branching on transport state get the same code
	// whether the path was direct Transport call or wrapped via
	// session method (see Opus V2.7 MEDIUM-3 for the contractual
	// trade-off + documented passthrough rationale).
	| 'session_oplog'
	| 'session_presence'
	| 'session_undo'
	| 'session_replay'
	// **V3.4.0.4a (2026-05-23)**: persistence-layer errors emitted by
	// the napi `toQbook` / `fromQbook` wrappers via
	// `persistence_error_to_napi`.  The PersistenceError enum is
	// `#[non_exhaustive]` so a `qbook_unknown` sentinel covers future
	// variants until this list is extended.
	| 'qbook_error'
	| 'qbook_unsupported_version'
	| 'qbook_truncated_header'
	| 'qbook_unknown'
	// **V2.7 audit closure (Opus MEDIUM-2, 2026-05-22)**: napi-layer
	// argument validation + single-use violation errors that are
	// NOT engine error types (peerId range check, blockMs > 0,
	// LoopbackPair takeA/B exhaustion, Transport wrapper consumed,
	// AutoFlushPolicy parse, validate_u32_index for direct callers).
	// V2.7 ship surfaced these as raw `Error::from_reason("...")`
	// strings (no prefix), silently bucketing under `'unknown'` and
	// re-opening V2.1+V2.2+V2.3 MEDIUM-3 at the binding boundary.
	// Closure: all such errors now carry the `[bad_argument]` prefix
	// per the napi binding's `bad_argument_error_to_napi` helper.
	| 'bad_argument'
	// **Phase 6.4-2 (2026-05-28)**: function-registration codes emitted
	// by the new `Session.registerFunction` / `unregisterFunction` napi
	// methods, mapped from `FunctionRegistryError` via the engine's
	// `map_function_registry_err` (Appendix A `function_exists` /
	// `function_not_found`). `function_exists` surfaces for BOTH
	// duplicate UDF registration AND attempts to register/unregister
	// against a built-in's name (the registry's builtin-guard refuses
	// removal; the `Conflict` variant is shared with the
	// duplicate-register case -- the message disambiguates).
	// `function_not_found` surfaces only for `unregisterFunction` on
	// an unknown canonical name (never the silent no-op per
	// No-Fallbacks).
	| 'function_exists'
	| 'function_not_found'
	// **Phase 6.4-3d Step 5 (2026-05-29)**: Python-UDF worker codes.
	// `worker_spawn_failed` / `worker_handshake` are emitted by the engine's
	// `Session.setUdfWorker` napi method (`udf_spawn_error_to_napi`) when the
	// interpreter can't be launched / the worker dies during startup, or reports
	// an incompatible protocol version. `worker_untrusted_workspace` is an
	// IDE-ONLY code (never emitted by the engine -- the engine has no workspace
	// concept): the `injectUdfWorker` helper throws it when the workspace is not
	// trusted, refusing to spawn arbitrary workspace Python.
	| 'worker_spawn_failed'
	| 'worker_handshake'
	| 'worker_untrusted_workspace'
	// **Phase 6.4-3d Step 5**: lifecycle codes now reachable via `setUdfWorker`
	// (the lifecycle-gated `set_udf_worker_checked`) -- and shared with the other
	// gated mutators. `invalid_state` = the session is not Ready (New/Closed/
	// Faulted); `session_busy` = a long operation is in progress. Pre-existing
	// engine codes (`EngineError::invalid_state` / `session_busy`) that the IDE
	// allowlist had not yet enumerated (6.4-2 gap closed here).
	| 'invalid_state'
	| 'session_busy'
	// **Phase 6.3-1d (2026-05-30)**: the COMPLETE set of `EngineError` codes the
	// engine emits over the napi `Session` surface. `engine_error_to_napi`
	// (`crates/ql-bindings-node/src/lib.rs::engine_error_to_napi`) forwards
	// `EngineError`'s stable `code` VERBATIM as the `[code]` prefix
	// (`EngineError::Display`, `crates/ql-session/src/error.rs`), so every code the
	// engine can construct reaches `parseQuantbookError`. Phase 6.3-2 binds the
	// remaining 32 `Session` methods (structure / table / transaction /
	// import-export / version-token / undo-redo), all of which emit codes from
	// these families; recognizing them all NOW (before 6.3-2) keeps engine errors
	// from silently bucketing under `'unknown'` (the V2.7/V2.9 structured-error
	// contract). Codes are SemVer-stable (`error.rs` doc). Enumerated against engine
	// ground truth (60 `EngineError` codes; 9 were already listed above).
	//
	// NOTE: the per-cell UDF DIAGNOSTIC codes (`udf_no_worker` / `udf_raised` /
	// `udf_timeout` / `udf_worker_died` / `udf_cancelled` / `udf_handshake` /
	// `udf_protocol` / `udf_codec`, from `crates/ql-exec/src/scalar.rs`) are
	// DELIBERATELY NOT here -- they travel on a different channel
	// (`DiagnosticJson.code: string` via `Event::CellDiagnostic`), not as thrown
	// `[code]`-prefixed errors parsed by `parseQuantbookError`.
	//
	// Formula / compute (`map_runtime_err`, `session.rs`: Lex/Parse/Print -> parse,
	// Bind -> bind). A formula that *evaluates* to an error is a `CellValue::Error`,
	// not one of these; these are structural lex/parse/bind failures of the text.
	| 'formula_parse'
	| 'formula_bind'
	// Cell coordinate (`map_runtime_err` `InvalidCell`).
	| 'bad_cell'
	// Sheet structure (`map_runtime_err`: `InvalidSheet` -> not_found; `SheetName`
	// Duplicate -> duplicate, else bad_sheet_name; `TooManySheets`) + the
	// `delete_sheet` "already deleted / not deletable" guard (`sheet_not_deleted`).
	| 'sheet_not_found'
	| 'sheet_name_duplicate'
	| 'bad_sheet_name'
	| 'too_many_sheets'
	| 'sheet_not_deleted'
	// Chunk-rows validation (`map_runtime_err` `InvalidChunkRows`; `addSheet`).
	| 'invalid_chunk_rows'
	// Format registry (`map_runtime_err`: `UnknownFormatId`,
	// `FormatCounterExhausted`).
	| 'unknown_format_id'
	| 'format_counter_exhausted'
	// Recompute fixed-point cap (`map_runtime_err` `RecomputeIterationCap` --
	// Internal-class engine fault, surfaced loud not swallowed).
	| 'recompute_iteration_cap'
	// Conflict: `conflicting_ops` (`map_runtime_err` `ConflictingOps` -- transaction
	// commit conflict) and `conflicting_batch_ops` (the `batch` two-writes-to-one-
	// cell guard, `session.rs`).
	| 'conflicting_ops'
	| 'conflicting_batch_ops'
	// Defined-name validation (`map_runtime_err` `Name` -- reserved/invalid name).
	| 'name_reserved'
	// Table ops (`map_runtime_err` `Table*`: create/resize rejected, not-found,
	// column not-found / rejected).
	| 'table_create_rejected'
	| 'table_not_found'
	| 'table_column_not_found'
	| 'table_column_rejected'
	| 'table_resize_rejected'
	// Transaction handle lifecycle (`session.rs`: unknown/closed handle ->
	// not_found; u64 id space exhausted -> id_exhausted, Internal-class).
	| 'transaction_not_found'
	| 'transaction_id_exhausted'
	// Operation handle lookup (`operationStatus` / `cancel` on an unknown op id).
	| 'operation_not_found'
	// Version-token / protocol (`error.rs` `invalid_version_token` /
	// `unsupported_schema_version`; `map_oplog_err` `InvalidVersionVector`). The
	// snapshot/`snapshotDelta` token-decode + schema-version family.
	| 'invalid_version_token'
	| 'invalid_version_vector'
	| 'unsupported_schema_version'
	// Op-log persistence (`map_oplog_err`: serialize -> BadArgument; deserialize /
	// schema-mismatch -> Protocol; Loro-internal -> Internal).
	| 'oplog_serialize'
	| 'oplog_deserialize'
	| 'oplog_schema'
	| 'oplog_loro'
	// Undo/redo re-materialization (`map_loro_undo_err` / `map_replay_err` --
	// Internal-class engine faults in the undo manager / op-log replay).
	| 'undo_manager_failed'
	| 'replay_failed'
	// Cancellation (`error.rs` `canceled`; retryable). Reachable via cancel / the
	// 6.3-1b `start_recalc`/`await_recalc` path.
	| 'canceled'
	// Panic boundary (`error.rs` `panic`). Surfaced as a thrown `[panic]` error by
	// the 6.3-1a napi `guarded()` boundary, AND via `OperationStateJson.error` when
	// a recompute panics (the 6.3-1a L8 fix emits `OperationCompleted{failed}`).
	| 'panic'
	// xlsx import/export (`map_xlsx_err`, `session.rs`: io/zip/calamine/xml-parse/
	// malformed-ooxml/unsupported-feature on import; export/engine on write).
	| 'xlsx_io'
	| 'xlsx_zip'
	| 'xlsx_calamine'
	| 'xlsx_xml_parse'
	| 'xlsx_malformed_ooxml'
	| 'xlsx_unsupported_feature'
	| 'xlsx_export'
	| 'xlsx_engine'
	// csv import/export (`map_csv_err`, `session.rs`: io/parse;
	// exceeds-sheet-limits -> BadArgument; missing export sheet -> Internal).
	| 'csv_io'
	| 'csv_parse'
	| 'csv_exceeds_limits'
	| 'csv_sheet_not_found'
	// Capability -- a surface that is not implemented in the v1 core yet
	// (`not_implemented`, `session.rs`; a visible `Capability` error, never a silent
	// fallback). Emitted today by the reserved `publish_dataset` / `bind_range`.
	| 'not_implemented_in_v1_core'
	// Unmapped catch-alls: the No-Fallbacks loud-Internal arms in the foreign
	// `#[non_exhaustive]` mappers (`map_oplog_err` / `map_persistence_err` /
	// `map_xlsx_err` / `map_csv_err`). A future upstream variant surfaces here
	// (recognizable, not bucketed under `'unknown'`) until its mapper is extended.
	| 'unmapped_oplog_error'
	| 'unmapped_persistence_error'
	| 'unmapped_xlsx_error'
	| 'unmapped_csv_error'
	// Fallback when the message has no recognizable code prefix.
	// Typically means the error came from non-engine, non-binding
	// code (napi task panic, JS-side throw, runtime task error
	// surfaced via the prefix-less `transportLastError()` path).
	// **NOTE**: `'unknown'` is the parser fallback sentinel; the
	// engine binding NEVER emits a literal `[unknown]` prefix per
	// the V2.7 audit closure (Opus MEDIUM-1). See
	// `KNOWN_QUANTBOOK_ERROR_CODES` set comment in session.ts.
	| 'unknown';

/**
 * Structured view of a Quantbook engine error, extracted from the
 * `[<code>] <message>` convention that the napi binding uses.
 *
 * Use [`parseQuantbookError`] to construct from a caught `unknown`.
 */
export interface QuantbookErrorInfo {
	/**
	 * Stable code identifier; one of the {@link QuantbookErrorCode}
	 * values. `'unknown'` if the error message had no recognizable
	 * code prefix.
	 */
	readonly code: QuantbookErrorCode;
	/**
	 * Human-readable message; the original `Error.message` with the
	 * `[<code>] ` prefix stripped. For `'unknown'` errors, the full
	 * original message.
	 */
	readonly message: string;
	/**
	 * The original caught value, for callers that need to re-throw
	 * or inspect non-Error throwables (strings, numbers, custom
	 * classes, etc.).
	 */
	readonly cause: unknown;
	/**
	 * **Phase 6.3-1c (2026-05-30, contract section 5.1):** the engine error's
	 * coarse source class when the thrown error carried it as a NATIVE own-
	 * property (engine-taxonomy errors -- `not_found` / `conflict` / `compute` /
	 * `protocol` / `lifecycle` / ...). `undefined` for FFI-boundary
	 * `bad_argument` validation + collab errors, which still arrive as a
	 * `[code]`-prefix string (the code is recovered from the prefix; class is
	 * inferable from the code).
	 */
	readonly class?: string;
	/**
	 * **Phase 6.3-1c (2026-05-30):** structured context for the error, when the
	 * thrown error carried a native `details` own-property. Delivered as a JSON
	 * string (the engine serializes `EngineError.details`); parse with
	 * `JSON.parse` on demand. `undefined` when the error has no details or did
	 * not arrive as a native structured object.
	 */
	readonly details?: string;
	/**
	 * **Phase 6.3-1c (2026-05-30):** whether a naive retry is meaningful, when
	 * the thrown error carried a native `retryable` own-property. `undefined`
	 * for prefix-string errors.
	 */
	readonly retryable?: boolean;
}
