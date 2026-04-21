"""
Position Reconciliation.

Provides position verification and reconciliation between
local tracking and broker state.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

import logging
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from .broker import BrokerAdapter
from .positions import PositionTracker


logger = logging.getLogger(__name__)


class DiscrepancyType(Enum):
    """Type of position discrepancy."""

    MISSING_LOCAL = "missing_local"  # Position exists at broker but not locally
    MISSING_BROKER = "missing_broker"  # Position exists locally but not at broker
    QUANTITY_MISMATCH = "quantity_mismatch"  # Quantities don't match
    PRICE_DRIFT = "price_drift"  # Average cost differs significantly


class ReconciliationAction(Enum):
    """Action to take for reconciliation."""

    SYNC_FROM_BROKER = "sync_from_broker"  # Update local to match broker
    SYNC_TO_BROKER = "sync_to_broker"  # Update broker to match local (dangerous)
    ALERT_ONLY = "alert_only"  # Just alert, don't auto-correct
    NO_ACTION = "no_action"  # No action needed


@dataclass
class PositionDiscrepancy:
    """A single position discrepancy."""

    symbol: str
    discrepancy_type: DiscrepancyType
    local_quantity: Decimal | None
    broker_quantity: Decimal | None
    local_avg_cost: Decimal | None
    broker_avg_cost: Decimal | None
    recommended_action: ReconciliationAction
    details: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "discrepancyType": self.discrepancy_type.value,
            "localQuantity": str(self.local_quantity) if self.local_quantity else None,
            "brokerQuantity": str(self.broker_quantity)
            if self.broker_quantity
            else None,
            "localAvgCost": str(self.local_avg_cost) if self.local_avg_cost else None,
            "brokerAvgCost": str(self.broker_avg_cost)
            if self.broker_avg_cost
            else None,
            "recommendedAction": self.recommended_action.value,
            "details": self.details,
        }


@dataclass
class ReconciliationResult:
    """Result of position reconciliation."""

    session_id: str
    timestamp: datetime
    is_reconciled: bool
    discrepancies: list[PositionDiscrepancy] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    corrections_applied: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def has_discrepancies(self) -> bool:
        """Check if there are any discrepancies."""
        return len(self.discrepancies) > 0

    @property
    def discrepancy_count(self) -> int:
        """Get number of discrepancies."""
        return len(self.discrepancies)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sessionId": self.session_id,
            "timestamp": self.timestamp.isoformat(),
            "isReconciled": self.is_reconciled,
            "discrepancyCount": self.discrepancy_count,
            "discrepancies": [d.to_dict() for d in self.discrepancies],
            "warnings": self.warnings,
            "correctionsApplied": self.corrections_applied,
            "error": self.error,
        }


@dataclass
class ReconciliationConfig:
    """Configuration for reconciliation behavior."""

    # Auto-correction settings
    auto_correct: bool = False  # Automatically apply corrections
    sync_direction: str = "from_broker"  # "from_broker" or "to_broker"

    # Tolerance settings
    quantity_tolerance: Decimal = Decimal("0")  # Exact match required
    price_tolerance_pct: Decimal = Decimal("0.01")  # 1% tolerance on avg cost

    # Behavior
    fail_on_discrepancy: bool = False  # Raise exception on discrepancy
    alert_on_missing_local: bool = True
    alert_on_missing_broker: bool = True


class PositionReconciler:
    """
    Reconciles local position tracking with broker state.

    Compares positions tracked locally with actual positions at the broker
    and identifies discrepancies. Can optionally auto-correct differences.
    """

    def __init__(self, config: ReconciliationConfig | None = None) -> None:
        """
        Initialize reconciler.

        Args:
            config: Reconciliation configuration
        """
        self._config = config or ReconciliationConfig()

    async def reconcile(
        self,
        session_id: str,
        broker: BrokerAdapter,
        position_tracker: PositionTracker,
    ) -> ReconciliationResult:
        """
        Reconcile positions for a session.

        Args:
            session_id: Trading session ID
            broker: Connected broker adapter
            position_tracker: Local position tracker

        Returns:
            ReconciliationResult with discrepancies and actions taken
        """
        result = ReconciliationResult(
            session_id=session_id,
            timestamp=datetime.now(),
            is_reconciled=False,
        )

        try:
            # Get broker positions
            broker_positions = await self._get_broker_positions(broker)

            # Get local positions
            local_positions = self._get_local_positions(session_id, position_tracker)

            # Compare positions
            discrepancies = self._compare_positions(
                local_positions, broker_positions
            )

            result.discrepancies = discrepancies

            # Apply auto-corrections if configured
            if self._config.auto_correct and discrepancies:
                corrections = await self._apply_corrections(
                    session_id,
                    broker,
                    position_tracker,
                    discrepancies,
                )
                result.corrections_applied = corrections

            # Determine final reconciliation status
            result.is_reconciled = len(discrepancies) == 0 or (
                self._config.auto_correct
                and len(result.corrections_applied) == len(discrepancies)
            )

            # Add warnings for specific situations
            if self._config.alert_on_missing_local:
                for d in discrepancies:
                    if d.discrepancy_type == DiscrepancyType.MISSING_LOCAL:
                        result.warnings.append(
                            f"Position {d.symbol} exists at broker but not tracked locally"
                        )

            if self._config.alert_on_missing_broker:
                for d in discrepancies:
                    if d.discrepancy_type == DiscrepancyType.MISSING_BROKER:
                        result.warnings.append(
                            f"Position {d.symbol} tracked locally but not at broker"
                        )

            if self._config.fail_on_discrepancy and discrepancies:
                raise ReconciliationError(
                    f"Position reconciliation failed: {len(discrepancies)} discrepancies"
                )

            logger.info(
                f"Reconciliation complete for session {session_id}: "
                f"{len(discrepancies)} discrepancies, "
                f"{len(result.corrections_applied)} corrections applied"
            )

        except Exception as e:
            result.error = str(e)
            logger.error(f"Reconciliation error: {e}")

        return result

    def auto_correct(
        self,
        result: ReconciliationResult,
        position_tracker: PositionTracker,
    ) -> bool:
        """
        Apply corrections from a reconciliation result.

        This is called when you want to manually apply corrections
        from a previous reconcile() call that had auto_correct=False.

        Args:
            result: Previous reconciliation result
            position_tracker: Position tracker to update

        Returns:
            True if all corrections were applied successfully
        """
        if not result.has_discrepancies:
            return True

        corrections_applied = 0

        for discrepancy in result.discrepancies:
            if discrepancy.recommended_action != ReconciliationAction.SYNC_FROM_BROKER:
                continue

            try:
                if discrepancy.discrepancy_type == DiscrepancyType.MISSING_LOCAL:
                    # Create position from broker
                    position = position_tracker.get_or_create_position(
                        result.session_id, discrepancy.symbol
                    )
                    if discrepancy.broker_quantity:
                        position.quantity = discrepancy.broker_quantity
                    if discrepancy.broker_avg_cost:
                        position.avg_entry_price = discrepancy.broker_avg_cost
                    corrections_applied += 1

                elif discrepancy.discrepancy_type == DiscrepancyType.QUANTITY_MISMATCH:
                    # Update quantity
                    position = position_tracker.get_or_create_position(
                        result.session_id, discrepancy.symbol
                    )
                    if discrepancy.broker_quantity:
                        position.quantity = discrepancy.broker_quantity
                    corrections_applied += 1

                elif discrepancy.discrepancy_type == DiscrepancyType.MISSING_BROKER:
                    # Zero out local position (broker doesn't have it)
                    position = position_tracker.get_position(
                        result.session_id, discrepancy.symbol
                    )
                    if position:
                        position.quantity = Decimal("0")
                    corrections_applied += 1

            except Exception as e:
                logger.error(
                    f"Failed to apply correction for {discrepancy.symbol}: {e}"
                )

        return corrections_applied == len(
            [
                d
                for d in result.discrepancies
                if d.recommended_action == ReconciliationAction.SYNC_FROM_BROKER
            ]
        )

    async def _get_broker_positions(
        self, broker: BrokerAdapter
    ) -> dict[str, dict[str, Any]]:
        """Get positions from broker."""
        try:
            positions = await broker.get_positions()
            return {
                p["symbol"]: {
                    "quantity": Decimal(str(p.get("quantity", 0))),
                    "avg_cost": Decimal(str(p.get("avg_entry_price", 0))),
                }
                for p in positions
            }
        except Exception as e:
            logger.error(f"Failed to get broker positions: {e}")
            return {}

    def _get_local_positions(
        self,
        session_id: str,
        position_tracker: PositionTracker,
    ) -> dict[str, dict[str, Any]]:
        """Get positions from local tracker."""
        positions = position_tracker.get_positions_for_session(
            session_id, include_flat=False
        )
        return {
            p.symbol: {
                "quantity": p.quantity,
                "avg_cost": p.avg_entry_price,
            }
            for p in positions
        }

    def _compare_positions(
        self,
        local: dict[str, dict[str, Any]],
        broker: dict[str, dict[str, Any]],
    ) -> list[PositionDiscrepancy]:
        """Compare local and broker positions."""
        discrepancies = []

        # All symbols from both sides
        all_symbols = set(local.keys()) | set(broker.keys())

        for symbol in all_symbols:
            local_pos = local.get(symbol)
            broker_pos = broker.get(symbol)

            discrepancy = self._compare_single_position(
                symbol, local_pos, broker_pos
            )
            if discrepancy:
                discrepancies.append(discrepancy)

        return discrepancies

    def _compare_single_position(
        self,
        symbol: str,
        local: dict[str, Any] | None,
        broker: dict[str, Any] | None,
    ) -> PositionDiscrepancy | None:
        """Compare a single position."""
        if local is None and broker is None:
            return None

        if local is None and broker is not None:
            # Position exists at broker but not locally
            return PositionDiscrepancy(
                symbol=symbol,
                discrepancy_type=DiscrepancyType.MISSING_LOCAL,
                local_quantity=None,
                broker_quantity=broker["quantity"],
                local_avg_cost=None,
                broker_avg_cost=broker["avg_cost"],
                recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
                details="Position exists at broker but not tracked locally",
            )

        if local is not None and broker is None:
            # Position exists locally but not at broker
            return PositionDiscrepancy(
                symbol=symbol,
                discrepancy_type=DiscrepancyType.MISSING_BROKER,
                local_quantity=local["quantity"],
                broker_quantity=None,
                local_avg_cost=local["avg_cost"],
                broker_avg_cost=None,
                recommended_action=ReconciliationAction.ALERT_ONLY,
                details="Position tracked locally but not at broker",
            )

        # Both exist - compare quantities
        local_qty = local["quantity"]  # type: ignore
        broker_qty = broker["quantity"]  # type: ignore

        qty_diff = abs(local_qty - broker_qty)
        if qty_diff > self._config.quantity_tolerance:
            return PositionDiscrepancy(
                symbol=symbol,
                discrepancy_type=DiscrepancyType.QUANTITY_MISMATCH,
                local_quantity=local_qty,
                broker_quantity=broker_qty,
                local_avg_cost=local["avg_cost"],  # type: ignore
                broker_avg_cost=broker["avg_cost"],  # type: ignore
                recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
                details=f"Quantity mismatch: local={local_qty}, broker={broker_qty}",
            )

        # Compare average cost (for informational purposes)
        local_cost = local["avg_cost"]  # type: ignore
        broker_cost = broker["avg_cost"]  # type: ignore

        if local_cost and broker_cost and local_cost > Decimal("0"):
            cost_diff_pct = abs(local_cost - broker_cost) / local_cost
            if cost_diff_pct > self._config.price_tolerance_pct:
                return PositionDiscrepancy(
                    symbol=symbol,
                    discrepancy_type=DiscrepancyType.PRICE_DRIFT,
                    local_quantity=local_qty,
                    broker_quantity=broker_qty,
                    local_avg_cost=local_cost,
                    broker_avg_cost=broker_cost,
                    recommended_action=ReconciliationAction.ALERT_ONLY,
                    details=f"Average cost drift: local={local_cost}, broker={broker_cost}",
                )

        return None

    async def _apply_corrections(
        self,
        session_id: str,
        broker: BrokerAdapter,  # noqa: ARG002
        position_tracker: PositionTracker,
        discrepancies: list[PositionDiscrepancy],
    ) -> list[str]:
        """Apply auto-corrections for discrepancies."""
        corrections = []

        for discrepancy in discrepancies:
            if discrepancy.recommended_action == ReconciliationAction.NO_ACTION:
                continue

            if discrepancy.recommended_action == ReconciliationAction.ALERT_ONLY:
                continue

            if (
                discrepancy.recommended_action == ReconciliationAction.SYNC_FROM_BROKER
                and self._config.sync_direction == "from_broker"
            ):
                try:
                    position = position_tracker.get_or_create_position(
                        session_id, discrepancy.symbol
                    )

                    if discrepancy.broker_quantity is not None:
                        position.quantity = discrepancy.broker_quantity

                    if discrepancy.broker_avg_cost is not None:
                        position.avg_entry_price = discrepancy.broker_avg_cost

                    corrections.append(
                        f"Synced {discrepancy.symbol} from broker: "
                        f"qty={discrepancy.broker_quantity}"
                    )
                    logger.info(f"Auto-corrected position for {discrepancy.symbol}")

                except Exception as e:
                    logger.error(
                        f"Failed to auto-correct {discrepancy.symbol}: {e}"
                    )

        return corrections


class ReconciliationError(Exception):
    """Error during position reconciliation."""

    pass
