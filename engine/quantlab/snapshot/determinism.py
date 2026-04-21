"""
Determinism Enforcement Module.

Provides utilities for enforcing deterministic execution
when reproducing pinned runs.

Per §8.2:
1. Restore RNG states exactly
2. Disable parallel execution
3. Warn on version mismatches
4. Proceed with best-effort reproduction

Spec Reference: Technical Spec §8.2
"""

import logging
import os
import random
import warnings
from dataclasses import dataclass
from typing import Any

from .environment import EnvironmentSnapshot
from .environment import RandomState


logger = logging.getLogger(__name__)


@dataclass
class VersionMismatch:
    """Record of a version mismatch."""

    component: str
    expected: str
    actual: str
    severity: str  # 'warning', 'error'

    def __str__(self) -> str:
        return f"{self.component}: expected {self.expected}, got {self.actual}"


@dataclass
class ReproductionContext:
    """Context for reproducible execution."""

    snapshot: EnvironmentSnapshot
    mismatches: list[VersionMismatch]
    rng_restored: bool
    parallel_disabled: bool

    @property
    def has_mismatches(self) -> bool:
        """Check if there are any version mismatches."""
        return len(self.mismatches) > 0

    @property
    def has_critical_mismatches(self) -> bool:
        """Check if there are critical mismatches that may affect reproduction."""
        critical = {"quantlab", "numpy", "pandas"}
        return any(
            m.component.lower() in critical and m.severity == "error"
            for m in self.mismatches
        )


def setup_deterministic_execution(
    snapshot: EnvironmentSnapshot,
    strict: bool = False,
) -> ReproductionContext:
    """
    Set up environment for deterministic execution.

    Per §8.2:
    1. Restore RNG states exactly
    2. Disable parallel execution
    3. Warn on version mismatches
    4. Proceed with best-effort reproduction (unless strict)

    Args:
        snapshot: Environment snapshot to reproduce
        strict: If True, raise error on critical mismatches

    Returns:
        ReproductionContext with setup results

    Raises:
        ReproductionError: If strict mode and critical mismatches found
    """
    mismatches: list[VersionMismatch] = []

    # Check versions
    mismatches.extend(_check_version_mismatches(snapshot))

    # Warn about mismatches
    for mismatch in mismatches:
        if mismatch.severity == "error":
            logger.error(f"Version mismatch: {mismatch}")
        else:
            logger.warning(f"Version mismatch: {mismatch}")

    # Restore RNG state
    rng_restored = _restore_random_state(snapshot.random_state)

    # Disable parallel execution
    parallel_disabled = _disable_parallel_execution()

    context = ReproductionContext(
        snapshot=snapshot,
        mismatches=mismatches,
        rng_restored=rng_restored,
        parallel_disabled=parallel_disabled,
    )

    # Check strict mode
    if strict and context.has_critical_mismatches:
        raise ReproductionError(
            "Critical version mismatches found in strict mode",
            mismatches=[m for m in mismatches if m.severity == "error"],
        )

    return context


def _check_version_mismatches(
    snapshot: EnvironmentSnapshot,
) -> list[VersionMismatch]:
    """Check for version mismatches between snapshot and current environment."""
    import sys

    mismatches = []

    # Check Python version
    current_python = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if snapshot.python.version != current_python:
        # Minor version difference is warning, major is error
        snapshot_parts = snapshot.python.version.split(".")
        current_parts = current_python.split(".")

        if snapshot_parts[0] != current_parts[0]:
            severity = "error"
        elif snapshot_parts[1] != current_parts[1]:
            severity = "warning"
        else:
            severity = "warning"

        mismatches.append(
            VersionMismatch(
                component="python",
                expected=snapshot.python.version,
                actual=current_python,
                severity=severity,
            )
        )

    # Check critical packages
    current_packages = _get_current_package_versions()
    critical_packages = {"numpy", "pandas", "scipy"}

    for pkg in snapshot.packages:
        if pkg.name.lower() in critical_packages:
            current_version = current_packages.get(pkg.name.lower(), "not installed")
            if current_version != pkg.version:
                mismatches.append(
                    VersionMismatch(
                        component=pkg.name,
                        expected=pkg.version,
                        actual=current_version,
                        severity="error" if pkg.name.lower() == "numpy" else "warning",
                    )
                )

    return mismatches


def _get_current_package_versions() -> dict[str, str]:
    """Get current installed package versions."""
    packages = {}
    try:
        from importlib.metadata import distributions

        for dist in distributions():
            packages[dist.metadata["Name"].lower()] = dist.metadata["Version"]
    except ImportError:
        pass
    return packages


def _restore_random_state(random_state: RandomState) -> bool:
    """
    Restore random number generator state.

    Args:
        random_state: State to restore

    Returns:
        True if successfully restored
    """
    restored = False

    # Restore Python random state
    if random_state.python_random_state is not None:
        try:
            random.setstate(random_state.python_random_state)
            restored = True
            logger.debug("Restored Python random state")
        except Exception as e:
            logger.warning(f"Failed to restore Python random state: {e}")

    # Restore numpy state
    if random_state.numpy_state is not None:
        try:
            import numpy as np

            np.random.set_state(random_state.numpy_state)
            restored = True
            logger.debug("Restored numpy random state")
        except ImportError:
            logger.warning("numpy not available, cannot restore numpy state")
        except Exception as e:
            logger.warning(f"Failed to restore numpy random state: {e}")

    # If seed is available, use that as fallback
    if random_state.numpy_seed is not None and not restored:
        try:
            import numpy as np

            np.random.seed(random_state.numpy_seed)
            random.seed(random_state.numpy_seed)
            restored = True
            logger.debug(f"Restored RNG from seed: {random_state.numpy_seed}")
        except ImportError:
            random.seed(random_state.numpy_seed)
            restored = True

    return restored


def _disable_parallel_execution() -> bool:
    """
    Disable parallel execution for determinism.

    Sets environment variables to limit parallelism.

    Returns:
        True if successfully disabled
    """
    # Disable OpenMP parallelism
    os.environ["OMP_NUM_THREADS"] = "1"

    # Disable MKL parallelism
    os.environ["MKL_NUM_THREADS"] = "1"

    # Disable OpenBLAS parallelism
    os.environ["OPENBLAS_NUM_THREADS"] = "1"

    # Disable BLIS parallelism
    os.environ["BLIS_NUM_THREADS"] = "1"

    # Disable numexpr parallelism
    os.environ["NUMEXPR_NUM_THREADS"] = "1"

    # Set numpy to not use multiple threads
    try:
        import numpy as np

        # This may not work on all numpy versions
        if hasattr(np, "set_num_threads"):
            np.set_num_threads(1)
    except (ImportError, AttributeError):
        pass

    logger.debug("Disabled parallel execution")
    return True


def set_reproducible_seed(seed: int) -> None:
    """
    Set random seeds for reproducibility.

    Sets seeds for:
    - Python random
    - numpy random
    - torch (if available)

    Args:
        seed: Seed value
    """
    random.seed(seed)

    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass

    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


class ReproductionError(Exception):
    """Error during reproduction setup."""

    def __init__(
        self,
        message: str,
        mismatches: list[VersionMismatch] | None = None,
    ) -> None:
        super().__init__(message)
        self.mismatches = mismatches or []
