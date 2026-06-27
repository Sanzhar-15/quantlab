//! Phase 6.4-4 — UDF graph-invalidation exit tests (`session-api.md` §10.4).
//!
//! This file is the **closure gate** for the 6.4-3 Python-UDF arc (6.4-3a
//! codec, 6.4-3b real worker, 6.4-3c eval dispatch, 6.4-3d blockers and
//! diagnostics). The production code shipped across those increments; this proves it
//! against the contract's eight exit tests, each test below labeled with its
//! §10.4 number. With ENG-FUSION shipping `publish_dataset` (4) and `bind_range`
//! (5), this suite now proves ALL EIGHT as positive exits. It is a **public-API
//! integration test** (parallel to
//! `udf_e2e.rs`) — it touches `WorkbookSession` only through `EngineSession` +
//! the inherent `set_udf_worker`, so it doubles as a no-private-access contract
//! check.
//!
//! The §10.4 tests, verbatim:
//!   (1) pure UDF recomputes on referenced-input change;
//!   (2) pure UDF does NOT recompute on unrelated edit;
//!   (3) volatile UDF recomputes on recalc/volatile pass;
//!   (4) `publish` dirties dependents;
//!   (5) `BoundFrame` overlay edit dirties bound-range formulas;
//!   (6) canceled/timed-out UDF does not commit a late result;
//!   (7) failed UDF → deterministic `CellDiagnostic`;
//!   (8) registering a UDF dirties formulas that referenced its (previously-
//!       unknown) name.
//!
//! **Tests 4 (`publish_dataset`) and 5 (`bind_range`) are now positive exits** —
//! ENG-FUSION shipped both producers. Test 4 asserts the publish->dirty->recompute
//! path; test 5 asserts a `BoundFrame` overlay edit (a write into the bound range)
//! dirties bound-range formulas. The volatile-UDF re-eval mechanics of test (3) are
//! additionally proven by `session.rs::mark_volatiles_dirty_fans_out_to_dependents_of_volatile_udf`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ql_exec::WorkbookSession;
use ql_session::dto::{CellAddr, CellRange, CellValue, Severity};
use ql_session::function_meta::{
    ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata, Volatility,
};
use ql_session::session::{EngineSession, Event, EventCursor, FunctionImplHandle};
use ql_types::{ArrayValue, Value};
use ql_udf::{MockWorker, UdfError};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn addr(sheet: u16, row: u32, col: u32) -> CellAddr {
    CellAddr { sheet, row, col }
}

/// Base Python-UDF metadata (Aggregate context, `Variadic`). The volatility /
/// determinism are overridden per test by the two constructors below.
fn base_udf_meta(canonical_name: &str) -> FunctionMetadata {
    FunctionMetadata {
        canonical_name: canonical_name.to_string(),
        display_name: None,
        aliases: vec![],
        arity: Arity::Variadic,
        volatility: Volatility::Volatile,
        determinism: false,
        dep_shape: DepShape::ValueDeps,
        batch_shape: BatchShape::ArrayBatch,
        arg_policy: ArgPolicy::Strict,
        cancellation: CancelPolicy::WorkerKill,
        arg_context: ArgContext::Aggregate,
        provenance_tags: vec!["python".to_string()],
    }
}

/// Register `name` as a **Pure** (non-volatile, deterministic) Python UDF —
/// re-evaluation is then driven SOLELY by dependency dirtiness, so a recompute
/// proves the dep was tracked (a volatile UDF would re-eval unconditionally and
/// mask that signal).
fn register_pure_udf(s: &mut WorkbookSession, name: &str, handle: u64) {
    let mut meta = base_udf_meta(name);
    meta.volatility = Volatility::Pure;
    meta.determinism = true;
    s.register_function(meta, FunctionImplHandle(handle))
        .expect("register_function (pure) clean");
}

/// Register `name` as a **Volatile** Python UDF — it must re-evaluate on every
/// volatile pass (`mark_volatiles_dirty` + recalc) regardless of input change.
fn register_volatile_udf(s: &mut WorkbookSession, name: &str, handle: u64) {
    s.register_function(base_udf_meta(name), FunctionImplHandle(handle))
        .expect("register_function (volatile) clean");
}

/// Read a cell's committed `CellValue` (panics if absent — the tests always set
/// the cell first).
fn cell_value(s: &WorkbookSession, a: CellAddr) -> CellValue {
    s.cell(a)
        .unwrap()
        .unwrap_or_else(|| panic!("cell {a:?} must exist"))
        .value
        .unwrap_or_else(|| panic!("cell {a:?} must have a committed value"))
}

/// A doubling worker that increments `counter` on every call. The returned
/// closure is `FnMut` (captures the `Arc` by move); the caller keeps a clone of
/// `counter` to read the invocation count after recalc.
fn counting_doubler(
    counter: Arc<AtomicUsize>,
) -> impl FnMut(u64, &ArrayValue) -> Result<ArrayValue, UdfError> {
    move |_handle, args: &ArrayValue| {
        counter.fetch_add(1, Ordering::SeqCst);
        let n = match args.get(0, 0) {
            Some(Value::Number(x)) => *x,
            other => panic!("counting_doubler expected a number arg, got {other:?}"),
        };
        Ok(ArrayValue::singleton(Value::Number(n * 2.0)))
    }
}

// ---------------------------------------------------------------------------
// §10.4 (1) — pure UDF recomputes on referenced-input change
// ---------------------------------------------------------------------------

/// A `Pure` `=MYUDF(A1)` recomputes when its referenced input A1 changes. The
/// invocation counter proves the worker was actually re-called (not a cache
/// hit), and the value tracks the new input — so the dep A1→B1 is wired and
/// dirty fanout reaches the UDF cell.
#[test]
fn exit_test_1_pure_udf_recomputes_on_referenced_input_change() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    register_pure_udf(&mut s, "MYUDF", 7);
    let calls = Arc::new(AtomicUsize::new(0));
    s.set_udf_worker(Box::new(MockWorker::new(counting_doubler(Arc::clone(&calls)))));

    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
        .unwrap();
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = 42
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one initial UDF call");

    // Change the referenced input. The edit alone must NOT eagerly recompute the
    // dependent (set_value only dirties via the graph) — the worker stays at 1
    // call until recalc_dirty. This pins that the recompute is driven by
    // recalc_dirty consuming the dirty set, not by an eager set_value path (so a
    // future eager-recompute regression with a no-op recalc_dirty can't pass).
    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 50.0 })
        .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "editing A1 must not eagerly re-invoke the UDF before recalc_dirty"
    );
    s.recalc_dirty().unwrap();
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 100.0 },
        "editing A1 must re-evaluate the pure UDF to track the new input"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "the pure UDF must be re-invoked exactly once after the input change"
    );
}

// ---------------------------------------------------------------------------
// §10.4 (2) — pure UDF does NOT recompute on unrelated edit
// ---------------------------------------------------------------------------

/// A `Pure` `=MYUDF(A1)` must NOT recompute when an unrelated cell is edited.
/// The invocation counter stays flat across `recalc_dirty` — proving the dirty
/// set is dependency-scoped and a pure UDF is not spuriously re-run.
#[test]
fn exit_test_2_pure_udf_does_not_recompute_on_unrelated_edit() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    register_pure_udf(&mut s, "MYUDF", 7);
    let calls = Arc::new(AtomicUsize::new(0));
    s.set_udf_worker(Box::new(MockWorker::new(counting_doubler(Arc::clone(&calls)))));

    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
        .unwrap();
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = 42
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one initial UDF call");

    // Edit an UNRELATED cell (C5) that B1 does not depend on. Editing it DOES
    // dirty C5's own node, so the following recalc_dirty has real work to do
    // (it is not a no-op — exit tests 1 and 3 drive the SAME call to re-run a
    // formula). The point is that B1 is not in that dirty set.
    s.set_value(addr(sheet, 4, 2), CellValue::Number { number: 999.0 })
        .unwrap();
    s.recalc_dirty().unwrap();
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 },
        "B1 value is unchanged after an unrelated edit"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a pure UDF must NOT be re-invoked when an unrelated cell changes"
    );
}

// ---------------------------------------------------------------------------
// §10.4 (3) — volatile UDF recomputes on recalc/volatile pass
// ---------------------------------------------------------------------------

/// A `Volatile` `=MYUDF(A1)` re-evaluates on a volatile pass
/// (`mark_volatiles_dirty` + `recalc_dirty`) even though NO input changed —
/// the defining property of volatility. Contrast with exit test 2, where the
/// SAME `recalc_dirty` leaves a pure UDF untouched.
#[test]
fn exit_test_3_volatile_udf_recomputes_on_volatile_pass() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    register_volatile_udf(&mut s, "MYUDF", 7);
    let calls = Arc::new(AtomicUsize::new(0));
    s.set_udf_worker(Box::new(MockWorker::new(counting_doubler(Arc::clone(&calls)))));

    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
        .unwrap();
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap(); // B1 = 42
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one initial UDF call");

    // FIRST: a plain recalc_dirty with NOTHING dirty must NOT re-run the volatile
    // UDF — this isolates the volatile pass from "recalc_dirty re-runs volatiles
    // anyway". (If this bumped the counter, the volatile-pass assertion below
    // would be meaningless.)
    s.recalc_dirty().unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a plain recalc_dirty with no dirty set must NOT re-run the volatile UDF"
    );

    // THEN the volatile pass: mark volatiles dirty, then recalc → re-evaluates
    // even though NO input changed. This is the defining property of volatility,
    // and the ONLY thing that moved the counter from 1 to 2.
    s.mark_volatiles_dirty().unwrap();
    s.recalc_dirty().unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "a volatile UDF must re-evaluate on a volatile pass with no input change"
    );
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 },
        "the recomputed value is still correct (input unchanged)"
    );
}

// ---------------------------------------------------------------------------
// §10.4 (4) — publish dirties dependents
// ---------------------------------------------------------------------------

/// `publish_dataset` (ENG-FUSION) commits a value into its target via the
/// `write_range` substrate, so a formula referencing the published cell is
/// dirtied and recomputes on the next `recalc_dirty`. Re-publishing a new value
/// drives the dependent again — the reactive Python->grid path (the moat).
#[test]
fn exit_test_4_publish_dirties_dependents() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    let target = CellRange {
        sheet,
        start_row: 0,
        start_col: 0,
        end_row: 0,
        end_col: 0,
    };
    // A1 fed by publish_dataset; B1 = A1 * 2 depends on it.
    s.publish_dataset("ds", serde_json::json!({"values": [[21.0]]}), target)
        .expect("publish_dataset commits a value into the target");
    s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap(); // B1 = 42
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 }
    );
    // Re-publish a new value -> B1 is dirtied and recomputes to track it.
    s.publish_dataset("ds", serde_json::json!({"values": [[50.0]]}), target)
        .expect("re-publish commits the new value");
    s.recalc_dirty().unwrap();
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 100.0 },
        "re-publishing the source value must dirty + recompute the dependent"
    );
}

// ---------------------------------------------------------------------------
// §10.4 (5) — BoundFrame overlay edit dirties bound-range formulas
// ---------------------------------------------------------------------------

/// `bind_range` (ENG-FUSION) registers a `BoundFrame` overlay region; a v1
/// overlay edit is a write into that region (via the `write_range` substrate), so
/// a formula referencing a bound cell is dirtied and recomputes on `recalc_dirty`.
/// This asserts the binding is registered AND that an edit within the bound range
/// dirties bound-range formulas.
#[test]
fn exit_test_5_boundframe_overlay_edit_dirties_bound_range_formulas() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    let target = CellRange {
        sheet,
        start_row: 0,
        start_col: 0,
        end_row: 0,
        end_col: 0,
    };
    let bound = s
        .bind_range("binding-1", target)
        .expect("bind_range registers the overlay region");
    assert_eq!(bound.binding_id, "binding-1");
    assert_eq!(
        s.binding("binding-1").map(|b| b.target),
        Some(target),
        "the bound region is recorded and resolvable by id"
    );

    // B1 = A1 * 2 references the bound cell A1.
    s.set_formula(addr(sheet, 0, 1), "A1*2").unwrap(); // B1 = 0 (A1 blank)
    // A BoundFrame overlay edit = a write into the bound range. It dirties B1.
    s.write_range(target, vec![vec![CellValue::Number { number: 21.0 }]])
        .unwrap();
    s.recalc_dirty().unwrap();
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 },
        "an overlay edit within the bound range must dirty + recompute bound-range formulas"
    );
}

// ---------------------------------------------------------------------------
// §10.4 (6) — canceled/timed-out UDF does not commit a late result
// ---------------------------------------------------------------------------

/// A timed-out UDF commits the deterministic `#TIMEOUT!` error VALUE — never a
/// stale or late worker result — and the session stays usable (the failure is
/// leaf I/O, not an engine fault, so the recompute FaultGuard never seals).
///
/// v1 reaches the TIMEOUT half of "canceled/timed-out": the dispatch maps
/// `Timeout` to a deterministic cell value, committed atomically, with no path
/// for a late success to overwrite it. (The cooperative-`CANCEL` route —
/// `UdfError::Cancelled` → `#CALC!` + `udf_cancelled` — is not yet driven from
/// the session; its diagnostic code is covered by exit test 7.)
///
/// This is the **engine half**: a `MockWorker` is synchronous, so it cannot
/// produce a late frame here. The **process half** — the real worker is killed
/// on timeout (so a late RETURN cannot correlate to a live call) — is enforced
/// by construction in `crates/ql-udf/src/process.rs` (timeout → `kill_worker`
/// drops the `WorkerProcess` and its mpsc receiver; the next call respawns a
/// fresh channel) and exercised by `crates/ql-udf/tests/process_smoke.rs`:
/// `process_worker_round_trips_against_real_python` asserts `pid() == None`
/// after a timeout-kill then a correct fresh result on respawn, and
/// `process_worker_times_out_under_frame_flood` asserts the deadline holds under
/// a continuous frame stream. (Those tests loud-skip without python+pyarrow.)
#[test]
fn exit_test_6_timed_out_udf_commits_deterministic_error_not_late_result() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    register_volatile_udf(&mut s, "MYUDF", 7);
    s.set_udf_worker(Box::new(MockWorker::new(|_h, _a| {
        Err(UdfError::Timeout(std::time::Duration::from_millis(1)))
    })));
    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 1.0 })
        .unwrap();
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
    assert!(
        matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#TIMEOUT!"),
        "a timed-out UDF commits #TIMEOUT!, never a late/stale success value"
    );
    // The session is NOT faulted — a follow-up edit succeeds.
    s.set_value(addr(sheet, 0, 2), CellValue::Number { number: 5.0 })
        .expect("session remains usable after a timed-out UDF (no engine fault)");
}

// ---------------------------------------------------------------------------
// §10.4 (7) — failed UDF → deterministic CellDiagnostic
// ---------------------------------------------------------------------------

/// Drain every `CellDiagnostic` for cell `a` from the session event ring,
/// returning `(code, is_error_severity, message)` tuples (read does not drain
/// the ring; the addr filter rejects any diagnostic for another cell).
fn cell_diagnostics_for(s: &mut WorkbookSession, a: CellAddr) -> Vec<(String, bool, String)> {
    let page = s.poll_events(EventCursor(0)).unwrap();
    page.events
        .iter()
        .filter_map(|e| match e {
            Event::CellDiagnostic { diagnostic } if diagnostic.addr == Some(a) => Some((
                diagnostic.code.clone(),
                matches!(diagnostic.severity, Severity::Error),
                diagnostic.message.clone(),
            )),
            _ => None,
        })
        .collect()
}

/// Run `=MYUDF(A1)` against a worker that always fails with `make_err()`, and
/// return the B1 diagnostics. (`make_err` is a `Fn` so the `FnMut` MockWorker can
/// re-produce the error; the UDF is invoked once per `set_formula`.)
fn diagnostics_after_udf_failure(
    make_err: impl Fn() -> UdfError + Send + 'static,
) -> Vec<(String, bool, String)> {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    register_volatile_udf(&mut s, "MYUDF", 7);
    s.set_udf_worker(Box::new(MockWorker::new(move |_h, _a| Err(make_err()))));
    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
        .unwrap();
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
    cell_diagnostics_for(&mut s, addr(sheet, 0, 1))
}

/// Each distinct UDF failure mode emits a deterministic `Error`-severity
/// `CellDiagnostic` with a stable `code` (the IDE renders it as the tooltip
/// explaining WHY a cell is `#CALC!`/`#TIMEOUT!`). This covers ALL eight codes
/// the dispatch emits — the no-worker case plus every `ql_udf::UdfError` variant
/// (all are `MockWorker`-reachable, the responder simply returns the chosen
/// error). Each case runs in its own session so a single cell carries exactly
/// one diagnostic. Pins the code strings (an IDE/contract surface) against a
/// silent rename or a dropped `push_udf_cell_diagnostic` in any arm.
#[test]
fn exit_test_7_failed_udf_emits_deterministic_cell_diagnostic() {
    let b1 = |sheet: u16| addr(sheet, 0, 1);

    // (a) No worker → udf_no_worker (Error severity, stable message, value #CALC!).
    {
        let mut s = WorkbookSession::new();
        let sheet = s.add_sheet("S", 16384).unwrap();
        register_volatile_udf(&mut s, "MYUDF", 7);
        s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
            .unwrap();
        s.set_formula(b1(sheet), "MYUDF(A1)").unwrap();
        assert!(
            matches!(cell_value(&s, b1(sheet)), CellValue::Error { error } if error == "#CALC!"),
            "no-worker UDF value is #CALC!"
        );
        let diags = cell_diagnostics_for(&mut s, b1(sheet));
        assert!(
            diags.iter().any(|(code, is_err, msg)| code == "udf_no_worker"
                && *is_err
                && msg == "no Python worker is configured for this session"),
            "no-worker UDF must emit an Error-severity udf_no_worker CellDiagnostic with the stable message; got {diags:?}"
        );
    }

    // (b) Every UdfError variant → its stable code, at Error severity. The
    // factories construct each variant the dispatch's `udf_error_diagnostic`
    // maps; the loop pins the full code set, not just raise/timeout.
    // (boxed so the heterogeneous per-case factories share one Vec type)
    type ErrFactory = Box<dyn Fn() -> UdfError + Send>;
    let cases: Vec<(&str, ErrFactory)> = vec![
        (
            "udf_raised",
            Box::new(|| UdfError::Raised {
                exc_type: "ValueError".into(),
                message: "boom".into(),
            }),
        ),
        (
            "udf_timeout",
            Box::new(|| UdfError::Timeout(std::time::Duration::from_millis(5))),
        ),
        ("udf_cancelled", Box::new(|| UdfError::Cancelled)),
        (
            "udf_handshake",
            Box::new(|| UdfError::Handshake { expected: 1, got: 2 }),
        ),
        (
            "udf_protocol",
            Box::new(|| UdfError::Protocol("unexpected frame".into())),
        ),
        (
            "udf_worker_died",
            Box::new(|| UdfError::WorkerDied("transport broken".into())),
        ),
        (
            "udf_codec",
            Box::new(|| UdfError::Codec(ql_udf::codec::CodecError::Empty)),
        ),
    ];
    for (expected_code, make) in cases {
        let diags = diagnostics_after_udf_failure(make);
        let hit = diags.iter().find(|(code, _, _)| code == expected_code);
        let (_, is_err, msg) = hit.unwrap_or_else(|| {
            panic!("UDF failure must emit a {expected_code} CellDiagnostic; got {diags:?}")
        });
        assert!(*is_err, "{expected_code} diagnostic must be Error severity");
        // Stable-message spot checks for the two with a fixed human payload.
        if expected_code == "udf_raised" {
            assert_eq!(msg, "ValueError: boom", "udf_raised carries 'exc_type: message'");
        }
        if expected_code == "udf_timeout" {
            assert!(
                msg.contains("deadline"),
                "udf_timeout message mentions the deadline; got {msg:?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// §10.4 (8) — registering a UDF dirties formulas that referenced its name
// ---------------------------------------------------------------------------

/// A formula `=MYUDF(A1)` authored BEFORE `MYUDF` is registered binds against an
/// unknown name and evaluates to `#NAME?`. Registering `MYUDF` (the
/// `on_function_registered` reverse-index hook) must DIRTY that formula; with a
/// worker now installed, `recalc_dirty` recomputes it to the real value. This
/// is the end-to-end session-level proof of the dirty-on-register path (the
/// reverse-index unit is `calcgraph_session::tests`; this exercises the full
/// register → dirty → recalc → compute chain through `WorkbookSession`).
#[test]
fn exit_test_8_registering_udf_dirties_formulas_referencing_its_name() {
    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();
    s.set_value(addr(sheet, 0, 0), CellValue::Number { number: 21.0 })
        .unwrap();
    // Author the formula while MYUDF is UNKNOWN → binds, evaluates to #NAME?.
    s.set_formula(addr(sheet, 0, 1), "MYUDF(A1)").unwrap();
    assert!(
        matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#NAME?"),
        "an unregistered function name evaluates to #NAME? before registration"
    );

    // Register MYUDF (dirties B1 via the reverse index) + install a worker.
    register_pure_udf(&mut s, "MYUDF", 7);
    let calls = Arc::new(AtomicUsize::new(0));
    s.set_udf_worker(Box::new(MockWorker::new(counting_doubler(Arc::clone(&calls)))));

    // CRUCIAL: neither register_function nor set_udf_worker may eagerly recompute
    // B1 — it must remain #NAME? with the worker uncalled until recalc_dirty. If
    // either healed B1 here (or recalc_dirty were a no-op), the final 42 would not
    // prove the register → dirty → recalc chain. Pin both.
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "register_function / set_udf_worker must NOT eagerly call the worker"
    );
    assert!(
        matches!(cell_value(&s, addr(sheet, 0, 1)), CellValue::Error { error } if error == "#NAME?"),
        "B1 stays #NAME? after registration until recalc_dirty runs the dirtied formula"
    );

    // Recalc the dirty set → B1 must now compute through the worker exactly once.
    s.recalc_dirty().unwrap();
    assert_eq!(
        cell_value(&s, addr(sheet, 0, 1)),
        CellValue::Number { number: 42.0 },
        "registering MYUDF must dirty =MYUDF(A1) so recalc_dirty recomputes it (21*2=42)"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "recalc_dirty re-evaluated the dirtied formula exactly once (the dirty came from register)"
    );
}
