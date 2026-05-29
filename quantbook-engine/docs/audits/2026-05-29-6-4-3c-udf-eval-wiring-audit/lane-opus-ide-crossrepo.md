# Lane 3 — Opus, cross-repo / IDE lens

Verdict: **SHIP** (cross-repo surface) · HIGH 0 · MED 0 · LOW 0 · 57 tool uses / 100.7k tokens.

IDE located: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab` (VS Code fork), branch `feat/visualise-v1`. Quantbook IDE sources under `extensions/quantlab/src/quantbook/`.

## Dimension 1 — Error-code allowlist (the key concern): CLEAN
The IDE's `KNOWN_QUANTBOOK_ERROR_CODES` set (`extensions/quantlab/src/quantbook/session.ts:775-811`) is an allowlist of **thrown-`Error` bracket codes** (`bad_argument`, `transport`, `function_exists`, …) parsed from `[code] message` exception strings — it governs JS exceptions from method calls, NOT cell error sigils. A `#TIMEOUT!` cell never touches it.
Cell error values reach the IDE as `{ kind: 'error', value: string }` and are rendered verbatim:
- `formatCellValue` → `case 'error': return value.value;` (`cellGridHtml.ts:305-306`)
- `formatCellValueClient` → `if (value.kind === 'error') return value.value;` (`cellGridHtml.ts:681`)
The TS type is an OPEN string `{ kind: 'error'; value: string }` (`types.ts:1095`) — no sigil enum, no exhaustiveness switch. `extractSheetSnapshot` passes the string through unchanged; throws only on unknown `kind`, never unknown sigil.
Bindings side: `parse_canonical_error_text` (`ql-oplog/src/wire.rs:357-376`) maps `#VALUE!`/`#CALC!`/`#TIMEOUT!`; `error_to_canonical_text` emits `e.sigil()` (all 15 variants). `cell_value_json_from_session` (`ql-bindings-node/src/lib.rs:4182`) is a verbatim passthrough. A timed-out UDF displays literal `#TIMEOUT!` — correct, not an unknown-error throw.

## Dimension 2 — napi DTO round-trip: CLEAN
Scalar / spilled-array (ordinary cell records via `write_spill`, no UDF-specific DTO) / error sigil all round-trip. No value shape producible only by a UDF that the DTO can't carry.

## Dimension 3 — Worker-injection gap honesty: CLEAN, correctly DEFERRED
`set_udf_worker` is NOT exposed over napi (zero hits in ql-bindings-node and the IDE). True shipped-product state: no worker injected → `dispatch_udf` returns `#CALC!` for every registered UDF — panic-free, FaultGuard never seals, IDE renders literal `#CALC!`. Matches the design (6.4-3d does the bridge).

## Dimension 4 — register_function/list_functions (6.4-2) interaction: CLEAN
No IDE call sites yet (the napi fns appear only in doc comments). The 6.4-3c `#NAME?`→`#CALC!` value transition introduces no stale-assumption breakage. `unregisterFunction` doc still correct (#NAME? after unregister).

## Dimension 5 — Other: CLEAN
Snapshot/delta of UDF cells ride the existing path; no `#CALC!`/`#TIMEOUT!` string-matching in the IDE; UDF error cells edit via `data-raw-formula` (show formula, not sigil); no TS error-kind enum to desync.

## Engine-internal note (filed for the other reviewer)
Transaction inline-eval uses `WorkbookEnv::new` (no worker). The only non-test worker-less recompute path that matters is `xlsx_recompute.rs:38` (xlsx import) — but an imported UDF name has no `udf_handle` during import → `#NAME?`, never reaches dispatch. Session batch/transaction commit goes through `with_runtime`/`with_runtime_no_oplog`, both of which thread `self.udf_worker.as_ref()`. Not a cross-repo defect.
