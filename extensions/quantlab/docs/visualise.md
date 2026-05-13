# Quantlab Visualise -- user guide

> Status: **v1** (shipped through Phase 9). Stable API; subject to additive
> changes in v2 (see "Out of scope" at the end).

Visualise is Quantlab's interactive chart builder. It opens any CSV /
TSV / Parquet file, infers a sensible default chart from the schema,
and lets you refine it through a GUI without leaving VS Code. The
result is a `.qviz.json` file that pairs with the data; opening that
JSON re-renders the same chart.

This document covers the end-user surface (editor, builder UI, data
inspector), the Python preset API, error states, troubleshooting, and a
brief architecture quickref for contributors.

---

## 1. Overview

### What gets installed

The Quantlab extension registers two custom editors:

| View type                       | File pattern              | What it does                              |
| ------------------------------- | ------------------------- | ----------------------------------------- |
| `quantlab.visualiseView`        | `*.csv`, `*.tsv`, `*.parquet` | Read-only data file (builder bootstraps from it; saving emits a `.qviz.json` next to the data) |
| `quantlab.visualiseSpecView`    | `*.qviz.json`             | The chart builder (priority `default`)    |

Right-click a CSV / TSV / Parquet file in the explorer and pick
**Quantlab: Visualise** (or use `Ctrl+Q V`) to open the data view.
Saving a chart from the builder produces a `<name>.qviz.json` next to
the data file -- double-clicking that file from then on reopens the
chart.

> **XLSX is NOT supported in v1.** The daemon's security gate
> (`python/qviz/security.py:45`) accepts only `.parquet`, `.csv`, and
> `.tsv`. Convert xlsx to one of these (e.g., via pandas) before
> opening with Visualise.

### What a `.qviz.json` file is

A `.qviz.json` is a small JSON document that captures everything needed
to redraw a chart from its source data:

```json
{
  "qviz_version": 1,
  "dataset": {
    "uri": "data/aapl.parquet",
    "schema_hash": "sha256:...",
    "mtime_ns": 1700000000000000000
  },
  "transforms": [],
  "chart": {
    "family": "timeseries",
    "type": "candlestick",
    "encodings": {
      "ohlcv": {
        "time": "time",
        "open": "open", "high": "high", "low": "low", "close": "close"
      }
    }
  },
  "provenance": {
    "generated_at": "2026-05-12T00:00:00Z",
    "generator": "quantlab-visualise/builder",
    "query_hash": "sha256:...",
    "tool_versions": { "qviz_schema": 1 }
  }
}
```

The validator at `src/qviz/validate.ts` is the authoritative gate
between disk and the application -- every `.qviz.json` is parsed +
validated before it reaches the renderer. Workspace-relative dataset
URIs are required; `..` escapes are rejected; unknown transform kinds
are rejected (defense against forward-rolled specs an older Quantlab
can't run).

### How the editor relates to data + spec

```
┌──────────────────────────────────────────────────────────────────────┐
│  VS Code custom editor (webview iframe -- CSP-locked, vega-interpreter)│
│  ┌────────────────────┐  ┌────────────────────┐  ┌─────────────────┐ │
│  │ Builder UI (left)  │  │ Chart preview      │  │ Inspector (opt.)│ │
│  │ - column panel     │  │ - charts-plus or   │  │ - virtualized   │ │
│  │ - chart type picker│  │   Vega-Lite        │  │   table         │ │
│  │ - encoding shelves │  │ - skeleton overlay │  │ - column filters│ │
│  │ - transform list   │  │   while inflight   │  │ - selection sync│ │
│  └────────────────────┘  └────────────────────┘  └─────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
            │                       ▲                       │
            ▼                       │                       ▼
    ┌─────────────────────────────────────────────────────────────┐
    │ Extension host (Node)                                       │
    │  - VisualiseSpecProvider: brokers webview ↔ daemon          │
    │  - DaemonLifecycle: spawns + monitors python qviz.daemon    │
    └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌──────────────────────────────────┐
              │ Python daemon (qviz.daemon)       │
              │  - DuckDB-backed queries          │
              │  - parquet/csv schema + decimation│
              │  - inspector preview + stats      │
              └──────────────────────────────────┘
```

---

## 2. Getting started -- open a data file

1. Right-click a CSV / TSV / Parquet file in the explorer.
2. Pick **Quantlab: Visualise** (or use `Ctrl+Q V` with the file open).
3. Quantlab spawns the qviz daemon (Python interpreter resolved in
   this order: explicit `quantlab.pythonPath` setting →
   `python.defaultInterpreterPath` setting → `~/.quantlab/venv/bin/python`
   fallback), reads the file's schema, and shows a default chart.
4. To customize, save once -- the editor switches to the spec view
   (`.qviz.json`) with the full builder UI.

### Default-chart picks (Phase 8 Step A)

The default chart is derived from the schema:

| Schema shape                                                          | Default              |
| --------------------------------------------------------------------- | -------------------- |
| `open` + `high` + `low` + `close` (case-insensitive) + temporal column | **candlestick**      |
| temporal column + ≥1 numeric column                                   | **line**             |
| ≥2 numeric columns                                                    | **scatter**          |
| else                                                                  | "pick manually"      |

The OHLCV detector requires **all four** of open/high/low/close to be
present and numeric, plus a temporal column. `volume` is optional. The
match is case-insensitive (`Open`, `OPEN`, `open` all work), but the
column names must be the literals -- `open_price` won't match.

If none of the heuristics fits the schema, the builder opens with no
preselected chart and you pick types + encodings manually.

---

## 3. Builder UI walkthrough

The spec editor is the main workspace. Top-to-bottom on the left:

### Column panel
Lists every column from the data file with its dtype. Dragging a column
onto an encoding shelf assigns it. Clicking the column shows its
inferred classification (temporal / quantitative / nominal).

### Chart-type picker
Nine buttons:

| Family       | Types                                              |
| ------------ | -------------------------------------------------- |
| `timeseries` | line, area, bar, histogram, candlestick, baseline  |
| `general`    | line, bar, histogram, scatter, heatmap, pie        |

Shared types (line, bar, histogram) stay in the current family when
clicked -- switching scatter → line keeps you in `general`; switching
candlestick → line keeps you in `timeseries`. Family-only types
(candlestick, baseline → timeseries; scatter, heatmap, pie → general)
switch family on click.

Keyboard navigation: arrow keys move + select, Home/End jump,
Space/Enter selects. The picker uses a WAI-ARIA radiogroup pattern with
a roving tabindex (exactly one button is in the tab order).

### Encoding shelves
The shelf list changes with the chart type (authoritative source:
`src/qviz/chartChannels.ts:CHART_CHANNELS`):

| Type        | Required          | Optional                                       |
| ----------- | ----------------- | ---------------------------------------------- |
| line / area | `x`, `y`          | `color`, `y2`, `facet_row`, `facet_col`        |
| scatter     | `x`, `y`          | `color`, `size`, `shape`, `facet_row`, `facet_col` |
| bar         | `x`, `y`          | `color`, `facet_row`, `facet_col`              |
| histogram   | `x`               | `y` (count if omitted), `color`, `facet_row`, `facet_col` |
| heatmap     | `x`, `y`, `color` | `facet_row`, `facet_col`                       |
| pie         | `color`, `y`      | (no facets)                                    |
| candlestick | `ohlcv` cluster (`time`/`open`/`high`/`low`/`close`/`volume`) | -- |
| baseline    | `x`, `y`          | `color` (baseline value is hardcoded to 0 in v1) |

Each shelf accepts one encoding. Drag a column onto a shelf or use the
shelf's dropdown. Missing required shelves produce a compile-time
diagnostic in the preview area (NOT a save block -- the validator
intentionally allows structurally-valid-but-incomplete specs so the
user can save a half-built spec and resume later).

### OHLCV cluster (candlestick only)
A compound shelf that takes 4–5 column names at once. The smart default
populates it from a detected OHLCV schema; otherwise you fill it in
manually.

### Transform pipeline
A list of data transforms applied in order before the chart sees the
data. Supported kinds (authoritative enum: `src/qviz/spec.ts:Transform`):

- `filter` -- predicate over a column. Ops: `==`, `!=`, `<`, `<=`, `>`,
  `>=`, `in`, `not_in`, `is_null`, `not_null`, `contains`.
- `groupby` + `aggregate` -- must appear as a pair, in order.
  Aggregate fns: `sum`, `mean`, `median`, `min`, `max`, `count`, `std`,
  `first`, `last`.
- `sort` -- one or more (column, desc?) entries.
- `limit` -- cap rows after sort (range [1, 10,000,000]).
- `bin` -- bucket a continuous column. Strategies: `equal_width`
  (`equal_freq` is documented but rejected by the validator -- not yet
  implemented).
- `date_trunc` -- truncate timestamps to a calendar boundary
  (`second`/`minute`/`hour`/`day`/`week`/`month`/`quarter`/`year`).
- `tz_convert` -- convert a temporal column to a timezone.
- `math` -- derived scalar fns: `log`, `log10`, `exp`, `abs`, `sqrt`,
  `log_returns` (plural), `pct_change`, `drawdown`. The `math` fns are
  scalar-per-row; running aggregates like running-max belong in the
  `window` transform, not here.
- `window` -- rolling/expanding window. Fns: `rolling_mean`,
  `rolling_std`, `rolling_max`, `rolling_min`, `cumsum`, `cumprod`,
  `cummax`, `cummin`. (`ema` is documented in the spec type but rejected
  by the daemon compiler in v1.)
- `expr` -- **Visualise v2 calculated field.** A user-typed expression
  over one or more columns producing a new column named `as`. The
  textarea accepts a closed-grammar expression language (see below);
  the webview parses the text to an AST and the daemon walks the AST to
  emit parameterized DuckDB SQL.

  **Operators** (Python-style precedence: `||` < `&&` < `!` < comparison
  < `+`/`-` < `*`/`/`/`%` < unary `-`):
  - Arithmetic: `+`, `-`, `*`, `/`, `%`
  - Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`
  - Logical: `&&`, `||`, `!`

  **Conditional**: `if (cond) then a else b` (compiles to DuckDB
  `CASE WHEN cond THEN a ELSE b END`).

  **Whitelisted functions** (no user-defined fns; no SQL aggregates or
  window fns -- use `aggregate` / `window` for those):
  - Unary numeric: `abs`, `log` (natural), `ln`, `log10`, `exp`, `sqrt`
  - 2-arg numeric: `min` (DuckDB `least`), `max` (DuckDB `greatest`)
  - Null handling: `coalesce(...)` (1..32 args), `nullif(a, b)`

  **Literals**: integer / decimal / exponent numbers (`42`, `1.5`,
  `1e-3`), single-quoted strings with `\\`, `\'`, `\n`, `\t`, `\r`
  escapes, `true` / `false` / `null`.

  **Caps**: 1024 chars input / 16 levels deep / 256 nodes. The webview
  parser rejects oversize input inline; the validator + daemon re-check
  at the wire boundary.

  **Limits & rules** (megaudit Theme F F6):
  - `references` must equal the set of column refs in the AST. Webview
    parser populates this from the parse; validator + daemon re-verify
    that `set(references) == set(collectColumnRefs(expression))`.
  - `as` must be a fresh name. The daemon refuses `expr.as=close` (a
    source column) AND `expr.as=sma20` if a preceding `window` already
    produced `sma20`.
  - Identifiers that aren't bare-ASCII (`mid price`, `if`, `價格`) must
    be wrapped in backticks. Doubled backtick escapes a literal one.

  Common examples:
  - `pnl_pct = (close - open) / open`
  - `mid = (high + low) / 2`
  - `direction = if (close > open) then 1 else -1`
  - `signed_volume = if (close > open) then volume else -volume`
  - `vol_filled = coalesce(volume, 0)`

  **NULL semantics.** SQL three-valued logic applies, so any operation
  with a NULL operand returns NULL — including comparisons. In a
  conditional like `if (vol > 0.3) then 1 else 0`, a row where `vol` is
  NULL falls through to the ELSE branch (NULL is neither greater nor
  not-greater than 0.3). If you want a row with NULL to produce NULL
  rather than the ELSE value, use `coalesce` or `nullif` to make the
  null-handling explicit, e.g.:
  - `regime = if (coalesce(vol, 0) > 0.3) then 1 else 0` (NULL → 0)
  - `regime = if (vol > 0.3) then 1 else nullif(0, 0)` (NULL → NULL)

  **Integer/float division.** DuckDB's `/` returns DOUBLE for integer
  inputs (true division), not integer division. So `1 / 2 = 0.5`. Use
  `floor(a / b)` if you want integer-style truncation. (`floor` is not
  in the current whitelist — file an issue if you need it.)

  **Numeric precision.** Numeric literals are parsed as IEEE-754
  doubles. Integer literals outside [-2^53, 2^53] are rejected at
  parse time to prevent silent rounding.

Not implemented in v1 (rejected by validator or compiler):
`resample` (use `date_trunc` + `groupby` + `aggregate`), `window fn=ema`,
`bin strategy=equal_freq`.

Pipeline validation runs at every save and at every spec parse -- orphan
`groupby` (no `aggregate` following) is rejected, and unknown kinds are
rejected for forward-roll safety.

### Diagnostics
A small log under the chart preview shows the last successful render's
elapsed time + any compile-time warnings (e.g. precision-loss warnings
from aggregating DECIMAL / 64-bit-integer columns — see Operational
notes §9). On failure it shows the error tagged with its structured
kind: one of `compile`, `security`, `timeout`, `memory`, `internal`,
or `protocol`.

---

## 4. Data inspector (Phase 6 + Phase 7 B-10 cure)

The data inspector is a right-side toggleable table that shows the
exact rows the chart is rendering. Useful for sanity-checking a
transformation pipeline ("are my rows being filtered correctly?",
"what's the value of X on this point?").

### Toggle
- Keyboard: **`Ctrl+I`** (Mac: **`Cmd+I`**).
- Mouse: click the "Inspector" toggle button in the editor header.
- The toggle is disabled when the daemon doesn't advertise **all three**
  inspector capability flags: `inspector.previewOffset`,
  `inspector.columnStats`, and `inspector.aggregateFilters`. Any one
  flag missing disables the toggle (graceful degradation against
  pre-Phase-6 / pre-Phase-7 daemons; the cure in Phase 7 added
  per-respawn re-broadcast so the toggle re-enables when a respawned
  daemon advertises the full bag).

### Three filter widgets
Each column header gets a small `⏷` filter chip. Clicking it opens a
popup whose widget kind depends on the column's stats:

| Column kind                | Widget         |
| -------------------------- | -------------- |
| numeric / temporal         | Range slider (min + max number inputs) |
| string, high-cardinality   | "contains" text input (case-insensitive) |
| nominal / low-cardinality  | Checkbox set of distinct values |

- Column stats are fetched lazily on first open and cached for the
  panel's lifetime.
- Active filters show a `⏷•` glyph + `aria-pressed=true` (megaudit
  Tier-6: non-color cue + screen-reader signal).
- Popups use `role="group"` (not `role="dialog"` -- the popup isn't
  modal, it's a labelled container).
- Popups auto-clamp + flip above the cell if the viewport doesn't have
  room below.
- Filters are **session-only by design**. They never persist into
  `.qviz.json`. Closing the panel drops them.
- **NULL handling** (closure megaudit 2026-05-13): the checkbox-set
  widget renders a `(null)` row whenever the column has any SQL NULL
  values. Unchecking only `(null)` keeps non-null rows and drops
  NULLs; leaving `(null)` checked while unchecking non-null values
  preserves NULLs in the filtered result. See §9 "Operational notes"
  for the full SQL/Excel trivalent semantics including `not_in`
  behavior.

### Aggregated charts (Phase 7 B-10 cure)
For specs with `groupby` + `aggregate` (e.g., `pnl_by_strategy`,
`factor_exposure`), the inspector view matches the chart's aggregated
shape -- clicking a row in the table highlights the corresponding chart
point, and vice versa. The cure threaded the spec's transform pipeline
through the daemon's `op_preview` so the inspector window pages the
*aggregated* result, not the raw rows.

### Selection sync
- Chart click → row highlight (x-value match, NaN-safe, temporal canonicalized to ms).
- Row click → chart-side selection (when the chart's x-field exists in the preview schema).
- `Esc` clears selection.
- Selection routes through whichever channel the chart actually keys on
  -- `ohlcv.time` for candlestick, `color.field` for pie, `x.field` for
  everything else (megaudit B-2 / B-3 cure).

### Performance notes
- Inspector window is 200 rows per daemon fetch; the virtualized table
  shows ~50 visible rows with overscan.
- Filtered previews are cached daemon-side by
  `(path, fingerprint, filters, offset, n)` so scrolling under a
  sustained filter doesn't re-run DuckDB.
- Row height is fixed at 24 px; total height matches the daemon's
  reported row count.

---

## 5. Python preset API (Phase 7)

For Python notebooks / scripts that want to emit `.qviz.json` files
directly (no GUI in the loop), `qviz` exposes five preset callables on
the top-level package:

```python
import pandas as pd
import qviz

# 1. Candlestick
qviz.candlestick(
    df=ohlcv_df,                  # columns: time, open, high, low, close, [volume]
    output="figures/aapl_2024",   # writes aapl_2024.parquet + aapl_2024.qviz.json
    title="AAPL 2024 candlesticks",
    timezone="America/New_York",
)

# 2. Equity curve
qviz.equity_curve(
    df=backtest_results,          # columns: time, equity (or pass time_col=, equity_col=)
    output="figures/backtest_eq",
)

# 3. PnL by strategy
qviz.pnl_by_strategy(
    df=trades_df,                 # columns: strategy, pnl
    output="figures/pnl_by_strat",
    aggregate=True,               # default; aggregates sum(pnl) by strategy, sorted desc
)

# 4. Drawdown
qviz.drawdown(
    df=equity_df,                 # columns: time, equity
    output="figures/drawdown",
    # drawdown is pre-computed in Python (running_max guard handles
    # negative / zero peaks); area renders naturally below zero.
)

# 5. Factor exposure
qviz.factor_exposure(
    df=long_format_df,            # columns: factor, exposure
    output="figures/exposure",
    aggregate=True,               # default; aggregates mean(exposure) by factor, sorted desc
)
```

### Contract

- **Input**: a pandas DataFrame + an output **stem** (no extension, no
  `.` in basename), interpreted as a path **relative to CWD** (the
  workspace root). Absolute paths outside CWD are rejected.
- **Output**: two files, written atomically (`tempfile.mkstemp + os.replace`):
  - `<stem>.parquet` -- the source data (or pre-computed shape, for `drawdown`).
  - `<stem>.qviz.json` -- the spec.
  - Return value: `Path` to the spec.
- **Provenance**:
  - `generator = "qviz.<preset_name>/<PRESET_API_VERSION>"` (e.g.,
    `"qviz.candlestick/0.1.0"`). Built by
    `python/qviz/presets/_common.py:make_generator_string`.
  - `source = "engine-emitted"`.
  - `query_hash` is the all-zeros sentinel (the preset writes the
    parquet itself; no SQL hash to compute).
  - `schema_hash` + `mtime_ns` computed through the same authoritative
    `reader.hash_schema` / `reader.file_mtime_ns` the daemon uses.
  - `tool_versions` includes both `qviz_schema: 1` and
    `python_qviz: "0.1.0"` (the preset API's own version).
- **Safety**:
  - Output paths reject NUL bytes, C0 control chars, `..` segments,
    paths escaping CWD, empty stems.
  - String fields (title, description, timezone, every `*_col`) pass
    through `check_acceptable_string` (validator parity: ≤ 4 KiB, no
    NUL, no C0 controls except `\t\n\r`).
  - `overwrite=False` by default. Set `overwrite=True` to clobber.
  - Atomic-write parent dir is opened with `O_DIRECTORY | O_NOFOLLOW`
    and tempfile + rename happens via `dir_fd` so a post-resolve
    symlink swap can't redirect writes (megaudit M-1 cure).

### Required vs. configurable columns

| Preset            | Required columns                                     | Configurable kwargs |
| ----------------- | ---------------------------------------------------- | -------------------- |
| `candlestick`     | `time, open, high, low, close` (+ optional `volume`; column names hard-coded) | `title=, description=, timezone=, decimation= (auto / lttb / minmax / none), limit= ([1, 10_000_000]), overwrite=` |
| `equity_curve`    | `time, equity`                                       | `time_col=, equity_col=, title=, description=, timezone=, decimation=, overwrite=` |
| `pnl_by_strategy` | `strategy, pnl`                                      | `strategy_col=, pnl_col=, title=, description=, aggregate=, overwrite=` |
| `drawdown`        | `time, equity`                                       | `time_col=, equity_col=, title=, description=, timezone=, decimation=, overwrite=` |
| `factor_exposure` | `factor, exposure`                                   | `factor_col=, exposure_col=, title=, description=, aggregate=, overwrite=` |

`drawdown` is pre-computed in Python (`running_max -> equity/max - 1`,
inf normalized to NaN, `running_max > 0` guard for negative-equity
prefixes). The on-disk parquet stores only `time` + `drawdown`; the
emitted spec leaves `chart.options.y_axis_zero` unset because the
timeseries renderer doesn't honor it yet -- drawdown values are
naturally ≤ 0, so the area renders below the baseline regardless. If
you need to keep raw equity, call `equity_curve(df)` and `drawdown(df)`
separately.

`pnl_by_strategy` and `factor_exposure` aggregate by default with a
tie-break sort key on the group column ascending and the aggregate
alias descending -- set `aggregate=False` if your DataFrame is already
pre-aggregated.

### Smoke checklist for the preset API
`.plans/_phase7-smoke-checklist.md` walks the end-to-end use of each
preset (~24 manual checks).

---

## 6. Polish features (Phase 8)

### OHLCV smart-default (Step A)
See "Default-chart picks" above. Detector lives at
`src/qviz/defaults.ts:detectOhlcvColumns`.

### Ctrl+Z / Ctrl+Y undo + redo (Step B)
Two-layer history:

- **UI history** (inspector toggle, selection) -- handled in the webview
  store's `history` slice (cap 100 entries).
- **Spec edits** -- ride VS Code's native `CustomDocument` undo stack
  via the existing `onDidChangeCustomDocument` wiring.

When `Ctrl+Z` fires, the webview first checks `state.history.past`. If
non-empty, it pops the most recent UI-history snapshot. Otherwise the
keystroke bubbles up to VS Code, which undoes the last spec edit.
`Ctrl+Y` is symmetric.

### Chart-area loading skeleton (Step C)
While the daemon is computing the next aggregate
(`state.query.inflight !== null`), a CSS-only overlay of four pulsing
bars + an axis line covers the chart container. It clears the moment
`dataReceived` / `error` arrives, so the skeleton never outlives the
actual paint.

### Retry buttons on error banners (Step D)
- **"Retry connection"** appears next to the daemon-status banner
  whenever the daemon is `crashed | respawning | unavailable`. Clicking
  it forces an immediate respawn attempt -- no editor reload required.
- **"Re-check file"** appears when the dataset is `missing |
  dangling-symlink | access-denied | path-escape |
  extension-not-allowed | no-workspace`. Clicking it re-statting the
  file and re-emits the dataset-status; the workflow recovers without
  a session restart.

### In-webview unsaved indicator (Step F)
A small orange dot next to the "Visualise spec" title in the editor
header, hidden via `[hidden]` when the spec is clean. Driven by
`isDirty(state.spec)` (specHash !== lastSavedHash).

### Phase 8 smoke checklist
`.plans/_phase8-smoke-checklist.md`.

---

## 7. Error states

The chart preview's stripe banner composes status from multiple sources;
each appears as a separate clause separated by ` · `:

| Banner text                                                                | When                                       | Recovery                                                |
| -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `computing…`                                                                | A daemon request is inflight              | Wait; or change inputs to cancel-and-replace.           |
| `Last successful render from previous spec`                                | Inflight request whose specHash differs   | Wait; once it lands, the old chart is replaced.         |
| `Data file changed -- schema preserved; save to refresh provenance`         | File rewritten, columns unchanged          | Save once; the new mtime + hash get written to the spec.|
| `Data file changed -- N field(s) missing: a, b`                            | Schema drift; spec references columns no longer in the data | Pick replacement columns on the affected encoding shelves; or revert the data file. Save is **blocked** in this drift state until the spec is consistent. |
| `Daemon crashed; retrying in Nms`                                          | Daemon died; auto-retry scheduled         | Wait; or click **Retry connection** to skip the wait.  |
| `Daemon respawning…`                                                       | Auto-retry in progress                    | Wait.                                                  |
| `Daemon unavailable: <msg>`                                                | Daemon failed to spawn / banner timed out | Check `quantlab.pythonPath`; click **Retry connection**.|
| `Dataset file not found: <uri>`                                            | File deleted between open and now         | Click **Re-check file** after restoring the file.       |
| `Dataset symlink target gone: <uri>`                                       | Symlink target removed                    | Fix symlink; click **Re-check file**.                  |
| `Dataset access denied: <uri> -- <msg>`                                     | Permissions changed                       | Fix perms; click **Re-check file**.                    |
| `Dataset path is not workspace-relative: <uri>`                            | Spec's dataset URI escapes the workspace  | Move data into workspace; edit spec dataset URI; or open a different workspace folder. |
| `Dataset extension not supported: <uri>`                                   | File extension is not in `.parquet/.csv/.tsv` | Convert the file (xlsx → parquet via pandas, etc.); update the spec's `dataset.uri`. |
| `No workspace folder is open; cannot resolve dataset.`                     | The editor opened the spec without a workspace context | Open the folder that contains the data file as a workspace, or use **File > Open Folder**. |

The diagnostics readout under the stripe shows the last daemon error
tagged with its structured kind (one of `compile`, `security`,
`timeout`, `memory`, `internal`, `protocol`) and its transform index
if applicable:

    [compile] (transform #2) filter column 'volum' not in schema

---

## 8. Troubleshooting / FAQ

**Q: My CSV opens with a line chart, not candlestick.**
A: The OHLCV smart-default requires **all four** of `open`, `high`,
`low`, `close` (case-insensitive) AND a temporal column. If any of
those four is missing or non-numeric, the detector falls through to
the temporal+numeric → line branch. Rename your columns to match (e.g.,
`Open`, `High`, `Low`, `Close`) and reopen.

**Q: Inspector preview is empty / toggle is disabled.**
A: The qviz daemon must advertise the `inspector` capability bag. Old
daemons (pre-Phase-6) don't, in which case the toggle is disabled with
a tooltip explaining the capability gap. If the toggle IS enabled but
the table shows no rows, check the diagnostics readout for an
`inspectorError` message.

**Q: Save says "cannot save -- fields missing".**
A: Schema drift. Your spec references columns that don't exist in the
current data file. The stripe shows the missing column list. Either:
1. Replace the missing columns on the encoding shelves (the column
   panel shows what's available), or
2. Revert the data file so the original schema is back.

The save button stays disabled until the spec is consistent.

**Q: "Daemon unavailable: spawn ENOENT python".**
A: Quantlab can't find a Python interpreter for the qviz daemon. Set
`quantlab.pythonPath` in settings to your venv's `python` binary, or
install the daemon's deps into `~/.quantlab/venv/`:

    python3 -m venv ~/.quantlab/venv
    ~/.quantlab/venv/bin/pip install -e extensions/quantlab/python

**Q: Chart looks stale after I edited the file.**
A: Schema drift is auto-detected (mtime / schema-hash compare), but
**the chart only re-fetches on user input**. Save the spec or change
any encoding to force a re-query.

**Q: Inspector filters disappear when I close the panel.**
A: That's intentional. Filters are session-only by design -- they never
persist to `.qviz.json`. Reopening the panel starts with a clean filter
state. (To make a filter permanent, add a corresponding `filter`
transform to the spec's transform pipeline.)

**Q: Preset API: "qviz.candlestick: output stem contains '.' in basename".**
A: The preset output must be a stem with no extension, e.g.
`figures/aapl_2024` (the `.parquet` and `.qviz.json` suffixes are
appended automatically). `figures/aapl.2024` is rejected because the
basename contains a `.`.

---

## 9. Operational notes

### Aggregate precision on DECIMAL / 64-bit-integer columns

`sum / mean / median / std / min / max` on a DECIMAL or 64-bit-integer
column compiles to DuckDB SQL with an explicit `CAST(... AS DOUBLE)`.
The DuckDB engine itself handles wide integers natively (HUGEINT for
`sum(BIGINT)`), but the Arrow IPC bridge to the webview's TS-side
renderer does not yet support Decimal128 extraction — so the
intermediate `CAST` is what keeps the pipeline working. DOUBLE has
53 bits of mantissa: values past 2^53 (~9e15) lose ones-place
precision, and DECIMAL aggregates lose fractional precision at large
magnitudes.

The compiler emits a `warning` per affected aggregate; the daemon
surfaces them on `aggregate` response data as `data.warnings: string[]`,
and the provider relays them to the webview's diagnostics readout so
the loss is visible. For auditing / accounting outputs that need exact
arithmetic, pre-aggregate externally and load the result, or wait for
the planned exact-decimal extractor (tracked as a follow-up to G5 —
requires DuckDB → Arrow Decimal128 in the extractor + a renderer
contract for exact-value rendering, both out of scope for v1).

### NULL semantics in inspector set filters

The set-filter widget renders a `(null)` checkbox whenever the column
has any SQL NULL rows (the `op_column_stats` query surfaces `null` at
the head of the `distinct` list when `null_count > 0`). Unchecking
`(null)` filters out NULL rows; leaving it checked while unchecking
non-null values produces SQL like `col IS NULL OR col IN (...)` so
NULL rows are correctly preserved.

`not_in` filters follow SQL/Excel trivalent semantics, NOT boolean
complement: `not_in ["a"]` against a nullable column excludes BOTH
the "a" rows AND the NULL rows. A NULL row's truth value under
`col NOT IN ("a")` is UNKNOWN, so it does not pass the WHERE clause.
If you want NULL rows surfaced, leave `(null)` checked alongside the
non-null values you keep (which compiles to `col IS NULL OR col IN
(...)`, not `NOT IN`).

### Running the qviz Python tests

From the extension root (`extensions/quantlab`):

    ~/.quantlab/venv/bin/python -m pytest python/qviz/tests/ -q

Several fixtures depend on a 1M-row OHLCV parquet at
`/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet`. The `conftest`
auto-generates it on session start, so local runs Just Work. CI and
strict environments should set `QUANTLAB_REQUIRE_FIXTURES=1`, which
converts the soft-skip on missing fixtures into a hard failure so a
silently-skipped suite cannot look green:

    QUANTLAB_REQUIRE_FIXTURES=1 ~/.quantlab/venv/bin/python -m pytest python/qviz/tests/ -q

The `npm run test:py` script invokes this strict variant; the
`npm run test:py:dev` script keeps the soft-skip default for local
work. Schema-shape conditional skips (e.g. tests that require a
`ticker` column the synthetic parquet does not provide) remain soft
skips even under strict mode — those are capability gates, not
fixture-presence gates.

### Wire-shape kind unions (closure megaudit 2026-05-13)

For contributors editing the protocol enums: the following unions are
the source of truth and must stay in lockstep across TS and Python:

| Union | TS source | Python source |
|---|---|---|
| `DaemonErrorKind` | `daemon-client.ts:75-89` (set + decoder) | `daemon.py:Daemon` class — every `"error_kind": "<kind>"` literal |
| `InspectorErrorKind` | `messageProtocol.ts:354-376` | n/a (provider derives; subset of DaemonErrorKind) |
| `DaemonStatusKind` | `messageProtocol.ts:166-180` + validator set | `daemon-lifecycle.ts:75-110` (TS-only) |
| `InspectorSetFilter.includes` | `messageProtocol.ts:303-315` (admits null) | n/a (validator accepts) |

The cross-side `test_kind_set_matches_catch_ladder_source` (Python)
and the daemon.py grep in `qviz-error-kind-contract.test.ts` (TS)
catch drift between the daemon's emitted kinds and the TS-side
validator set.

---

## 10. Architecture quickref (for contributors)

### Top-level layout

| Layer            | Code                                                    |
| ---------------- | ------------------------------------------------------- |
| Daemon (Python)  | `extensions/quantlab/python/qviz/`                      |
| TS validator     | `extensions/quantlab/src/qviz/validate.ts`              |
| Daemon client    | `extensions/quantlab/src/qviz/daemon-client.ts`         |
| Expr AST/parser  | `extensions/quantlab/src/qviz/exprAst.ts`, `exprParser.ts` |
| Pipeline order   | `extensions/quantlab/src/qviz/pipelineValidate.ts`      |
| Extension host   | `extensions/quantlab/src/views/visualise/VisualiseSpecProvider.ts` |
| Webview entry    | `extensions/quantlab/webview/qviz-spec/index.ts`        |
| Webview state    | `extensions/quantlab/webview/qviz/state/`               |
| Webview UI       | `extensions/quantlab/webview/qviz/components/`          |
| Renderer host    | `extensions/quantlab/webview/qviz/render/RendererHost.ts` |
| Python presets   | `extensions/quantlab/python/qviz/presets/`              |

### Webview state slices (10)
See `webview/qviz/state/store.ts`:

| Slice         | Responsibility                                              |
| ------------- | ----------------------------------------------------------- |
| `source`      | Inbound dataset URI + path normalization                    |
| `schema`      | Last-known schema + drift detection state                   |
| `spec`        | Authoritative spec + lastSavedHash for dirty tracking       |
| `ui`          | Builder-UI ephemeral state (which shelf is being edited, etc.) |
| `query`       | In-flight requests + last successful render's data + errors |
| `persistence` | Save-attempt result tracking (drift-aware save)              |
| `renderer`    | Active render family + handle for cleanup                   |
| `runtime`     | Daemon status + dataset status + capabilities bag           |
| `inspector`   | Inspector panel state (visible, window, filters, selection) |
| `history`     | Phase 8 UI undo/redo history stack (cap 100)                |

### Spec validation
- **TS validator** (`src/qviz/validate.ts`): the authoritative gate
  between disk JSON and the application. Returns
  `{ ok: true, value: QvizSpec } | { ok: false, issues: [...] }`.
- **Daemon compiler** (`python/qviz/compiler.py`): turns a validated
  spec into a DuckDB query plan. Pipeline-order validation,
  column-existence checks, and SQL injection guards live here.
- **Round-trip stability**: `serializeSpec → parseSpecBytes` is
  byte-stable (Phase 9 smoke test `qviz-e2e-smoke.test.ts` pins this).

### Daemon protocol
`extensions/quantlab/src/qviz/messageProtocol.ts` is the source of
truth. Every cross-boundary message has a typed validator. Inbound
messages at the webview boundary (postMessage from the provider) go
through `validateInboundMessage`. Daemon-side, `daemon.py` validates
every payload before acting.

Protocol version is `PROTOCOL_VERSION = 1`. Envelope mismatch fails
loudly with `"envelope.protocolVersion X does not match expected 1;
reload required"`.

### Security invariants (megaudits)
- All workspace-relative paths checked for `..` escapes + NUL +
  control chars.
- `op_preview` / `op_aggregate` / `op_decimate`: column names
  validated against the schema before splicing into SQL.
- LIKE wildcards (`%`, `_`, `\`) escaped with `ESCAPE '\'` (megaudit
  M-H cure, both compiler paths).
- Atomic writes use `O_DIRECTORY | O_NOFOLLOW` on the parent dir so
  post-resolve symlink swaps can't redirect (Phase 7 megaudit M-1
  cure).
- Inspector filters' set sentinels: empty `{op:'in', value:[]}` is
  short-circuited daemon-side (megaudit M-G cure) -- no rows match.

### Phase boundaries (for future readers)

| Phase | Shipped                                                                 |
| ----- | ----------------------------------------------------------------------- |
| 0     | Repository scaffolding, daemon contract, plan                            |
| 1     | DuckDB-backed daemon ping + schema + preview                             |
| 2     | Daemon `aggregate` op + pytest harness                                   |
| 3     | TS validator + daemon `decimate` op                                      |
| 4     | Renderer family dispatch (charts-plus + Vega-Lite via vega-interpreter) |
| 5     | Custom editors + builder UI + drift-aware save                           |
| 6     | Data inspector panel (virtualized table, column filters, selection sync) |
| 7     | Python preset API (`qviz.candlestick`, `equity_curve`, …)               |
| 8     | Polish -- OHLCV smart-default, Ctrl+Z, skeleton overlay, retry buttons   |
| 9     | Tests + docs (jsdom UI tests, E2E smoke, this guide)                    |

---

## 11. Out of scope (explicitly v2+)

The following are NOT in v1, by design:

- Remote VS Code (SSH / Codespaces / dev-container) -- the daemon
  expects a local filesystem and a local Python interpreter.
- Cross-filter / linked brushing across multiple charts.
- Full pivot-table family.
- Real-time / streaming data.
- Delta Plus cloud sync of saved specs.
- Chart-side visual selection overlay (deferred from Phase 6 polish).
- Time-series `factor_exposure` (rolling correlation against factor
  returns); v1 ships the long-format snapshot only.
- Auto-open the produced `.qviz.json` after preset writes -- would need
  a brittle `code` CLI shellout from Python.

The user-authored expression language (`expr` transform) and the
"Promote to Chart" timeseries-family handoff are SHIPPED in v1 and
documented in §3 ("Transform pipeline") and §6 ("Promote to Chart"),
respectively. They are no longer "v2+".

---

## 12. Migration

There is no migration guide for v1 because v1 is the first stable
release. When a v2 schema lands, this section will document the
codemod path. The `qviz_version: 1` field in every spec is the future-
migration anchor: a v2 reader will accept v1 specs and offer to upgrade
them on save.

---

## 13. Smoke checklists

If you want to manually walk the user-facing surface, the per-phase
smoke checklists live at:

- `.plans/_phase5-smoke-checklist.md` (48 boxes; covers Phase 5 ship)
- `.plans/_phase6-smoke-checklist.md` (~30 boxes; data inspector)
- `.plans/_phase7-smoke-checklist.md` (~24 boxes; preset API)
- `.plans/_phase8-smoke-checklist.md` (Phase 8 polish features)
- `.plans/_phase9-smoke-checklist.md` (Phase 9 docs + tests)

Each checklist walks the relevant features end-to-end. They're meant
for the human to drive, not for CI.
