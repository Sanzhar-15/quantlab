# Codex Phase 4.12 Megaudit Findings

Scope: function library + compatibility matrix integrity. Repo HEAD observed: `947326824af`.

Important execution note: cargo-based probes could not run in this sandbox. `zsh` is unavailable, `$HOME/.cargo/bin` has no `cargo`, and the only visible cargo/test binaries are macOS `aarch64-apple-darwin` binaries. Invoking them from this Linux OrbStack sandbox fails with `dial unix /opt/orbstack-guest/run/hcontrol.sock: connect: operation not permitted`. I therefore did static registry/matrix checks, source-level numerical edge inspection, and direct xlsx XML corpus inventory, but not engine recompute.

Mechanical matrix pass: parsed the `## 1. Functions` table (238 rows: 183 ✅, 29 ⚠️, 24 ❌, 1 🔄, 1 🟡) and compared uppercase function tokens against production `register*` calls in `crates/ql-functions/src/registry.rs` (260 unique registered names). All ✅ function rows resolved to registered names. The only ❌ row with a registered function was the `FILTER / SORT / SORTBY / UNIQUE` row below.

## HIGH

### HIGH-1: `NETWORKDAYS` / `WORKDAY` accept unbounded serials and can hang or return impossible dates

Evidence:
- `serial_to_ymd` defines valid date serials as `1..=2_958_465` and rejects out-of-range with `#NUM!`: `crates/ql-types/src/date.rs:150-176`.
- `NETWORKDAYS` only checks Excel1900 serial `0`, then loops over `lo..=hi` with no upper/lower date bound: `crates/ql-functions/src/date_fns.rs:675-708`.
- `WORKDAY` casts the start serial to `i64`, checks only Excel1900 `0`, and returns `start` unchanged when `days == 0`: `crates/ql-functions/src/date_fns.rs:720-735`. It only enforces `<0` / `>MAX_EXCEL_SERIAL_DAY` inside the movement loop after incrementing: `crates/ql-functions/src/date_fns.rs:737-751`.

Impact:
- `NETWORKDAYS(1, 1000000000000)` can iterate an enormous range instead of returning `#NUM!`.
- `WORKDAY(1000000000000, 0)` returns `1000000000000`, an invalid Excel date serial, instead of `#NUM!`.
- `WORKDAY(-1, 0)` similarly returns a negative serial.

Fix direction: validate both endpoints/start against the date-system serial contract before loops/early returns; reject out-of-range with `#NUM!`.

### HIGH-2: `MOD` and `QUOTIENT` can leak `NaN`/`Inf` as `Value::Number`

Evidence:
- The central numeric contract says kernels must call `sanitize_f64` before wrapping computed floats; non-finite values map to `#NUM!`: `crates/ql-types/src/coercion.rs:211-232`.
- `MOD` computes `x - d * floor(x/d)` and returns `Value::Number(result)` directly: `crates/ql-functions/src/scalar_fns.rs:651-668`.
- `QUOTIENT` computes `(num / den).trunc()` and returns `Value::Number(...)` directly: `crates/ql-functions/src/scalar_fns.rs:1339-1359`.

Impact:
- Finite inputs can overflow intermediate division. Example class: `MOD(f64::MAX, f64::MIN_POSITIVE)` and `QUOTIENT(f64::MAX, f64::MIN_POSITIVE)` produce non-finite intermediate results. Excel/engine contract should surface `#NUM!`, not store `Value::Number(Inf/NaN)`.

Fix direction: keep explicit zero-divisor checks, then wrap final results through `coercion::sanitize_f64`.

## MEDIUM

### MEDIUM-1: Compat matrix has a non-canonical status row that coverage silently ignores

Evidence:
- Status legend/script recognizes only `✅`, `⚠️`, `🔄`, `❌`: `scripts/report-compat-coverage.sh:44-53`.
- `SUBTOTAL` row uses `🟡`: `docs/compat/excel-matrix.md:193`.
- `SUBTOTAL` is registered as range-aware: `crates/ql-functions/src/registry.rs:837-843`.

Impact: the published coverage total excludes a real function row, so the matrix is not fully machine-parseable despite being the compatibility freeze artifact.

Fix direction: change `🟡` to `⚠️` or update the script/legend to treat it explicitly.

### MEDIUM-2: Function matrix says `FILTER` is missing while it is registered; `SEQUENCE` lacks a per-function row

Evidence:
- Matrix row says `FILTER / SORT / SORTBY / UNIQUE` is `❌`: `docs/compat/excel-matrix.md:259`.
- Registry registers `SEQUENCE`, `TRANSPOSE`, and `FILTER` via the unified array-returning tier: `crates/ql-functions/src/registry.rs:845-855`.
- The function table has a `TRANSPOSE` row but no `SEQUENCE` row; a later non-function feature row admits `FILTER + SEQUENCE` shipped: `docs/compat/excel-matrix.md:258-259`, `docs/compat/excel-matrix.md:414`.

Impact: users reading the function matrix see `FILTER` as unavailable even though formulas can dispatch to it, and `SEQUENCE` is only discoverable in the arrays/spills feature row. Coverage accounting also treats the grouped `FILTER` row as fully missing.

Fix direction: split the row or mark it partial with per-function notes (`FILTER` shipped; `SORT`, `SORTBY`, `UNIQUE` missing), and add a `SEQUENCE` function row.

### MEDIUM-3: IronCalc recompute comparison remains unverified in this sandbox

Evidence:
- Fixture XML inventory succeeded: 150 `.xlsx` fixtures across `calc_tests/` and `statistical/`, 149 with formulas, 29,967 formula cells, 0 XML parse errors.
- Top formula families in the fixture corpus include `XLOOKUP` 223, `COUNTIF` 133, `CONCAT` 110, `BETA.DIST` 41, `BETA.INV` 41, `MATCH` 35, `NPV` 26, `IRR` 19, `MIRR` 19.
- Engine recompute could not run because the available cargo/test binaries are macOS binaries blocked by OrbStack host-control permission.

Impact: the requested `RecomputeMode::BestEffort` cached-vs-recomputed divergence report is not produced here. The audit cannot claim IronCalc numerical parity beyond the existing baseline `Skip` round-trip evidence.

Fix direction: run the recompute probe on the host macOS shell or a sandbox with a Linux Rust toolchain.

## LOW

### LOW-1: `TRUE / FALSE` matrix note is stale

Evidence:
- Matrix says `TRUE / FALSE` are "Parsed as identifiers; promoted at bind; explicit Bool Token deferred": `docs/compat/excel-matrix.md:149`.
- Parser now converts bare `TRUE` and `FALSE` identifiers directly to `Expr::Bool`: `crates/ql-formula-syntax/src/parser.rs:290-298`.

Impact: documentation drift. The status may still be partial if `TRUE()` / `FALSE()` function-call forms are intentionally absent, but the current note describes an older parser path.

## Verified Closed Prior Findings

- `BINOM.INV` degenerate distributions: guarded for `p == 0`, `n == 0`, and `p == 1`: `crates/ql-functions/src/distribution_fns.rs:1147-1185`.
- `GAMMA.INV` subnormal scale panic/hang: `gamma_dist_with` rejects `scale < f64::MIN_POSITIVE`, and `gamma_inv` maps that to `#NUM!`: `crates/ql-functions/src/distribution_fns.rs:1458-1481`, `crates/ql-functions/src/distribution_fns.rs:1577-1583`.
- `XIRR` non-root convergence: Newton now requires residual check before success and falls back otherwise: `crates/ql-functions/src/financial_fns.rs:1500-1545`.
- `ATAN2`, `SUMXMY2`, `DAYS360` lexer reachability: lexer tests pin all three as identifiers: `crates/ql-formula-syntax/src/lexer.rs:2141-2199`; workbook e2e pins `ATAN2` and `SUMXMY2`: `crates/ql-exec/src/workbook_runtime.rs:5411-5438`.
- 28 range-aware function admission: `is_aggregate_function` includes the Phase 4.10 range-aware batch: `crates/ql-exec/src/plan.rs:487-525`, and the invariant test mirrors the registry list: `crates/ql-exec/src/workbook_runtime.rs:5207-5246`. Static extraction found zero registered range-aware names missing from admission.
