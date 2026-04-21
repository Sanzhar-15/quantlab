# Implementation Fixes for ChatGPT-Identified Gaps

These fixes address gaps identified by ChatGPT that were either missing from or insufficiently detailed in my original audit. This document cross-references both audits and provides implementation details.

---

## CRITICAL: IPC/Daemon Integration Gaps (ChatGPT Exclusive)

### FIX-CGP-001: IPC Handshake/Auth Flow Missing in DaemonClient (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §1
**Claude Gap Reference**: GAP-P1-001 noted DaemonClient missing; ChatGPT found specific auth protocol mismatch

**Issue**: Daemon expects `auth` as first message after `negotiate`. Client sends `_auth` params in normal requests instead.

**Fix (TypeScript - DaemonClient.ts)**:
```typescript
export class DaemonClient {
  private socket: net.Socket | null = null;
  private authenticated: boolean = false;
  private protocolVersion: string = "1.0";

  async connect(socketPath: string): Promise<void> {
    this.socket = await this.createConnection(socketPath);

    // Step 1: Protocol negotiation
    const negotiateResult = await this.sendRequest("negotiate", {
      versions: ["1.0"],
      capabilities: ["compression", "streaming"],
    });
    this.protocolVersion = negotiateResult.version;

    // Step 2: EXPLICIT AUTH HANDSHAKE (ChatGPT fix)
    const token = await this.readTokenFile();
    const authResult = await this.sendRequest("auth", {
      token: token,
      client_id: this.clientId,
    });

    if (!authResult.authenticated) {
      throw new Error(`Authentication failed: ${authResult.reason}`);
    }

    this.authenticated = true;
    this.emit("connected");
  }

  private async readTokenFile(): Promise<string> {
    const tokenPath = path.join(
      os.homedir(),
      ".quantlab",
      "sessions",
      this.sessionId,
      "token"
    );
    return fs.readFile(tokenPath, "utf8");
  }
}
```

**Alternative Fix (Python - daemon/main.py)**:
```python
# Allow first request to be any method with _auth param (backward compatible)
async def _handle_client_first_message(self, client: ClientConnection, message: dict) -> bool:
    """Handle first message - can be negotiate, auth, or request with _auth."""
    method = message.get("method", "")
    params = message.get("params", {})

    # Option 1: Explicit auth message
    if method == "auth":
        return await self._authenticate_client(client, params.get("token"))

    # Option 2: Negotiate first
    if method == "negotiate":
        await self._negotiate_protocol(client, params)
        # Mark as needing auth still
        client.needs_auth = True
        return True

    # Option 3: Any request with _auth param (ChatGPT backward-compat fix)
    if "_auth" in params:
        auth_ok = await self._authenticate_client(client, params["_auth"])
        if auth_ok:
            # Process the actual request after auth
            return await self._process_authenticated_request(client, message)
        return False

    # Reject unauthenticated request
    await client.send_error(
        message.get("id"),
        ErrorCode.UNAUTHORIZED,
        "First message must be negotiate, auth, or include _auth param"
    )
    return False
```

---

### FIX-CGP-002: IPC Method Names Mismatch (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §2
**Claude Gap Reference**: GAP-P2-014 noted missing message types; ChatGPT found naming mismatch

**Issue**: Client calls `session.start/pause/resume/stop`, daemon registers `pause/resume/stop/flatten` (no prefix).

**Fix (Python - daemon/main.py)**:
```python
def _register_ipc_handlers(self) -> None:
    """Register all IPC request handlers using SPEC-COMPLIANT names."""
    # Session methods - use full names per Appendix_B
    self._ipc_server.register_handler("session.start", self._handle_session_start)
    self._ipc_server.register_handler("session.pause", self._handle_pause)
    self._ipc_server.register_handler("session.resume", self._handle_resume)
    self._ipc_server.register_handler("session.stop", self._handle_stop)

    # Emergency flatten - spec name
    self._ipc_server.register_handler("flatten.request", self._handle_flatten)

    # Health/status - spec names
    self._ipc_server.register_handler("health.check", self._handle_health)
    self._ipc_server.register_handler("status.get", self._handle_status)

    # Orders - already correct
    self._ipc_server.register_handler("order.submit", self._handle_order_submit)
    self._ipc_server.register_handler("order.cancel", self._handle_order_cancel)
    self._ipc_server.register_handler("order.modify", self._handle_order_modify)  # GAP-P2-005

    # ALIASES for backward compatibility (can be removed later)
    self._ipc_server.register_handler("pause", self._handle_pause)
    self._ipc_server.register_handler("resume", self._handle_resume)
    self._ipc_server.register_handler("stop", self._handle_stop)
    self._ipc_server.register_handler("flatten", self._handle_flatten)
    self._ipc_server.register_handler("health", self._handle_health)
    self._ipc_server.register_handler("status", self._handle_status)
```

---

### FIX-CGP-003: IPC Payload Schema/Casing Mismatch (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §3
**Claude Gap Reference**: Not explicitly identified (missed gap)

**Issue**: Daemon expects snake_case (`order_type`, `limit_price`), client sends camelCase (`orderType`, `limitPrice`).

**Fix (TypeScript - core/ipc/SchemaAdapter.ts)** - NEW FILE:
```typescript
export class SchemaAdapter {
  /**
   * Convert camelCase keys to snake_case for daemon requests.
   */
  static toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[snakeKey] = this.toSnakeCase(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[snakeKey] = value.map((item) =>
          typeof item === "object" && item !== null
            ? this.toSnakeCase(item as Record<string, unknown>)
            : item
        );
      } else {
        result[snakeKey] = value;
      }
    }

    return result;
  }

  /**
   * Convert snake_case keys to camelCase for client responses.
   */
  static toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[camelKey] = this.toCamelCase(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[camelKey] = value.map((item) =>
          typeof item === "object" && item !== null
            ? this.toCamelCase(item as Record<string, unknown>)
            : item
        );
      } else {
        result[camelKey] = value;
      }
    }

    return result;
  }
}

// Usage in DaemonClient.ts:
async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const snakeCaseParams = SchemaAdapter.toSnakeCase(params);
  const rawResult = await this._sendRaw(method, snakeCaseParams);
  return SchemaAdapter.toCamelCase(rawResult) as T;
}
```

---

### FIX-CGP-004: Missing `positions.get` and `orders.get` Handlers (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §4
**Claude Gap Reference**: Not explicitly identified (missed gap)

**Issue**: Client calls `positions.get` and `orders.get` to hydrate UI state. Daemon has no handlers.

**Fix (Python - daemon/main.py)**:
```python
def _register_ipc_handlers(self) -> None:
    # ... existing handlers ...

    # State query handlers (ChatGPT fix)
    self._ipc_server.register_handler("positions.get", self._handle_positions_get)
    self._ipc_server.register_handler("orders.get", self._handle_orders_get)
    self._ipc_server.register_handler("fills.get", self._handle_fills_get)  # For symmetry

async def _handle_positions_get(self, params: dict[str, Any]) -> dict[str, Any]:
    """Return current positions for UI hydration."""
    positions = []
    for symbol, position in self._position_tracker.positions.items():
        positions.append({
            "symbol": symbol,
            "quantity": str(position.quantity),
            "avg_cost": str(position.avg_cost),
            "current_price": str(position.current_price),
            "market_value": str(position.market_value),
            "unrealized_pnl": str(position.unrealized_pnl),
            "realized_pnl": str(position.realized_pnl),
            "side": "long" if position.quantity > 0 else "short",
        })
    return {"positions": positions, "timestamp": datetime.now().isoformat()}

async def _handle_orders_get(self, params: dict[str, Any]) -> dict[str, Any]:
    """Return current orders for UI hydration."""
    status_filter = params.get("status")  # Optional: "pending", "filled", "cancelled"
    orders = []
    for order_id, order in self._order_tracker.orders.items():
        if status_filter and order.status.value != status_filter:
            continue
        orders.append({
            "order_id": order_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": str(order.quantity),
            "filled_quantity": str(order.filled_quantity),
            "limit_price": str(order.limit_price) if order.limit_price else None,
            "stop_price": str(order.stop_price) if order.stop_price else None,
            "status": order.status.value,
            "created_at": order.created_at.isoformat(),
        })
    return {"orders": orders, "timestamp": datetime.now().isoformat()}

async def _handle_fills_get(self, params: dict[str, Any]) -> dict[str, Any]:
    """Return recent fills for UI hydration."""
    limit = params.get("limit", 100)
    fills = []
    for fill in self._fill_tracker.get_recent_fills(limit):
        fills.append({
            "fill_id": fill.fill_id,
            "order_id": fill.order_id,
            "symbol": fill.symbol,
            "side": fill.side.value,
            "quantity": str(fill.quantity),
            "price": str(fill.price),
            "realized_pnl": str(fill.realized_pnl) if fill.realized_pnl else None,
            "timestamp": fill.timestamp.isoformat(),
        })
    return {"fills": fills, "timestamp": datetime.now().isoformat()}
```

---

### FIX-CGP-005: State Notifications Missing (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §5
**Claude Gap Reference**: GAP-P2-014 partially identified; ChatGPT more specific

**Issue**: Client expects `positions.update`, `orders.update`, `fills.update`, `risk.alert`, `connection.status`. Daemon only emits `status.update`.

**Fix (Python - daemon/main.py)**:
```python
async def _on_position_changed(self, position: Position) -> None:
    """Broadcast position update to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        message_type="positions.update",  # Spec-compliant name
        params={
            "symbol": position.symbol,
            "quantity": str(position.quantity),
            "avg_cost": str(position.avg_cost),
            "current_price": str(position.current_price),
            "market_value": str(position.market_value),
            "unrealized_pnl": str(position.unrealized_pnl),
            "realized_pnl": str(position.realized_pnl),
            "change_type": position.last_change_type,  # "opened", "increased", "decreased", "closed"
        },
        session_id=self._session_id,
    ))

async def _on_order_changed(self, order: Order) -> None:
    """Broadcast order update to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        message_type="orders.update",  # Spec-compliant name
        params={
            "order_id": order.order_id,
            "symbol": order.symbol,
            "status": order.status.value,
            "filled_quantity": str(order.filled_quantity),
            "remaining_quantity": str(order.remaining_quantity),
            "avg_fill_price": str(order.avg_fill_price) if order.avg_fill_price else None,
        },
        session_id=self._session_id,
    ))

async def _on_fill_received(self, fill: Fill) -> None:
    """Broadcast fill to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        message_type="fills.update",  # Spec-compliant name
        params={
            "fill_id": fill.fill_id,
            "order_id": fill.order_id,
            "symbol": fill.symbol,
            "side": fill.side.value,
            "quantity": str(fill.quantity),
            "price": str(fill.price),
            "realized_pnl": str(fill.realized_pnl) if fill.realized_pnl else None,
            "timestamp": fill.timestamp.isoformat(),
        },
        session_id=self._session_id,
    ))

async def _on_risk_alert(self, alert: RiskAlert) -> None:
    """Broadcast risk alert to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        message_type="risk.alert",  # Spec-compliant name
        params={
            "alert_type": alert.alert_type.value,  # "exposure_warning", "circuit_breaker", etc.
            "severity": alert.severity.value,  # "warning", "critical"
            "message": alert.message,
            "current_value": str(alert.current_value),
            "threshold": str(alert.threshold),
            "action_required": alert.action_required,
        },
        session_id=self._session_id,
    ))

async def _on_broker_connection_changed(self, status: str, details: dict) -> None:
    """Broadcast broker connection status to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        message_type="connection.status",  # Spec-compliant name
        params={
            "broker": self._config.broker,
            "status": status,  # "connected", "reconnecting", "disconnected"
            "latency_ms": details.get("latency_ms"),
            "last_heartbeat": details.get("last_heartbeat"),
            "reason": details.get("reason"),
        },
        session_id=self._session_id,
    ))
```

---

### FIX-CGP-006: Daemon CLI Invocation Mismatch (P0 - Critical)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §6
**Claude Gap Reference**: Not explicitly identified (missed gap)

**Issue**: Extension spawns `python -m quantlab.daemon start --session-id ... --paper`, but no `__main__.py` with `start` subcommand exists.

**Fix (Python - daemon/__main__.py)** - NEW FILE:
```python
#!/usr/bin/env python3
"""Quantlab daemon CLI entry point.

This module provides the CLI interface expected by the VS Code extension.
"""
import argparse
import asyncio
import logging
import sys

from quantlab.daemon.main import TradingDaemon
from quantlab.daemon.config import SessionConfig

logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="quantlab.daemon",
        description="Quantlab Trading Daemon"
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # Start subcommand (extension expects this)
    start = subparsers.add_parser("start", help="Start a trading session")
    start.add_argument("--session-id", required=True, help="Unique session identifier")
    start.add_argument("--strategy", required=True, help="Path to strategy file")
    start.add_argument("--broker", default="alpaca", help="Broker name")
    start.add_argument("--symbols", nargs="+", required=True, help="Symbols to trade")
    start.add_argument("--timeframe", default="1min", help="Bar timeframe")
    start.add_argument("--paper", action="store_true", help="Use paper trading")

    # Risk limit arguments (extension sends these)
    start.add_argument("--max-exposure", type=float, help="Maximum exposure in USD")
    start.add_argument("--max-position-size", type=float, help="Maximum position size per symbol")
    start.add_argument("--daily-loss-limit", type=float, help="Daily loss limit in USD or %")
    start.add_argument("--consecutive-loss-limit", type=int, default=3, help="Max consecutive losses")

    # Status subcommand
    status = subparsers.add_parser("status", help="Get daemon status")
    status.add_argument("--session-id", help="Session ID to check")

    # Stop subcommand
    stop = subparsers.add_parser("stop", help="Stop a trading session")
    stop.add_argument("--session-id", required=True, help="Session ID to stop")
    stop.add_argument("--flatten", action="store_true", help="Flatten positions before stopping")

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.command == "start":
        config = SessionConfig(
            session_id=args.session_id,
            strategy_path=args.strategy,
            broker=args.broker,
            symbols=args.symbols,
            timeframe=args.timeframe,
            paper_trading=args.paper,
            risk_limits={
                "max_exposure": args.max_exposure,
                "max_position_size": args.max_position_size,
                "daily_loss_limit": args.daily_loss_limit,
                "consecutive_loss_limit": args.consecutive_loss_limit,
            },
        )

        daemon = TradingDaemon(config)

        try:
            asyncio.run(daemon.run())
        except KeyboardInterrupt:
            logger.info("Daemon interrupted by user")
            return 130
        except Exception as e:
            logger.critical(f"Daemon failed: {e}")
            return 1

        return 0

    elif args.command == "status":
        # Check daemon status via PID file
        from quantlab.daemon.lifecycle import check_daemon_running
        if check_daemon_running(args.session_id):
            print(f"Session {args.session_id}: RUNNING")
            return 0
        else:
            print(f"Session {args.session_id}: NOT RUNNING")
            return 1

    elif args.command == "stop":
        # Send stop command via IPC
        from quantlab.daemon.client import send_stop_command
        asyncio.run(send_stop_command(args.session_id, flatten=args.flatten))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
```

---

### FIX-CGP-007: Token Ownership Race Condition (P1 - High)

**Source**: ChatGPT 01_IPC_AND_DAEMON_INTEGRATION.md §7
**Claude Gap Reference**: Not explicitly identified (missed gap)

**Issue**: Extension writes token, daemon generates its own token - race condition if client reads stale token.

**Fix (Adopt Option A - Daemon generates, client waits)**:

**Python - daemon/main.py**:
```python
async def _startup(self) -> None:
    # Generate token FIRST
    self._token = self._token_manager.generate_session_token()
    self._token_manager.write_token_file(
        self._config.session_id,
        self._token
    )

    # Start IPC AFTER token is written
    await self._ipc_server.start()

    logger.info(f"Daemon ready, token written to session dir")
```

**TypeScript - LiveDaemonManager.ts**:
```typescript
async startDaemon(config: SessionConfig): Promise<void> {
  // Spawn daemon process
  const proc = spawn("python", [
    "-m", "quantlab.daemon", "start",
    "--session-id", config.sessionId,
    ...this.buildArgs(config),
  ]);

  // WAIT for daemon to write token file (ChatGPT fix)
  const tokenPath = this.getTokenPath(config.sessionId);
  await this.waitForTokenFile(tokenPath, 10000);  // 10s timeout

  // Now connect client
  await this.client.connect(this.getSocketPath(config.sessionId));
}

private async waitForTokenFile(path: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(path)) {
      // Verify file has content (not empty)
      const content = await fs.readFile(path, "utf8");
      if (content.trim().length > 0) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`Token file not created within ${timeoutMs}ms`);
}
```

---

## HIGH: Security/Trust Gaps (ChatGPT Exclusive Details)

### FIX-CGP-008: Secrets Flow Not Wired End-to-End (P1 - High)

**Source**: ChatGPT 02_SECURITY_SECRETS_TRUST.md §1
**Claude Gap Reference**: GAP-P1-008 noted TypeScript missing; ChatGPT identified specific flow break

**Issue**: UI stores in VS Code SecretStorage, daemon reads from encrypted file - no sync path.

**Fix (Add IPC method for secure credential transfer)**:

**Python - daemon/main.py**:
```python
def _register_ipc_handlers(self) -> None:
    # ... existing handlers ...
    self._ipc_server.register_handler("credentials.set", self._handle_credentials_set)
    self._ipc_server.register_handler("credentials.get", self._handle_credentials_get)

async def _handle_credentials_set(self, params: dict[str, Any]) -> dict[str, Any]:
    """Securely store credentials in daemon's encrypted store."""
    broker = params.get("broker")
    credentials = params.get("credentials")  # {api_key, api_secret, ...}

    if not broker or not credentials:
        return {"success": False, "error": "broker and credentials required"}

    # Store in encrypted secrets file
    from quantlab.secrets.encrypted import EncryptedSecretsStore
    store = EncryptedSecretsStore.get_instance()

    try:
        store.set_credentials(broker, credentials)
        logger.info(f"Credentials stored for broker: {broker}")
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to store credentials: {e}")
        return {"success": False, "error": str(e)}
```

**TypeScript - core/secrets/DaemonSecretsSync.ts** - NEW FILE:
```typescript
export class DaemonSecretsSync {
  constructor(
    private daemonClient: DaemonClient,
    private secureStorage: SecureStorage
  ) {}

  /**
   * Sync broker credentials from VS Code SecretStorage to daemon.
   * Called before starting a live session.
   */
  async syncCredentialsToDaemon(broker: string): Promise<void> {
    // Read from VS Code SecretStorage (primary)
    const credentials = await this.secureStorage.getBrokerCredentials(broker);

    if (!credentials) {
      throw new Error(`No credentials found for broker: ${broker}`);
    }

    // Send to daemon via IPC (secure channel)
    const result = await this.daemonClient.sendRequest("credentials.set", {
      broker,
      credentials,
    });

    if (!result.success) {
      throw new Error(`Failed to sync credentials: ${result.error}`);
    }
  }
}
```

---

### FIX-CGP-009: Master Key Prompt Not Wired (P1 - High)

**Source**: ChatGPT 02_SECURITY_SECRETS_TRUST.md §2
**Claude Gap Reference**: GAP-P1-008 included this file; ChatGPT noted it's completely unused

**Fix**: Wire MasterKeyPrompt into credential setup flow.

**TypeScript - core/trading/LiveSessionStarter.ts**:
```typescript
import { MasterKeyPrompt } from "../../ui/dialogs/MasterKeyPrompt";

async startLiveSession(config: SessionConfig): Promise<void> {
  // Check if encrypted secrets store is locked
  const secretsStore = EncryptedSecretsStore.getInstance();

  if (secretsStore.isLocked()) {
    // Show master key prompt (ChatGPT fix - wire unused component)
    const masterKey = await MasterKeyPrompt.show({
      title: "Unlock Secrets",
      message: "Enter your master key to access broker credentials",
    });

    if (!masterKey) {
      throw new Error("Master key required for live trading");
    }

    const unlocked = await secretsStore.unlock(masterKey);
    if (!unlocked) {
      throw new Error("Invalid master key");
    }
  }

  // Continue with session start...
}
```

---

### FIX-CGP-010: Trust Not Enforced Before Session Start (P0 - Critical)

**Source**: ChatGPT 02_SECURITY_SECRETS_TRUST.md §7
**Claude Gap Reference**: GAP-P3-004 noted WorkspaceTrust missing; ChatGPT found SessionManager bypass

**Issue**: `SessionManager.startSession()` does not reference `TrustManager` at all.

**Fix (TypeScript - core/trading/SessionManager.ts)**:
```typescript
import { TrustManager } from "../trust/TrustManager";

export class SessionManager {
  constructor(
    private daemonClient: DaemonClient,
    private trustManager: TrustManager,  // Add dependency
    // ...
  ) {}

  async startSession(config: SessionConfig): Promise<void> {
    // GATE WITH TRUST CHECK (ChatGPT critical fix)
    const trustStatus = await this.trustManager.verifyForLiveTrading({
      strategyPath: config.strategyPath,
      workspacePath: config.workspacePath,
    });

    if (!trustStatus.trusted) {
      // Show trust prompt
      const userChoice = await this.showTrustPrompt(trustStatus);
      if (userChoice !== "trust") {
        throw new Error("Strategy must be trusted for live trading");
      }
      await this.trustManager.grantTrust(config.strategyPath, "user_approved");
    }

    // Continue with session start...
  }

  async startDaemonSession(config: SessionConfig): Promise<void> {
    // Same trust gate for daemon sessions
    const trustStatus = await this.trustManager.verifyForLiveTrading({
      strategyPath: config.strategyPath,
      workspacePath: config.workspacePath,
    });

    if (!trustStatus.trusted) {
      throw new Error("Strategy must be trusted before starting daemon session");
    }

    // Continue with daemon session start...
  }
}
```

---

## HIGH: Risk Limits Gaps (ChatGPT Exclusive Details)

### FIX-CGP-011: Risk Limit Defaults Don't Match Plan (P1 - High)

**Source**: ChatGPT 03_RISK_LIMITS_ONBOARDING.md §1
**Claude Gap Reference**: FIX-R004 discussed position limits; ChatGPT found defaults mismatch

**Issue**: Plan Decision L74 requires percentage-based defaults (2% daily loss, 5% drawdown, 3 consecutive). Current: USD-based or 0.

**Fix (TypeScript - package.json)**:
```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "quantlab.trading.dailyLossPercent": {
          "type": "number",
          "default": 0.02,
          "description": "Maximum daily loss as percentage of equity (0.02 = 2%)"
        },
        "quantlab.trading.maxDrawdownPercent": {
          "type": "number",
          "default": 0.05,
          "description": "Maximum drawdown as percentage of equity (0.05 = 5%)"
        },
        "quantlab.trading.consecutiveLossLimit": {
          "type": "number",
          "default": 3,
          "description": "Maximum consecutive losing trades before circuit breaker"
        },
        "quantlab.trading.maxExposurePercent": {
          "type": "number",
          "default": 0.50,
          "description": "Maximum total exposure as percentage of equity (0.50 = 50%)"
        }
      }
    }
  }
}
```

**Fix (Python - trading/risk.py)**:
```python
@dataclass
class RiskLimits:
    """Risk limits with plan-compliant defaults (Decision L74)."""
    daily_loss_percent: Decimal = Decimal("0.02")      # 2%
    max_drawdown_percent: Decimal = Decimal("0.05")    # 5%
    consecutive_loss_limit: int = 3
    max_exposure_percent: Decimal = Decimal("0.50")    # 50%
    max_position_percent: Decimal = Decimal("0.10")    # 10% per position
```

---

### FIX-CGP-012: Risk Limits Not Propagated to Daemon (P1 - High)

**Source**: ChatGPT 03_RISK_LIMITS_ONBOARDING.md §2
**Claude Gap Reference**: Partially covered in daemon CLI fix; ChatGPT explicit

**Issue**: Extension passes risk args, daemon CLI ignores them.

**Fix**: Already addressed in FIX-CGP-006 (`daemon/__main__.py`). Ensure daemon applies them:

```python
# In daemon/main.py __init__:
def __init__(self, config: SessionConfig):
    # Apply risk limits from config
    risk_config = config.risk_limits or {}

    self._risk_limits = RiskLimits(
        daily_loss_percent=Decimal(str(risk_config.get("daily_loss_percent", 0.02))),
        max_drawdown_percent=Decimal(str(risk_config.get("max_drawdown_percent", 0.05))),
        consecutive_loss_limit=risk_config.get("consecutive_loss_limit", 3),
        max_exposure_percent=Decimal(str(risk_config.get("max_exposure_percent", 0.50))),
    )

    self._exposure_manager = ExposureManager(
        max_exposure=self._risk_limits.max_exposure_percent * self._account_equity,
    )
```

---

### FIX-CGP-013: First-Run Risk Wizard Missing (P1 - High)

**Source**: ChatGPT 03_RISK_LIMITS_ONBOARDING.md §4
**Claude Gap Reference**: GAP-P3-013 identified this; ChatGPT confirms priority

**Implementation**: Create new wizard UI component.

**TypeScript - ui/onboarding/RiskConfigurationWizard.ts** - NEW FILE:
```typescript
export class RiskConfigurationWizard {
  private static readonly STORAGE_KEY = "quantlab.riskWizardCompleted";

  static async showIfNeeded(context: vscode.ExtensionContext): Promise<boolean> {
    const completed = context.globalState.get<boolean>(this.STORAGE_KEY, false);
    if (completed) return true;

    const result = await this.show();
    if (result.completed) {
      await context.globalState.update(this.STORAGE_KEY, true);
    }
    return result.completed;
  }

  static async show(): Promise<{ completed: boolean; settings: RiskSettings }> {
    // Step 1: Introduction
    const intro = await vscode.window.showInformationMessage(
      "Before you can start live trading, you must configure your risk limits.",
      { modal: true },
      "Continue"
    );
    if (!intro) return { completed: false, settings: {} as RiskSettings };

    // Step 2: Daily loss limit
    const dailyLoss = await vscode.window.showInputBox({
      title: "Daily Loss Limit",
      prompt: "Maximum daily loss as % of equity (e.g., 2 for 2%)",
      value: "2",
      validateInput: (v) => {
        const n = parseFloat(v);
        return isNaN(n) || n <= 0 || n > 100 ? "Enter 1-100" : undefined;
      },
    });
    if (!dailyLoss) return { completed: false, settings: {} as RiskSettings };

    // Step 3: Max drawdown
    const maxDrawdown = await vscode.window.showInputBox({
      title: "Maximum Drawdown",
      prompt: "Maximum drawdown before halt as % (e.g., 5 for 5%)",
      value: "5",
    });
    if (!maxDrawdown) return { completed: false, settings: {} as RiskSettings };

    // Step 4: Consecutive loss limit
    const consecutiveLoss = await vscode.window.showInputBox({
      title: "Consecutive Loss Limit",
      prompt: "Number of consecutive losing trades before circuit breaker",
      value: "3",
    });
    if (!consecutiveLoss) return { completed: false, settings: {} as RiskSettings };

    // Step 5: Risk disclosure acknowledgment
    const disclosure = await vscode.window.showWarningMessage(
      "RISK DISCLOSURE: Trading involves substantial risk of loss. " +
        "You may lose more than your initial investment. " +
        "Past performance does not guarantee future results.",
      { modal: true },
      "I Understand and Accept"
    );
    if (!disclosure) return { completed: false, settings: {} as RiskSettings };

    // Save settings
    const config = vscode.workspace.getConfiguration("quantlab.trading");
    await config.update("dailyLossPercent", parseFloat(dailyLoss) / 100, true);
    await config.update("maxDrawdownPercent", parseFloat(maxDrawdown) / 100, true);
    await config.update("consecutiveLossLimit", parseInt(consecutiveLoss), true);

    return {
      completed: true,
      settings: {
        dailyLossPercent: parseFloat(dailyLoss) / 100,
        maxDrawdownPercent: parseFloat(maxDrawdown) / 100,
        consecutiveLossLimit: parseInt(consecutiveLoss),
      },
    };
  }
}
```

---

## MEDIUM: UI Safety Gaps

### FIX-CGP-014: Pre-Trade Checklist Not Invoked (P1 - High)

**Source**: ChatGPT 04_UI_RECOVERY_UPDATE_FLOW.md §1
**Claude Gap Reference**: GAP-P3-001 identified; ChatGPT confirms unused

**Fix (TypeScript - core/trading/SessionManager.ts)**:
```typescript
import { PreTradeChecklist } from "../../ui/dialogs/PreTradeChecklist";

async startSession(config: SessionConfig): Promise<void> {
  // INVOKE PRE-TRADE CHECKLIST (ChatGPT fix)
  const checklistResult = await PreTradeChecklist.show({
    strategyPath: config.strategyPath,
    broker: config.broker,
    symbols: config.symbols,
    riskLimits: this.getRiskLimits(),
    isPaper: config.paperTrading,
  });

  if (!checklistResult.passed) {
    throw new Error(
      `Pre-trade checklist failed: ${checklistResult.failedItems.join(", ")}`
    );
  }

  // Continue with session start...
}
```

---

### FIX-CGP-015: Recovery Dialog Not Wired (P1 - High)

**Source**: ChatGPT 04_UI_RECOVERY_UPDATE_FLOW.md §2
**Claude Gap Reference**: Not explicitly identified as unused

**Fix (TypeScript - extension.ts)**:
```typescript
import { RecoveryDialog } from "./ui/dialogs/RecoveryDialog";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Check for orphaned sessions on startup (ChatGPT fix)
  const orphanedSessions = await detectOrphanedSessions();

  if (orphanedSessions.length > 0) {
    for (const session of orphanedSessions) {
      const choice = await RecoveryDialog.show({
        sessionId: session.id,
        lastActive: session.lastActive,
        positions: session.positions,
        hasOpenPositions: session.positions.length > 0,
      });

      switch (choice) {
        case "reconnect":
          await sessionManager.reconnectToSession(session.id);
          break;
        case "viewOnly":
          await sessionManager.connectViewOnly(session.id);
          break;
        case "discard":
          await cleanupSession(session.id);
          break;
      }
    }
  }
}

async function detectOrphanedSessions(): Promise<OrphanedSession[]> {
  const sessionsDir = path.join(os.homedir(), ".quantlab", "sessions");
  const sessions: OrphanedSession[] = [];

  for (const dir of await fs.readdir(sessionsDir)) {
    const pidFile = path.join(sessionsDir, dir, "daemon.pid");
    const tokenFile = path.join(sessionsDir, dir, "token");

    if (await fs.exists(tokenFile)) {
      // Token exists - check if daemon is still running
      const isRunning = await checkDaemonRunning(pidFile);
      if (isRunning) {
        sessions.push({
          id: dir,
          lastActive: (await fs.stat(tokenFile)).mtime,
          positions: await tryGetPositions(dir),
        });
      }
    }
  }

  return sessions;
}
```

---

### FIX-CGP-016: Connection-Loss UI Flow Missing (P1 - High)

**Source**: ChatGPT 04_UI_RECOVERY_UPDATE_FLOW.md §5
**Claude Gap Reference**: GAP-P4-014 identified; ChatGPT provides specific fix

**Fix (TypeScript - ui/components/ConnectionStatusBanner.ts)** - NEW FILE:
```typescript
export class ConnectionStatusBanner {
  private statusBar: vscode.StatusBarItem;
  private currentStatus: "connected" | "reconnecting" | "disconnected" = "connected";

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBar.show();
    this.updateDisplay();
  }

  onConnectionStatusChanged(status: ConnectionStatus): void {
    this.currentStatus = status.status;

    switch (status.status) {
      case "connected":
        this.updateDisplay();
        break;

      case "reconnecting":
        this.showReconnectingBanner(status);
        break;

      case "disconnected":
        this.showDisconnectedDialog(status);
        break;
    }
  }

  private updateDisplay(): void {
    switch (this.currentStatus) {
      case "connected":
        this.statusBar.text = "$(check) Broker Connected";
        this.statusBar.backgroundColor = undefined;
        break;

      case "reconnecting":
        this.statusBar.text = "$(sync~spin) Reconnecting...";
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        break;

      case "disconnected":
        this.statusBar.text = "$(error) Disconnected";
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
        break;
    }
  }

  private async showDisconnectedDialog(status: ConnectionStatus): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Broker connection lost: ${status.reason}. ` +
        `You have ${status.openPositions} open positions.`,
      { modal: true },
      "Reconnect",
      "Emergency Flatten",
      "View Only"
    );

    switch (choice) {
      case "Reconnect":
        vscode.commands.executeCommand("quantlab.reconnectBroker");
        break;
      case "Emergency Flatten":
        vscode.commands.executeCommand("quantlab.emergencyFlatten");
        break;
    }
  }
}
```

---

## LOW: Debug/Release Gaps

### FIX-CGP-017: Debug Mmap Reader Missing (P2 - Medium)

**Source**: ChatGPT 05_DEBUGGER_DATA_RELEASE.md §1
**Claude Gap Reference**: GAP-P3-003 identified mmap missing

**Fix (Python - debug/mmap_reader.py)** - NEW FILE:
```python
"""Memory-mapped debug file reader for O(1) random access."""
import mmap
import struct
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.ipc as ipc


class DebugMmapReader:
    """Memory-mapped reader for debug files supporting random bar access."""

    def __init__(self, debug_file: Path):
        self._path = debug_file
        self._file = None
        self._mmap = None
        self._index: dict[int, int] = {}  # bar_index -> file_offset
        self._schema: pa.Schema | None = None

    def open(self) -> None:
        """Open the debug file and build index."""
        self._file = open(self._path, "rb")
        self._mmap = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        self._build_index()

    def close(self) -> None:
        """Close the mmap and file."""
        if self._mmap:
            self._mmap.close()
        if self._file:
            self._file.close()

    def _build_index(self) -> None:
        """Build bar index from Arrow IPC file."""
        reader = ipc.open_file(self._mmap)
        self._schema = reader.schema

        for i in range(reader.num_record_batches):
            batch = reader.get_batch(i)
            bar_indices = batch.column("bar_index").to_pylist()
            for bar_idx in bar_indices:
                self._index[bar_idx] = i  # Map bar_index to batch number

    def get_state_at_bar(self, bar_index: int) -> dict[str, Any]:
        """O(1) random access to state at a specific bar."""
        if bar_index not in self._index:
            raise KeyError(f"Bar {bar_index} not found in debug file")

        batch_num = self._index[bar_index]
        reader = ipc.open_file(self._mmap)
        batch = reader.get_batch(batch_num)

        # Find row within batch
        bar_col = batch.column("bar_index")
        row_idx = bar_col.to_pylist().index(bar_index)

        # Extract state
        return {
            "bar_index": bar_index,
            "timestamp": batch.column("timestamp")[row_idx].as_py(),
            "portfolio": self._parse_json(batch.column("portfolio")[row_idx].as_py()),
            "positions": self._parse_json(batch.column("positions")[row_idx].as_py()),
            "signals": self._parse_json(batch.column("signals")[row_idx].as_py()),
            "conditions": self._parse_json(batch.column("conditions")[row_idx].as_py()),
        }

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *args):
        self.close()
```

---

## Summary

| Fix ID | Priority | Source | Description |
|--------|----------|--------|-------------|
| FIX-CGP-001 | P0 | ChatGPT | IPC auth handshake missing |
| FIX-CGP-002 | P0 | ChatGPT | IPC method names mismatch |
| FIX-CGP-003 | P0 | ChatGPT | IPC schema casing mismatch |
| FIX-CGP-004 | P0 | ChatGPT | positions.get/orders.get missing |
| FIX-CGP-005 | P0 | ChatGPT | State notifications missing |
| FIX-CGP-006 | P0 | ChatGPT | Daemon CLI invocation mismatch |
| FIX-CGP-007 | P1 | ChatGPT | Token race condition |
| FIX-CGP-008 | P1 | ChatGPT | Secrets flow not wired |
| FIX-CGP-009 | P1 | ChatGPT | Master key prompt unused |
| FIX-CGP-010 | P0 | ChatGPT | Trust not enforced |
| FIX-CGP-011 | P1 | ChatGPT | Risk defaults mismatch |
| FIX-CGP-012 | P1 | ChatGPT | Risk limits not propagated |
| FIX-CGP-013 | P1 | ChatGPT | First-run wizard missing |
| FIX-CGP-014 | P1 | ChatGPT | Pre-trade checklist unused |
| FIX-CGP-015 | P1 | ChatGPT | Recovery dialog unused |
| FIX-CGP-016 | P1 | ChatGPT | Connection-loss UI missing |
| FIX-CGP-017 | P2 | ChatGPT | Debug mmap reader missing |

**Critical (P0)**: 7 fixes - All IPC integration issues that completely block live trading
**High (P1)**: 9 fixes - Security, trust, risk, and UI safety gaps
**Medium (P2)**: 1 fix - Debug performance optimization
