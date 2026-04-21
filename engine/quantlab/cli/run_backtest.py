"""
CLI bridge for running backtests from the VS Code extension.

Reads JSON config from stdin, runs ql.backtest(), emits NDJSON
progress/log events to stderr, and outputs the final result JSON to stdout.

Usage:
    echo '{"jobId":"abc", "strategyPath":"strat.py", ...}' | \
        python -m quantlab.cli.run_backtest
"""

import glob as _glob
import json
import math
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _sanitize_for_json(obj: Any) -> Any:
    """Recursively replace float('inf'), float('-inf'), and float('nan') with None.

    JavaScript's JSON.parse rejects the non-standard tokens Infinity, -Infinity,
    and NaN that Python's json.dumps emits for these values.
    """
    if isinstance(obj, float):
        if math.isinf(obj) or math.isnan(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj


def emit_progress(job_id: str, pct: float, msg: str) -> None:
    """Write an NDJSON progress event to stderr."""
    line = json.dumps({
        "type": "progress",
        "jobId": job_id,
        "progress": round(pct, 1),
        "message": msg,
    })
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def emit_log(job_id: str, level: str, msg: str) -> None:
    """Write an NDJSON log event to stderr."""
    line = json.dumps({
        "type": "log",
        "jobId": job_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": msg,
        "level": level,
    })
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def discover_data_file(strategy_path: str, symbol: str) -> str | None:
    """
    Search near the strategy file for a matching CSV or Parquet data file.

    Search order:
      1. Same directory as strategy
      2. data/ subdirectory relative to strategy
      3. Parent directory of strategy
    For each location, look for {symbol}*.csv and {symbol}*.parquet
    (case-insensitive match on symbol prefix).

    Returns the first match found, or None.
    """
    if not symbol or not symbol.strip():
        return None

    strat_dir = Path(strategy_path).resolve().parent
    search_dirs = [
        strat_dir,
        strat_dir / "data",
        strat_dir.parent,
        strat_dir.parent / "data",
    ]

    symbol_lower = symbol.strip().lower()
    for d in search_dirs:
        if not d.is_dir():
            continue
        for ext in ("csv", "parquet"):
            pattern = str(d / f"*.{ext}")
            for match in sorted(_glob.glob(pattern)):
                if Path(match).stem.lower().startswith(symbol_lower):
                    return match
    return None


def convert_results(results: Any, job_id: str) -> dict[str, Any]:
    """
    Convert a quantlab BacktestResults object into the JSON shape
    expected by the TypeScript JobResult interface.

    Returns:
        {
          "success": true,
          "metrics": {"Sharpe": ..., "Return": ..., ...},
          "warnings": [...],
          "equity": [{"t": epoch_ms, "v": value}, ...],
          "signals": [{"t": epoch_ms, "type": "entry"|"exit", "label": ..., "price": ...}, ...]
        }
    """
    # Build flat metrics dict for TS side (Record<string, number>)
    metrics: dict[str, float] = {}
    if results.metrics:
        m = results.metrics
        if m.sharpe_ratio is not None:
            metrics["Sharpe"] = round(m.sharpe_ratio, 4)
        if m.sortino_ratio is not None:
            metrics["Sortino"] = round(m.sortino_ratio, 4)
        if m.total_return_pct is not None:
            metrics["Return"] = round(m.total_return_pct, 4)
        if m.max_drawdown_pct is not None:
            metrics["MaxDrawdown"] = round(m.max_drawdown_pct, 4)
        if m.win_rate is not None:
            metrics["WinRate"] = round(m.win_rate, 2)
        if m.profit_factor is not None:
            metrics["ProfitFactor"] = round(m.profit_factor, 4)
        if m.calmar_ratio is not None:
            metrics["Calmar"] = round(m.calmar_ratio, 4)
        if m.total_trades is not None:
            metrics["Trades"] = m.total_trades

    # Fallback: populate from top-level fields if metrics object is sparse
    if "Return" not in metrics and results.total_return_pct is not None:
        metrics["Return"] = round(float(results.total_return_pct), 4)
    if "Trades" not in metrics:
        metrics["Trades"] = len(results.trades)

    # Equity curve: list of {t: epoch_ms, v: float}
    equity: list[dict[str, Any]] = []
    for ts, val in results.equity_curve:
        epoch_ms = int(ts.timestamp() * 1000) if isinstance(ts, datetime) else int(ts * 1000)
        equity.append({"t": epoch_ms, "v": round(float(val), 2)})

    # Signals: derived from fills
    signals: list[dict[str, Any]] = []
    for fill in results.fills:
        epoch_ms = int(fill.timestamp.timestamp() * 1000) if isinstance(fill.timestamp, datetime) else int(fill.timestamp * 1000)
        side_str = fill.side.name if hasattr(fill.side, "name") else str(fill.side)
        is_entry = "BUY" in side_str.upper()
        signals.append({
            "t": epoch_ms,
            "type": "entry" if is_entry else "exit",
            "label": "Buy" if is_entry else "Sell",
            "price": round(float(fill.price), 6),
        })

    return {
        "success": True,
        "metrics": metrics,
        "warnings": results.warnings or [],
        "equity": equity,
        "signals": signals,
    }


def run(config: dict[str, Any]) -> None:
    """
    Orchestrate: load data -> run backtest -> convert -> output.

    Reads config dict with keys:
        jobId, strategyPath, symbol, timeframe, dateStart, dateEnd,
        dataSource, initialCapital, commission, positionSize, params
    """
    job_id = config["jobId"]
    strategy_path = config["strategyPath"]
    symbol = config.get("symbol", "")
    timeframe = config.get("timeframe", "")
    date_start = config.get("dateStart")
    date_end = config.get("dateEnd")
    data_source = config.get("dataSource", "")
    initial_capital = config.get("initialCapital", 100000)
    commission = config.get("commission", 0.001)
    position_size = config.get("positionSize", 100)
    params = config.get("params", {})

    emit_progress(job_id, 5, "Loading strategy...")

    # Validate strategy exists
    if not Path(strategy_path).exists():
        raise FileNotFoundError(f"Strategy file not found: {strategy_path}")

    # Resolve data file
    emit_progress(job_id, 10, "Resolving data file...")

    data_path: str | None = None

    # 1. If dataSource is a valid file path, use it directly
    if data_source and data_source not in ("default", "Default", "") and Path(data_source).exists():
        data_path = data_source
    elif symbol and symbol.strip():
        # 2. Fallback: auto-discover data file near strategy (backward compat)
        data_path = discover_data_file(strategy_path, symbol)
        if data_path:
            emit_log(job_id, "info", f"Auto-discovered data file for symbol '{symbol}'")

    if data_path is None:
        raise FileNotFoundError(
            "No data source specified. "
            "Please select a CSV or Parquet data file in the chart or action view."
        )

    emit_log(job_id, "info", f"Using data file: {data_path}")
    emit_progress(job_id, 20, "Running backtest...")

    # Import quantlab and run the backtest
    import quantlab as ql

    # Redirect stdout to stderr so any print() calls inside the strategy
    # don't corrupt our JSON output channel.
    saved_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        results = ql.backtest(
            strategy=strategy_path,
            data=data_path,
            symbol=symbol or None,
            initial_capital=initial_capital,
            commission=commission,
            position_size=position_size,
            start=date_start,
            end=date_end,
            params=params if params else None,
        )
    finally:
        sys.stdout = saved_stdout

    emit_progress(job_id, 90, "Converting results...")

    output = convert_results(results, job_id)

    # Sanitize inf/NaN values that JavaScript's JSON.parse cannot handle
    output = _sanitize_for_json(output)

    emit_progress(job_id, 100, "Complete.")
    emit_log(job_id, "info", f"Backtest complete: {len(results.trades)} trades")

    # Write final result JSON to stdout (allow_nan=False as safety net)
    json.dump(output, sys.stdout, allow_nan=False)
    sys.stdout.flush()


def main() -> None:
    """Entry point: read stdin config, run backtest, handle errors."""
    raw = sys.stdin.read()
    if not raw.strip():
        err = {"success": False, "error": "No input received on stdin"}
        json.dump(err, sys.stdout)
        sys.stdout.flush()
        sys.exit(1)

    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        err = {"success": False, "error": f"Invalid JSON on stdin: {e}"}
        json.dump(err, sys.stdout)
        sys.stdout.flush()
        sys.exit(1)

    job_id = config.get("jobId", "unknown")

    try:
        run(config)
    except Exception as e:
        emit_log(job_id, "error", str(e))
        # Write error result to stdout so the TypeScript side can parse it
        err_result = {
            "success": False,
            "error": str(e),
            "stack": traceback.format_exc(),
        }
        json.dump(err_result, sys.stdout)
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
