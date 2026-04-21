"""
Environment Snapshot Module.

Captures environment state for reproducibility including:
- Quantlab and Python versions
- Package dependencies
- System information
- Random state (numpy, python)

Spec Reference: Technical Spec §8.1, §8.2
"""

import hashlib
import json
import platform
import random
import sys
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any


@dataclass
class PackageVersion:
    """Package version information."""

    name: str
    version: str
    source: str = "pip"  # pip, conda, local

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "version": self.version,
            "source": self.source,
        }


@dataclass
class PythonInfo:
    """Python environment information."""

    version: str
    source: str  # 'bundled', 'venv', 'conda', 'system'
    executable: str
    prefix: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "version": self.version,
            "source": self.source,
            "executable": self.executable,
            "prefix": self.prefix,
        }


@dataclass
class SystemInfo:
    """System information."""

    os: str
    os_version: str
    architecture: str
    processor: str
    hostname: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "os": self.os,
            "osVersion": self.os_version,
            "architecture": self.architecture,
            "processor": self.processor,
            "hostname": self.hostname,
        }


@dataclass
class RandomState:
    """Random number generator state for reproducibility."""

    numpy_seed: int | None = None
    numpy_state: Any = None  # np.random.get_state() result
    python_random_state: Any = None  # random.getstate() result

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary (serializable form)."""
        return {
            "numpySeed": self.numpy_seed,
            "numpyState": _serialize_numpy_state(self.numpy_state),
            "pythonRandomState": _serialize_python_state(self.python_random_state),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RandomState":
        """Create from dictionary."""
        return cls(
            numpy_seed=data.get("numpySeed"),
            numpy_state=_deserialize_numpy_state(data.get("numpyState")),
            python_random_state=_deserialize_python_state(
                data.get("pythonRandomState")
            ),
        )


@dataclass
class EnvironmentSnapshot:
    """
    Complete environment snapshot for reproducibility.

    Per §8.1, captures all information needed to reproduce a run.
    """

    quantlab_version: str
    engine_version: str
    python: PythonInfo
    packages: list[PackageVersion]
    system: SystemInfo
    random_state: RandomState
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    snapshot_hash: str = ""

    def compute_hash(self) -> str:
        """Compute hash of environment snapshot."""
        data = json.dumps(
            {
                "quantlab_version": self.quantlab_version,
                "engine_version": self.engine_version,
                "python_version": self.python.version,
                "packages": sorted(
                    [f"{p.name}=={p.version}" for p in self.packages]
                ),
                "os": self.system.os,
                "architecture": self.system.architecture,
            },
            sort_keys=True,
        )
        self.snapshot_hash = hashlib.sha256(data.encode()).hexdigest()[:20]
        return self.snapshot_hash

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "quantlabVersion": self.quantlab_version,
            "engineVersion": self.engine_version,
            "python": self.python.to_dict(),
            "packages": [p.to_dict() for p in self.packages],
            "system": self.system.to_dict(),
            "randomState": self.random_state.to_dict(),
            "createdAt": self.created_at.isoformat(),
            "snapshotHash": self.snapshot_hash,
        }

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def save(self, output_path: Path) -> Path:
        """Save snapshot to file."""
        snapshot_path = output_path / "environment.json"
        with open(snapshot_path, "w", encoding="utf-8") as f:
            f.write(self.to_json())
        return snapshot_path

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EnvironmentSnapshot":
        """Create from dictionary."""
        python_data = data["python"]
        system_data = data["system"]

        packages = [
            PackageVersion(
                name=p["name"],
                version=p["version"],
                source=p.get("source", "pip"),
            )
            for p in data.get("packages", [])
        ]

        created_at = data.get("createdAt", "")
        if created_at:
            created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        else:
            created_at = datetime.now(timezone.utc)

        return cls(
            quantlab_version=data.get("quantlabVersion", ""),
            engine_version=data.get("engineVersion", ""),
            python=PythonInfo(
                version=python_data.get("version", ""),
                source=python_data.get("source", "system"),
                executable=python_data.get("executable", ""),
                prefix=python_data.get("prefix", ""),
            ),
            packages=packages,
            system=SystemInfo(
                os=system_data.get("os", ""),
                os_version=system_data.get("osVersion", ""),
                architecture=system_data.get("architecture", ""),
                processor=system_data.get("processor", ""),
                hostname=system_data.get("hostname", ""),
            ),
            random_state=RandomState.from_dict(data.get("randomState", {})),
            created_at=created_at,
            snapshot_hash=data.get("snapshotHash", ""),
        )

    @classmethod
    def load(cls, snapshot_path: Path) -> "EnvironmentSnapshot":
        """Load snapshot from file."""
        with open(snapshot_path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


def capture_environment(
    quantlab_version: str = "10.0.0",
    engine_version: str = "10.0.0",
    include_random_state: bool = True,
) -> EnvironmentSnapshot:
    """
    Capture current environment snapshot.

    Args:
        quantlab_version: Quantlab version string
        engine_version: Engine version string
        include_random_state: Whether to capture RNG state

    Returns:
        EnvironmentSnapshot
    """
    # Capture Python info
    python_info = PythonInfo(
        version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        source=_detect_python_source(),
        executable=sys.executable,
        prefix=sys.prefix,
    )

    # Capture system info
    system_info = SystemInfo(
        os=platform.system(),
        os_version=platform.release(),
        architecture=platform.machine(),
        processor=platform.processor(),
        hostname=platform.node(),
    )

    # Capture packages
    packages = _get_installed_packages()

    # Capture random state
    random_state = RandomState()
    if include_random_state:
        random_state = _capture_random_state()

    snapshot = EnvironmentSnapshot(
        quantlab_version=quantlab_version,
        engine_version=engine_version,
        python=python_info,
        packages=packages,
        system=system_info,
        random_state=random_state,
    )

    snapshot.compute_hash()
    return snapshot


def _detect_python_source() -> str:
    """Detect Python environment source."""
    if hasattr(sys, "real_prefix"):
        return "venv"
    if "conda" in sys.prefix.lower() or "conda" in sys.executable.lower():
        return "conda"
    if sys.prefix != sys.base_prefix:
        return "venv"
    return "system"


def _get_installed_packages() -> list[PackageVersion]:
    """Get list of installed packages."""
    packages = []

    try:
        from importlib.metadata import distributions

        for dist in distributions():
            packages.append(
                PackageVersion(
                    name=dist.metadata["Name"],
                    version=dist.metadata["Version"],
                    source="pip",
                )
            )
    except ImportError:
        pass

    return sorted(packages, key=lambda p: p.name.lower())


def _capture_random_state() -> RandomState:
    """Capture current random state."""
    state = RandomState()

    # Python random state
    state.python_random_state = random.getstate()

    # Numpy state if available
    try:
        import numpy as np

        state.numpy_state = np.random.get_state()
    except ImportError:
        pass

    return state


def _serialize_numpy_state(state: Any) -> Any:
    """Serialize numpy random state to JSON-compatible format."""
    if state is None:
        return None

    try:
        # numpy state is a tuple: (name, array, pos, has_gauss, cached_gauss)
        name, arr, pos, has_gauss, cached_gauss = state
        return {
            "name": name,
            "state": arr.tolist() if hasattr(arr, "tolist") else list(arr),
            "pos": int(pos),
            "hasGauss": int(has_gauss),
            "cachedGauss": float(cached_gauss),
        }
    except Exception:
        return None


def _deserialize_numpy_state(data: Any) -> Any:
    """Deserialize numpy random state from JSON format."""
    if data is None:
        return None

    try:
        import numpy as np

        return (
            data["name"],
            np.array(data["state"], dtype=np.uint32),
            data["pos"],
            data["hasGauss"],
            data["cachedGauss"],
        )
    except Exception:
        return None


def _serialize_python_state(state: Any) -> Any:
    """Serialize Python random state."""
    if state is None:
        return None

    try:
        version, internal_state, gauss_next = state
        return {
            "version": version,
            "state": list(internal_state),
            "gaussNext": gauss_next,
        }
    except Exception:
        return None


def _deserialize_python_state(data: Any) -> Any:
    """Deserialize Python random state."""
    if data is None:
        return None

    try:
        return (
            data["version"],
            tuple(data["state"]),
            data["gaussNext"],
        )
    except Exception:
        return None
