"""Offline smoke of a bundled Quantlab engine (PORTS: every target platform runs the same proof).

Usage: python build/python/engine_smoke.py <bundled exe> <work dir>

Runs one backtest the way the extension's JobRunner starts it: cwd = the exe's directory, no PYTHONPATH,
the job config on stdin, `-m quantlab.cli.run_backtest`. Inputs are deterministic: 160 weekday bars from
2025-01-01 and the repository's SMA crossover fixture. No network, no secrets.

Exit 0 only when the result is a success with 160 equity points and 5 signals; the last line printed is
`ENGINE-SMOKE PASS stdout-sha256 <hex>` (the darwin-arm64 reference is ccb2e28d8ae3e6e35c56fe9cc563d074ee3c3440364f94ad2a0c24b686097a3a).
Any other outcome prints `ENGINE-SMOKE FAIL <reason>` and exits 1.
"""

import datetime
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
STRATEGY = REPO / "engine" / "tests" / "fixtures" / "sample_strategy_sma_crossover.py"
EXPECTED_EQUITY_POINTS = 160
EXPECTED_SIGNALS = 5


def fail(reason: str) -> None:
    print(f"ENGINE-SMOKE FAIL {reason}")
    sys.exit(1)


def write_bars(path: Path) -> None:
    day = datetime.date(2025, 1, 1)
    rows = ["date,open,high,low,close,volume"]
    n = 0
    while n < EXPECTED_EQUITY_POINTS:
        if day.weekday() < 5:
            c = 100 + 10 * math.sin(n / 9) + n * 0.05
            rows.append(f"{day.isoformat()},{c - 0.5:.2f},{c + 1:.2f},{c - 1:.2f},{c:.2f},{1000000 + n * 100}")
            n += 1
        day += datetime.timedelta(days=1)
    path.write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: engine_smoke.py <bundled exe> <work dir>")
    exe = Path(sys.argv[1]).resolve()
    work = Path(sys.argv[2]).resolve()
    if not exe.is_file():
        fail(f"no executable at {exe}")
    if not STRATEGY.is_file():
        fail(f"no strategy fixture at {STRATEGY}")
    work.mkdir(parents=True, exist_ok=True)
    bars = work / "bars.csv"
    write_bars(bars)
    config = {
        "jobId": "backtest-proof-0001", "strategyPath": str(STRATEGY), "mode": "backtest", "symbol": "", "timeframe": "",
        "dateStart": None, "dateEnd": None, "dataSource": str(bars), "initialCapital": 100000, "commission": 0.001,
        "positionSize": 100, "params": {},
    }
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONUNBUFFERED"] = "1"
    print(f"exe {exe} sha256 {hashlib.sha256(exe.read_bytes()).hexdigest()}")
    proc = subprocess.run([str(exe), "-m", "quantlab.cli.run_backtest"], input=json.dumps(config).encode("utf-8"),
        cwd=str(exe.parent), env=env, capture_output=True, timeout=600)
    (work / "stdout.json").write_bytes(proc.stdout)
    (work / "stderr.log").write_bytes(proc.stderr)
    print(f"rc {proc.returncode}, stdout {len(proc.stdout)} B, stderr {len(proc.stderr.splitlines())} lines")
    for line in proc.stderr.decode("utf-8", "replace").splitlines()[-3:]:
        print(f"  stderr: {line}")
    if proc.returncode != 0:
        fail(f"engine exited {proc.returncode}")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        fail(f"stdout is not JSON: {e.msg} at {e.pos}")
    if result.get("success") is not True:
        fail(f"success={result.get('success')!r} error={result.get('error')!r}")
    for key in ("equity", "signals", "metrics"):
        if key not in result:
            fail(f"result has no '{key}' (keys: {sorted(result)})")
    equity, signals = len(result["equity"]), len(result["signals"])
    print(f"metrics {result['metrics']}")
    if equity != EXPECTED_EQUITY_POINTS or signals != EXPECTED_SIGNALS:
        fail(f"equity points {equity} (want {EXPECTED_EQUITY_POINTS}), signals {signals} (want {EXPECTED_SIGNALS})")
    print(f"ENGINE-SMOKE PASS stdout-sha256 {hashlib.sha256(proc.stdout).hexdigest()}")


if __name__ == "__main__":
    main()
