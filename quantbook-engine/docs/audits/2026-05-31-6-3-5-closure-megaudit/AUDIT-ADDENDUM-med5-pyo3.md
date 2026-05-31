# 6.3-5 Closure Megaudit -- POST-FREEZE AUDIT ADDENDUM (MED-5 pyo3 incomplete fold)

Date: 2026-06-01. Found during a hard re-audit AFTER the freeze was declared.

## Finding (HIGH, fixed)
MED-5 (OperationState.Failed.error -> nested structured object) was folded in TWO of three
bindings, not all three:
- napi `operation_error_json_from_engine_error` + `OperationErrorJson` struct (ql-bindings-node/src/lib.rs:5009/5238) -- CORRECT.
- IDE `OperationErrorJson` interface (extensions/quantlab/src/quantbook/types.ts:1489) -- CORRECT.
- pyo3 `operation_state_to_py` Failed arm (quantbook-py/src/lib.rs:1338) -- **STILL emitted the legacy
  `format!("[{}] {}", error.code, error.message)` STRING.**

### Why it mattered
Reachable: the pyo3 facade binds `poll_events`, whose `OperationCompleted` event carries
`operation_state_to_py(state)`. A Python consumer polling a FAILED op got `error` as a STRING
while a Node consumer got an OBJECT -- a cross-binding fork frozen into the contract.

### Why the megaudit + the independent re-verify missed it
- The golden flow never produces a Failed operation, so the parity matrix never exercised the
  Failed arm (matrix-invisible -- the exact failure mode HIGH-A also had).
- The cycle-2 implementer's report CLAIMED the change was made 'in all three places'; it was not
  (feat `cbec0613d6b` never touched `operation_state_to_py`). The first re-verify checked the napi
  struct + IDE interface + that the matrix was green, but did not field-diff the pyo3 Failed arm.

## Fix (engine `2b6f3f55e93`)
pyo3 `operation_state_to_py` Failed arm now builds the nested dict
`{code, class(via class_str), retryable, details?(JSON string when non-empty), source?}`,
omitting details/source when absent to match napi `Option<String>` -> undefined -> dropped by
`JSON.stringify`. `message` dropped (napi `OperationErrorJson` has no message field). The frozen
contract SHAPE is unchanged; pyo3 was non-conformant and is now conformant.

Verified: cargo build -p quantbook-py debug+release 0/0; clippy 0; parity_matrix.py PARITY OK (23
steps) under python3.12.

## Residual
- Coverage gap: the Failed state stays matrix-uncovered (no deterministic failing op in the golden
  flow). The fix rests on field-for-field review vs napi/IDE. A future regression here would again
  be matrix-invisible -- a candidate hardening for 6.2/6.5 (inject a deterministic failing op).
- LESSON: never accept a delegated implementer's 'done in all N places' for a cross-repo/cross-binding
  fold without field-diffing each of the N sites against the others. A green parity matrix only proves
  the EXERCISED surface.
