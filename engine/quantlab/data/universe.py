"""
Universe Revision (UniverseRev) System.

Manages stock/security universes with point-in-time support.

Spec Reference: Technical Spec §5.3
"""

import json
from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any
from typing import Iterator

from quantlab.data.hash import hash_bytes_quick


class UniverseType(Enum):
    """Types of universes."""

    STATIC = "static"  # Fixed list of symbols
    DYNAMIC = "dynamic"  # Changes over time
    INDEX = "index"  # Based on an index (SPY, QQQ)
    CUSTOM = "custom"  # User-defined rules


class MembershipChangeType(Enum):
    """Types of membership changes."""

    ADDED = "added"
    REMOVED = "removed"
    RENAMED = "renamed"  # Symbol changed (e.g., FB -> META)
    MERGED = "merged"  # Acquired by another company
    SPINOFF = "spinoff"  # Spun off from parent
    DELISTED = "delisted"  # No longer traded

    # Aliases for test compatibility
    ADD = "added"
    REMOVE = "removed"


@dataclass
class MembershipChange:
    """Record of a universe membership change."""

    symbol: str = ""
    change_type: MembershipChangeType = MembershipChangeType.ADD
    effective_date: date | None = None
    new_symbol: str | None = None  # For renames
    reason: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "date": self.effective_date.isoformat() if self.effective_date else None,
            "change_type": self.change_type.value,
            "symbol": self.symbol,
            "new_symbol": self.new_symbol,
            "reason": self.reason,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MembershipChange":
        """Create from dictionary."""
        return cls(
            effective_date=date.fromisoformat(data["date"]) if data.get("date") else None,
            change_type=MembershipChangeType(data["change_type"]),
            symbol=data["symbol"],
            new_symbol=data.get("new_symbol"),
            reason=data.get("reason", ""),
            metadata=data.get("metadata", {}),
        )


@dataclass
class UniverseSnapshot:
    """
    Snapshot of universe at a point in time.

    Represents the exact membership on a specific date.
    """

    date: date
    symbols: frozenset[str]
    hash_value: str  # Hash of sorted symbols

    def __contains__(self, symbol: str) -> bool:
        """Check if symbol in universe."""
        return symbol in self.symbols

    def __len__(self) -> int:
        """Number of symbols."""
        return len(self.symbols)

    def __iter__(self) -> Iterator[str]:
        """Iterate symbols."""
        return iter(sorted(self.symbols))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "date": self.date.isoformat(),
            "symbols": sorted(self.symbols),
            "hash": self.hash_value,
        }


@dataclass
class UniverseRev:
    """
    Universe Revision - versioned universe definition.

    Supports both static universes and point-in-time dynamic universes.
    """

    # Identification (support both universe_id and rev_id)
    name: str
    universe_id: str | None = None
    rev_id: str | None = None
    description: str = ""

    # Type
    universe_type: UniverseType = UniverseType.STATIC

    # Base date and symbols
    base_date: date | None = None
    base_symbols: set[str] = field(default_factory=set)

    # Membership changes (for dynamic universes)
    changes: list[MembershipChange] = field(default_factory=list)

    # Index reference (for index-based universes)
    index_symbol: str | None = None

    # Time bounds
    start_date: date | None = None
    end_date: date | None = None

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    created_by: str = ""
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # Cached snapshots
    _snapshot_cache: dict[date, UniverseSnapshot] = field(
        default_factory=dict, repr=False
    )

    def __post_init__(self) -> None:
        """Handle parameter aliases."""
        # Unify universe_id and rev_id
        if self.universe_id is None and self.rev_id is not None:
            self.universe_id = self.rev_id
        elif self.rev_id is None and self.universe_id is not None:
            self.rev_id = self.universe_id

    def get_symbols(self, as_of: date | None = None) -> set[str]:
        """
        Get universe symbols as of a specific date.

        Args:
            as_of: Date to get symbols for (None = current)

        Returns:
            Set of symbols
        """
        if self.universe_type == UniverseType.STATIC:
            return self.base_symbols.copy()

        # Dynamic universe - apply changes
        as_of = as_of or date.today()
        symbols = self.base_symbols.copy()

        for change in sorted(self.changes, key=lambda c: c.effective_date or date.min):
            if change.effective_date is None or change.effective_date > as_of:
                break

            if change.change_type == MembershipChangeType.ADDED:
                symbols.add(change.symbol)
            elif change.change_type in (
                MembershipChangeType.REMOVED,
                MembershipChangeType.DELISTED,
                MembershipChangeType.MERGED,
            ):
                symbols.discard(change.symbol)
            elif change.change_type == MembershipChangeType.RENAMED:
                symbols.discard(change.symbol)
                if change.new_symbol:
                    symbols.add(change.new_symbol)
            elif change.change_type == MembershipChangeType.SPINOFF:
                # Spinoff adds new symbol, keeps parent
                if change.new_symbol:
                    symbols.add(change.new_symbol)

        return symbols

    def get_snapshot(self, as_of: date) -> UniverseSnapshot:
        """
        Get cached snapshot for a date.

        Args:
            as_of: Date for snapshot

        Returns:
            UniverseSnapshot
        """
        if as_of in self._snapshot_cache:
            return self._snapshot_cache[as_of]

        symbols = self.get_symbols(as_of)
        symbols_frozen = frozenset(symbols)

        # Hash sorted symbols for quick comparison
        sorted_symbols = ",".join(sorted(symbols))
        hash_value = hash_bytes_quick(sorted_symbols.encode())[:20]

        snapshot = UniverseSnapshot(
            date=as_of,
            symbols=symbols_frozen,
            hash_value=hash_value,
        )

        self._snapshot_cache[as_of] = snapshot
        return snapshot

    def contains(self, symbol: str, as_of: date | None = None) -> bool:
        """
        Check if symbol is in universe.

        Args:
            symbol: Symbol to check
            as_of: Date to check (None = current)

        Returns:
            True if in universe
        """
        return symbol in self.get_symbols(as_of)

    def add_change(self, change: MembershipChange) -> None:
        """
        Add a membership change.

        Args:
            change: MembershipChange to add
        """
        self.changes.append(change)
        # Invalidate cache for dates >= change effective_date
        if change.effective_date is not None:
            self._snapshot_cache = {
                d: s for d, s in self._snapshot_cache.items()
                if d < change.effective_date
            }
        else:
            # No effective_date - clear entire cache to be safe
            self._snapshot_cache.clear()

    def get_changes_between(
        self,
        start: date,
        end: date,
    ) -> list[MembershipChange]:
        """
        Get all changes between two dates.

        Args:
            start: Start date (inclusive)
            end: End date (inclusive)

        Returns:
            List of changes
        """
        return [
            c for c in self.changes
            if c.effective_date is not None and start <= c.effective_date <= end
        ]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "rev_id": self.rev_id,
            "name": self.name,
            "description": self.description,
            "universe_type": self.universe_type.value,
            "base_symbols": sorted(self.base_symbols),
            "changes": [c.to_dict() for c in self.changes],
            "index_symbol": self.index_symbol,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
            "tags": self.tags,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UniverseRev":
        """Create from dictionary."""
        return cls(
            rev_id=data["rev_id"],
            name=data["name"],
            description=data.get("description", ""),
            universe_type=UniverseType(data.get("universe_type", "static")),
            base_symbols=set(data.get("base_symbols", [])),
            changes=[
                MembershipChange.from_dict(c)
                for c in data.get("changes", [])
            ],
            index_symbol=data.get("index_symbol"),
            start_date=date.fromisoformat(data["start_date"]) if data.get("start_date") else None,
            end_date=date.fromisoformat(data["end_date"]) if data.get("end_date") else None,
            created_at=datetime.fromisoformat(data["created_at"]),
            created_by=data.get("created_by", ""),
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
        )


class UniverseBuilder:
    """
    Builder for creating universe revisions.

    Provides convenient methods for common universe types.
    """

    def __init__(self) -> None:
        self._rev_counter = 0

    def _generate_rev_id(self) -> str:
        """Generate unique revision ID."""
        self._rev_counter += 1
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"univ-{timestamp}-{self._rev_counter:04d}"

    def static(
        self,
        name: str,
        symbols: list[str],
        description: str = "",
    ) -> UniverseRev:
        """
        Create a static universe.

        Args:
            name: Universe name
            symbols: List of symbols
            description: Description

        Returns:
            UniverseRev
        """
        return UniverseRev(
            rev_id=self._generate_rev_id(),
            name=name,
            description=description,
            universe_type=UniverseType.STATIC,
            base_symbols=set(symbols),
        )

    def dynamic(
        self,
        name: str,
        initial_symbols: list[str],
        start_date: date,
        description: str = "",
    ) -> UniverseRev:
        """
        Create a dynamic universe.

        Args:
            name: Universe name
            initial_symbols: Initial symbol list
            start_date: Universe start date
            description: Description

        Returns:
            UniverseRev
        """
        return UniverseRev(
            rev_id=self._generate_rev_id(),
            name=name,
            description=description,
            universe_type=UniverseType.DYNAMIC,
            base_symbols=set(initial_symbols),
            start_date=start_date,
        )

    def index_based(
        self,
        name: str,
        index_symbol: str,
        components: list[str],
        as_of_date: date,
        description: str = "",
    ) -> UniverseRev:
        """
        Create an index-based universe.

        Args:
            name: Universe name
            index_symbol: Index symbol (e.g., SPY, QQQ)
            components: Index components as of the given date
            as_of_date: Reference date for components
            description: Description

        Returns:
            UniverseRev
        """
        return UniverseRev(
            rev_id=self._generate_rev_id(),
            name=name,
            description=description,
            universe_type=UniverseType.INDEX,
            base_symbols=set(components),
            index_symbol=index_symbol,
            start_date=as_of_date,
        )


class UniverseStore:
    """
    Storage for universe revisions.

    Persists universes to disk.
    """

    def __init__(self, store_path: Path | str) -> None:
        """
        Initialize universe store.

        Args:
            store_path: Path to store directory
        """
        self.store_path = Path(store_path)
        self.store_path.mkdir(parents=True, exist_ok=True)
        self._index_path = self.store_path / "index.json"
        self._index: dict[str, str] = {}
        self._load_index()

    def _load_index(self) -> None:
        """Load index from disk."""
        if self._index_path.exists():
            with open(self._index_path) as f:
                self._index = json.load(f)

    def _save_index(self) -> None:
        """Save index to disk."""
        with open(self._index_path, "w") as f:
            json.dump(self._index, f, indent=2)

    def save(self, universe: UniverseRev) -> None:
        """Save a universe revision."""
        filename = f"{universe.rev_id}.json"
        filepath = self.store_path / filename

        with open(filepath, "w") as f:
            json.dump(universe.to_dict(), f, indent=2)

        self._index[universe.rev_id] = filename
        self._save_index()

    def load(self, rev_id: str) -> UniverseRev | None:
        """Load a universe by ID."""
        if rev_id not in self._index:
            return None

        filepath = self.store_path / self._index[rev_id]
        if not filepath.exists():
            return None

        with open(filepath) as f:
            data = json.load(f)

        return UniverseRev.from_dict(data)

    def get_by_name(self, name: str) -> UniverseRev | None:
        """Get latest universe by name."""
        matching = []
        for rev_id in self._index:
            univ = self.load(rev_id)
            if univ and univ.name == name:
                matching.append(univ)

        if not matching:
            return None

        return max(matching, key=lambda u: u.created_at)

    def list_universes(self) -> list[str]:
        """List all universe names."""
        names = set()
        for rev_id in self._index:
            univ = self.load(rev_id)
            if univ:
                names.add(univ.name)
        return sorted(names)


# Predefined universes
class PredefinedUniverses:
    """Factory for common predefined universes."""

    @staticmethod
    def sp500() -> UniverseRev:
        """Create S&P 500 universe placeholder."""
        builder = UniverseBuilder()
        return builder.index_based(
            name="SP500",
            index_symbol="SPY",
            components=[],  # Would be populated from data source
            as_of_date=date.today(),
            description="S&P 500 Index Components",
        )

    @staticmethod
    def nasdaq100() -> UniverseRev:
        """Create NASDAQ 100 universe placeholder."""
        builder = UniverseBuilder()
        return builder.index_based(
            name="NDX100",
            index_symbol="QQQ",
            components=[],
            as_of_date=date.today(),
            description="NASDAQ 100 Index Components",
        )

    @staticmethod
    def russell2000() -> UniverseRev:
        """Create Russell 2000 universe placeholder."""
        builder = UniverseBuilder()
        return builder.index_based(
            name="RTY2000",
            index_symbol="IWM",
            components=[],
            as_of_date=date.today(),
            description="Russell 2000 Index Components",
        )
