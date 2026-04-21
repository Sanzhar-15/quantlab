"""
Strategy State Management.

Provides state serialization and checkpointing for strategies.

Spec Reference: Technical Spec §8.2
"""

import json
import logging
import pickle
import warnings
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from pathlib import Path
from typing import Any


_state_logger = logging.getLogger(__name__)


# FIX-M12: Restricted unpickler for state files
_SAFE_STATE_MODULES = frozenset({
    "builtins",
    "collections",
    "datetime",
    "decimal",
    "quantlab.api.state",
    "quantlab.portfolio.state",
})


class _RestrictedStateUnpickler(pickle.Unpickler):
    """Unpickler that only allows classes from known-safe modules."""

    def find_class(self, module: str, name: str) -> Any:
        if module in _SAFE_STATE_MODULES:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(
            f"Refused to unpickle class {module}.{name}: module not in allowlist"
        )


@dataclass
class StrategyState:
    """
    Serializable strategy state.

    Captures all state needed to resume a strategy.
    Supports both simple test API (params/internal_state) and full API.
    """

    # Simple test API fields (primary)
    params: dict[str, Any] = field(default_factory=dict)
    internal_state: dict[str, Any] = field(default_factory=dict)

    # Strategy identification (optional)
    strategy_name: str = ""
    strategy_version: str = "1.0.0"

    # Position state
    positions: dict[str, Any] = field(default_factory=dict)
    cash: Decimal = Decimal("0")

    # Bar state
    current_bar_index: int = 0
    last_processed_timestamp: datetime | None = None

    # Indicator state (cached indicator values)
    indicator_state: dict[str, Any] = field(default_factory=dict)

    # Order state
    pending_orders: list[dict[str, Any]] = field(default_factory=list)

    # Metadata
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    checkpoint_id: str = ""

    # Backwards compatibility alias
    @property
    def parameters(self) -> dict[str, Any]:
        """Alias for params for backward compatibility."""
        return self.params

    @property
    def custom_state(self) -> dict[str, Any]:
        """Alias for internal_state for backward compatibility."""
        return self.internal_state

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "params": _serialize_value(self.params),
            "internal_state": _serialize_value(self.internal_state),
            "strategy_name": self.strategy_name,
            "strategy_version": self.strategy_version,
            "positions": _serialize_value(self.positions),
            "cash": str(self.cash),
            "current_bar_index": self.current_bar_index,
            "last_processed_timestamp": (
                self.last_processed_timestamp.isoformat()
                if self.last_processed_timestamp
                else None
            ),
            "indicator_state": _serialize_value(self.indicator_state),
            "pending_orders": _serialize_value(self.pending_orders),
            "created_at": self.created_at.isoformat(),
            "checkpoint_id": self.checkpoint_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StrategyState":
        """Create from dictionary."""
        # Support both old (parameters/custom_state) and new (params/internal_state) keys
        params = data.get("params", data.get("parameters", {}))
        internal_state = data.get("internal_state", data.get("custom_state", {}))

        created_at = data.get("created_at")
        if created_at and isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        else:
            created_at = datetime.now(timezone.utc)

        return cls(
            params=_deserialize_value(params),
            internal_state=_deserialize_value(internal_state),
            strategy_name=data.get("strategy_name", ""),
            strategy_version=data.get("strategy_version", "1.0.0"),
            positions=_deserialize_value(data.get("positions", {})),
            cash=Decimal(data.get("cash", "0")),
            current_bar_index=data.get("current_bar_index", 0),
            last_processed_timestamp=(
                datetime.fromisoformat(data["last_processed_timestamp"])
                if data.get("last_processed_timestamp")
                else None
            ),
            indicator_state=_deserialize_value(data.get("indicator_state", {})),
            pending_orders=_deserialize_value(data.get("pending_orders", [])),
            created_at=created_at,
            checkpoint_id=data.get("checkpoint_id", ""),
        )


def _serialize_value(value: Any) -> Any:
    """Serialize a value for JSON."""
    if isinstance(value, Decimal):
        return {"__decimal__": str(value)}
    elif isinstance(value, datetime):
        return {"__datetime__": value.isoformat()}
    elif isinstance(value, dict):
        return {k: _serialize_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_serialize_value(v) for v in value]
    elif hasattr(value, "to_dict"):
        return {"__class__": type(value).__name__, "data": value.to_dict()}
    return value


def _deserialize_value(value: Any) -> Any:
    """Deserialize a value from JSON."""
    if isinstance(value, dict):
        if "__decimal__" in value:
            return Decimal(value["__decimal__"])
        elif "__datetime__" in value:
            return datetime.fromisoformat(value["__datetime__"])
        elif "__class__" in value:
            # Would need class registry for full deserialization
            return value["data"]
        return {k: _deserialize_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_deserialize_value(v) for v in value]
    return value


class StateManager:
    """
    Manage strategy state persistence.

    Handles checkpointing and recovery.
    """

    def __init__(
        self,
        state_dir: Path | str | None = None,
        use_pickle: bool = False,
    ) -> None:
        """
        Initialize state manager.

        Args:
            state_dir: Directory for state files
            use_pickle: Use pickle instead of JSON
        """
        if state_dir:
            self.state_dir = Path(state_dir)
            self.state_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.state_dir = None

        self.use_pickle = use_pickle
        self._checkpoint_counter = 0
        self._state_index: dict[str, Path] = {}  # state_id -> filepath

    def _generate_checkpoint_id(self) -> str:
        """Generate unique checkpoint ID."""
        import uuid
        return str(uuid.uuid4())

    def save_state(
        self,
        strategy_name_or_state: str | StrategyState,
        state: StrategyState | None = None,
        filename: str | None = None,
    ) -> str | Path | None:
        """
        Save strategy state to file.

        Supports two call signatures:
        - save_state(strategy_name, state) -> returns state_id (test API)
        - save_state(state) -> returns Path (legacy API)

        Args:
            strategy_name_or_state: Strategy name or state object
            state: State to save (if first arg is strategy_name)
            filename: Optional filename (auto-generated if not provided)

        Returns:
            state_id string (test API) or Path (legacy API)
        """
        if self.state_dir is None:
            return None

        # Determine which API is being used
        if isinstance(strategy_name_or_state, str) and state is not None:
            # Test API: save_state(strategy_name, state)
            strategy_name = strategy_name_or_state
            state_obj = state
            use_test_api = True
        elif isinstance(strategy_name_or_state, StrategyState):
            # Legacy API: save_state(state)
            state_obj = strategy_name_or_state
            strategy_name = state_obj.strategy_name or "unknown"
            use_test_api = False
        else:
            return None

        # Generate checkpoint ID if not set
        state_id = self._generate_checkpoint_id()
        state_obj.checkpoint_id = state_id
        state_obj.strategy_name = strategy_name

        ext = ".pkl" if self.use_pickle else ".json"
        if filename is None:
            filename = f"{strategy_name}_{state_id}{ext}"

        filepath = self.state_dir / filename

        if self.use_pickle:
            with open(filepath, "wb") as f:
                pickle.dump(state_obj, f)
        else:
            data = state_obj.to_dict()
            data["state_id"] = state_id
            with open(filepath, "w") as f:
                json.dump(data, f, indent=2)

        # Index for lookup by state_id
        self._state_index[state_id] = filepath

        if use_test_api:
            return state_id
        else:
            return filepath

    def load_state(self, state_id_or_filepath: str | Path) -> StrategyState | None:
        """
        Load strategy state from file.

        Supports two call signatures:
        - load_state(state_id) -> loads by state ID (test API)
        - load_state(filepath) -> loads by path (legacy API)

        Args:
            state_id_or_filepath: State ID or path to state file

        Returns:
            StrategyState or None if not found
        """
        # Check if it's a path that exists
        if isinstance(state_id_or_filepath, Path) or (
            isinstance(state_id_or_filepath, str) and
            (state_id_or_filepath.endswith(".json") or state_id_or_filepath.endswith(".pkl"))
        ):
            # Legacy API: load by path
            filepath = Path(state_id_or_filepath)
            if not filepath.exists():
                return None
            return self._load_from_path(filepath)

        # Test API: load by state_id
        state_id = state_id_or_filepath

        # Check index first
        if state_id in self._state_index:
            filepath = self._state_index[state_id]
            if filepath.exists():
                return self._load_from_path(filepath)

        # Search for file with this state_id
        if self.state_dir:
            for filepath in self.state_dir.glob("*.json"):
                try:
                    with open(filepath, "r") as f:
                        data = json.load(f)
                        if data.get("state_id") == state_id or data.get("checkpoint_id") == state_id:
                            self._state_index[state_id] = filepath
                            return StrategyState.from_dict(data)
                except (json.JSONDecodeError, IOError):
                    continue

        return None

    def _load_from_path(self, filepath: Path) -> StrategyState:
        """Load state from a specific file path."""
        if filepath.suffix == ".pkl":
            _state_logger.warning("Loading pickle state file (deprecated): %s", filepath)
            with open(filepath, "rb") as f:
                return _RestrictedStateUnpickler(f).load()
        else:
            with open(filepath) as f:
                data = json.load(f)
            return StrategyState.from_dict(data)

    def load_latest(self, strategy_name: str) -> StrategyState | None:
        """
        Load latest checkpoint for a strategy.

        Args:
            strategy_name: Strategy name

        Returns:
            Latest state or None
        """
        if self.state_dir is None:
            return None

        ext = ".pkl" if self.use_pickle else ".json"
        pattern = f"{strategy_name}_ckpt_*{ext}"

        files = sorted(self.state_dir.glob(pattern))
        if not files:
            return None

        return self.load_state(files[-1])

    def list_checkpoints(
        self,
        strategy_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        List available checkpoints.

        Args:
            strategy_name: Filter by strategy name

        Returns:
            List of checkpoint metadata dicts
        """
        if self.state_dir is None:
            return []

        checkpoints = []

        # Search all JSON files
        for filepath in self.state_dir.glob("*.json"):
            try:
                with open(filepath, "r") as f:
                    data = json.load(f)

                    # Filter by strategy name if specified
                    file_strategy = data.get("strategy_name", "")
                    if strategy_name and file_strategy != strategy_name:
                        continue

                    checkpoints.append({
                        "state_id": data.get("state_id", data.get("checkpoint_id", "")),
                        "strategy_name": file_strategy,
                        "timestamp": data.get("created_at"),
                        "filepath": str(filepath),
                    })
            except (json.JSONDecodeError, IOError):
                continue

        # Also check pickle files (legacy format)
        for filepath in self.state_dir.glob("*.pkl"):
            try:
                with open(filepath, "rb") as f:
                    state = _RestrictedStateUnpickler(f).load()
                    if strategy_name and state.strategy_name != strategy_name:
                        continue
                    checkpoints.append({
                        "state_id": state.checkpoint_id,
                        "strategy_name": state.strategy_name,
                        "timestamp": state.created_at.isoformat() if state.created_at else None,
                        "filepath": str(filepath),
                    })
            except Exception:
                continue

        # Sort by timestamp descending
        checkpoints.sort(key=lambda x: x.get("timestamp", "") or "", reverse=True)

        return checkpoints

    def list_checkpoint_paths(
        self,
        strategy_name: str | None = None,
    ) -> list[Path]:
        """
        List available checkpoint file paths (legacy API).

        Args:
            strategy_name: Filter by strategy name

        Returns:
            List of checkpoint file paths
        """
        if self.state_dir is None:
            return []

        files = []
        for ext in [".json", ".pkl"]:
            if strategy_name:
                pattern = f"{strategy_name}_*{ext}"
            else:
                pattern = f"*{ext}"
            files.extend(self.state_dir.glob(pattern))

        return sorted(files)

    def delete_checkpoint(self, filepath: Path | str) -> bool:
        """
        Delete a checkpoint file.

        Args:
            filepath: Path to delete

        Returns:
            True if deleted
        """
        filepath = Path(filepath)
        if filepath.exists():
            filepath.unlink()
            return True
        return False

    def cleanup_old_checkpoints(
        self,
        strategy_name: str,
        keep_count: int = 5,
    ) -> int:
        """
        Remove old checkpoints, keeping only the most recent.

        Args:
            strategy_name: Strategy name
            keep_count: Number of checkpoints to keep

        Returns:
            Number of checkpoints deleted
        """
        checkpoints = self.list_checkpoints(strategy_name)

        if len(checkpoints) <= keep_count:
            return 0

        to_delete = checkpoints[keep_count:]
        deleted = 0

        # FIX-M6: list_checkpoints returns dicts, extract filepath for delete_checkpoint
        for checkpoint in to_delete:
            path = checkpoint["filepath"] if isinstance(checkpoint, dict) else checkpoint
            if self.delete_checkpoint(path):
                deleted += 1

        return deleted


class StateCapture:
    """
    Capture strategy state during execution.

    Mixin or context manager for strategies.
    """

    def __init__(self) -> None:
        self._custom_state: dict[str, Any] = {}
        self._indicator_cache: dict[str, Any] = {}

    def set_state(self, key: str, value: Any) -> None:
        """Set custom state value."""
        self._custom_state[key] = value

    def get_state(self, key: str, default: Any = None) -> Any:
        """Get custom state value."""
        return self._custom_state.get(key, default)

    def cache_indicator(self, name: str, value: Any) -> None:
        """Cache indicator value for checkpointing."""
        self._indicator_cache[name] = value

    def get_cached_indicator(self, name: str) -> Any | None:
        """Get cached indicator value."""
        return self._indicator_cache.get(name)

    def capture_state(self, strategy_name: str) -> StrategyState:
        """
        Capture current state.

        Args:
            strategy_name: Name of the strategy

        Returns:
            StrategyState with current values
        """
        return StrategyState(
            strategy_name=strategy_name,
            internal_state=self._custom_state.copy(),
            indicator_state=self._indicator_cache.copy(),
        )

    def restore_state(self, state: StrategyState) -> None:
        """
        Restore state from checkpoint.

        Args:
            state: State to restore
        """
        self._custom_state = state.custom_state.copy()
        self._indicator_cache = state.indicator_state.copy()
