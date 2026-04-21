"""Bundle Python engine for distribution.

NEW-BUILD-002: Creates standalone Python distribution using PyInstaller.

Usage:
    python build/python/bundle.py --output .build/dist
    python build/python/bundle.py --output .build/dist --platform linux
"""

import argparse
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

ENGINE_ROOT = Path(__file__).resolve().parent.parent.parent / "engine"

# Modules that need explicit --hidden-import because PyInstaller
# can't discover them through static analysis (dynamic imports, plugins, etc.)
HIDDEN_IMPORTS = [
    "quantlab",
    "quantlab.daemon",
    "quantlab.daemon.main",
    "quantlab.daemon.ipc",
    "quantlab.daemon.lifecycle",
    "quantlab.daemon.checkpoint",
    "quantlab.daemon.power",
    "quantlab.daemon.watchdog",
    "quantlab.backtest",
    "quantlab.backtest.core",
    "quantlab.backtest.fills",
    "quantlab.providers",
    "quantlab.providers.alpaca",
    "quantlab.risk",
    "quantlab.risk.exposure",
    "quantlab.risk.circuit_breaker",
    "quantlab.trading",
    "quantlab.trading.orders",
    "quantlab.trading.positions",
    "quantlab.trading.risk",
    "quantlab.trading.reconciliation",
    "quantlab.trading.drift",
    "quantlab.trading.fills",
    "quantlab.trading.ledger",
    "quantlab.trading.emergency",
    "quantlab.metrics",
    "quantlab.data",
    "quantlab.data.loader",
    "quantlab.protocol",
    "quantlab.protocol.transport",
    "quantlab.protocol.message",
    "quantlab.protocol.reliability",
    "quantlab.secrets",
    "quantlab.audit",
    "quantlab.calendar",
    "quantlab.precision",
]

# Data directories to include in the bundle
DATA_DIRS = [
    "calendars",
    "schemas",
]


def bundle_engine(output_dir: str, platform: str | None = None) -> Path:
    """Bundle the Python engine into a standalone directory.

    Args:
        output_dir: Output directory for bundled engine
        platform: Target platform (linux, darwin, win32). Defaults to current.

    Returns:
        Path to the bundled engine directory
    """
    if platform is None:
        platform = sys.platform

    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)

    entry_point = ENGINE_ROOT / "quantlab" / "daemon" / "__main__.py"
    if not entry_point.exists():
        raise FileNotFoundError(f"Engine entry point not found: {entry_point}")

    # Build PyInstaller command
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", "quantlab-engine",
        "--onedir",
        "--noconfirm",
        "--distpath", str(output_path),
        "--workpath", str(output_path / "_work"),
        "--specpath", str(output_path / "_spec"),
    ]

    # Add hidden imports
    for module in HIDDEN_IMPORTS:
        cmd.extend(["--hidden-import", module])

    # Add data directories
    for data_dir in DATA_DIRS:
        src = ENGINE_ROOT / data_dir
        if src.exists():
            separator = ";" if platform == "win32" else ":"
            cmd.extend(["--add-data", f"{src}{separator}{data_dir}"])

    # Platform-specific options
    if platform == "win32":
        cmd.extend(["--console"])  # Console app for daemon
    else:
        cmd.extend(["--strip"])  # Strip debug symbols on Unix

    # Entry point
    cmd.append(str(entry_point))

    logger.info("Running PyInstaller: %s", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(ENGINE_ROOT), capture_output=True, text=True)

    if result.returncode != 0:
        logger.error("PyInstaller failed:\n%s", result.stderr)
        raise RuntimeError(f"PyInstaller failed with exit code {result.returncode}")

    bundle_path = output_path / "quantlab-engine"
    logger.info("Engine bundled to: %s", bundle_path)

    # Clean up work/spec directories
    work_dir = output_path / "_work"
    spec_dir = output_path / "_spec"
    if work_dir.exists():
        import shutil
        shutil.rmtree(work_dir, ignore_errors=True)
    if spec_dir.exists():
        import shutil
        shutil.rmtree(spec_dir, ignore_errors=True)

    return bundle_path


def verify_bundle(bundle_path: Path) -> bool:
    """Verify the bundled engine works.

    Args:
        bundle_path: Path to the bundled engine directory

    Returns:
        True if verification passed
    """
    if sys.platform == "win32":
        exe = bundle_path / "quantlab-engine.exe"
    else:
        exe = bundle_path / "quantlab-engine"

    if not exe.exists():
        logger.error("Bundle executable not found: %s", exe)
        return False

    # Try running with --help
    try:
        result = subprocess.run(
            [str(exe), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            logger.info("Bundle verification passed")
            return True
        else:
            logger.error("Bundle verification failed: %s", result.stderr)
            return False
    except subprocess.TimeoutExpired:
        logger.error("Bundle verification timed out")
        return False
    except Exception as e:
        logger.error("Bundle verification error: %s", e)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Bundle Python engine for distribution (NEW-BUILD-002)"
    )
    parser.add_argument(
        "--output",
        default=".build/dist",
        help="Output directory for bundled engine (default: .build/dist)",
    )
    parser.add_argument(
        "--platform",
        choices=["linux", "darwin", "win32"],
        default=None,
        help="Target platform (default: current)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify bundle after building",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    bundle_path = bundle_engine(args.output, args.platform)

    if args.verify:
        if not verify_bundle(bundle_path):
            sys.exit(1)

    print(f"Engine bundled to: {bundle_path}")


if __name__ == "__main__":
    main()
