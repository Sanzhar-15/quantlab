# Phase 1: Security & Secrets (10 fixes)

**BLOCKS LIVE TRADING** -- Credentials, trust verification, and audit logging must be secure before real money flows.

## Phase Overview

This phase hardens the credential pipeline, fixes log leaks, ensures the trust model gates live trading, and routes the kill switch correctly through the daemon for daemon-managed sessions.

## Prerequisites

- Phase 0 (IPC Integration) must be complete -- daemon must be reachable from extension.

---

## Fix List (Execution Order)

### FIX-D001 [P0] Change token log from INFO to DEBUG, remove file path

**Problem**: Auth token and its file path are logged at INFO level, visible in standard log output. This is a credential leak.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:101` -- TokenManager logs token generation

**Root Cause**: Developer convenience logging left in production code.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# In TokenManager.generate() (around line 101):

def generate(self) -> str:
    """Generate a new auth token."""
    token = secrets.token_urlsafe(self.TOKEN_LENGTH)

    # Write token to file
    token_path = self.token_path
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(token)
    token_path.chmod(0o600)

    # FIX-D001: Log at DEBUG without file path or token value
    self._logger.debug("Auth token generated for session %s", self._session_id)

    return token
```

Also check for other INFO-level token logs:

```python
# Search and fix all occurrences:
# BEFORE: self._logger.info("Token written to %s", token_path)
# AFTER:  self._logger.debug("Token persisted for session %s", self._session_id)

# BEFORE: self._logger.info("Validating token: %s...", token[:8])
# AFTER:  self._logger.debug("Validating token for session %s", self._session_id)
```

**Verification**:
1. Start daemon with `--log-level INFO`
2. `grep -i "token" ~/.quantlab/logs/daemon_*.log` -- should NOT contain token values or paths
3. With `--log-level DEBUG`, token-related debug messages appear but still no values

**Dependencies**: None

---

### FIX-D002 [P0] Fix devnull FD leak on Unix fork

**Problem**: During Unix daemonization double-fork, `/dev/null` file descriptor may leak.

**Evidence**:
- `engine/quantlab/daemon/lifecycle.py:365-396` -- `daemonize()` Unix path

**Root Cause**: File descriptors opened for stdin/stdout/stderr redirect may not be properly closed.

**Files to modify**:
- `engine/quantlab/daemon/lifecycle.py`

**Implementation**:

```python
# engine/quantlab/daemon/lifecycle.py
# In daemonize() Unix path (around line 365):

def _daemonize_unix():
    """Double-fork daemonization for Unix."""
    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent exits
        os._exit(0)

    # Create new session
    os.setsid()

    # Second fork
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Redirect stdio to /dev/null
    # FIX-D002: Use context-safe FD management
    devnull_fd = os.open(os.devnull, os.O_RDWR)
    try:
        os.dup2(devnull_fd, 0)  # stdin
        os.dup2(devnull_fd, 1)  # stdout
        os.dup2(devnull_fd, 2)  # stderr
    finally:
        # Close the original FD -- dup2 created copies for 0, 1, 2
        if devnull_fd > 2:
            os.close(devnull_fd)

    # Set umask
    os.umask(0o077)
```

**Verification**:
1. Start daemon with `--daemonize` on Linux
2. `ls -la /proc/<daemon_pid>/fd/` -- no leaked /dev/null FDs (only 0, 1, 2)
3. Daemon continues running after parent exits

**Dependencies**: None

---

### FIX-CGP-008 [P1] Wire secrets flow end-to-end (credentials.set IPC)

**Problem**: Extension stores broker credentials in VS Code SecretStorage but never transmits them to the daemon. Daemon can't connect to broker.

**Evidence**:
- `extensions/quantlab/src/utils/secureStorage.ts` -- stores credentials locally
- `engine/quantlab/daemon/main.py` -- needs credentials to connect broker
- No `credentials.set` IPC call exists in extension code

**Root Cause**: Credential sync between extension and daemon was never wired.

**Files to create**:
- `extensions/quantlab/src/core/trading/DaemonSecretsSync.ts`

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/DaemonSecretsSync.ts

import * as vscode from 'vscode';
import { DaemonClient } from './DaemonClient';

/**
 * Syncs broker credentials from extension SecretStorage to daemon via IPC.
 * Credentials are transmitted over the authenticated Unix socket (no network).
 */
export class DaemonSecretsSync {
    constructor(
        private readonly secretStorage: vscode.SecretStorage,
    ) {}

    /**
     * Send stored credentials to daemon for a specific broker.
     * Must be called after IPC auth is complete.
     */
    async syncCredentials(client: DaemonClient, broker: string): Promise<boolean> {
        const keyPrefix = `quantlab.broker.${broker}`;

        // Read credentials from VS Code SecretStorage
        const apiKey = await this.secretStorage.get(`${keyPrefix}.apiKey`);
        const apiSecret = await this.secretStorage.get(`${keyPrefix}.apiSecret`);

        if (!apiKey || !apiSecret) {
            return false;
        }

        try {
            const result = await client.request<{ success: boolean }>('credentials.set', {
                broker,
                credentials: {
                    api_key: apiKey,
                    api_secret: apiSecret,
                },
            });
            return result.success;
        } catch (error) {
            console.error(`Failed to sync credentials for ${broker}:`, error);
            return false;
        }
    }

    /**
     * Check if daemon has credentials for a broker.
     */
    async checkDaemonCredentials(client: DaemonClient, broker: string): Promise<boolean> {
        try {
            const status = await client.getCredentialsStatus();
            return status?.hasBrokerCredentials ?? false;
        } catch {
            return false;
        }
    }
}
```

Integration in SessionManager:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// In startDaemonSession(), after connecting client:

// Sync credentials to daemon
const secretsSync = new DaemonSecretsSync(this.context.secrets);
const synced = await secretsSync.syncCredentials(client, broker);
if (!synced) {
    // Prompt user to enter credentials
    const entered = await this.promptBrokerCredentials(broker);
    if (!entered) {
        await client.disconnect();
        throw new Error('Broker credentials required for live trading');
    }
    // Retry sync
    await secretsSync.syncCredentials(client, broker);
}
```

**Verification**:
1. Store Alpaca credentials in extension settings
2. Start daemon session
3. Check daemon logs: "Broker credentials received via IPC"
4. Daemon connects to broker successfully

**Dependencies**: Phase 0 (IPC auth must work)

---

### FIX-CGP-009 [P1] Wire MasterKeyPrompt into credential setup

**Problem**: First-time credential setup should prompt for a master key to encrypt stored credentials. Currently bypassed.

**Evidence**:
- `extensions/quantlab/src/core/trading/SessionManager.ts` -- no master key prompt

**Root Cause**: VS Code's SecretStorage already handles encryption, but for daemon-side storage a master key adds defense-in-depth.

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// Add to credential setup flow:

private async promptBrokerCredentials(broker: string): Promise<boolean> {
    // Step 1: Check if master key exists
    const hasMasterKey = await this.context.secrets.get('quantlab.masterKey');

    if (!hasMasterKey) {
        // FIX-CGP-009: Prompt for master key on first credential setup
        const masterKey = await vscode.window.showInputBox({
            prompt: 'Enter a master password to encrypt your broker credentials',
            password: true,
            placeHolder: 'Master password (min 8 characters)',
            validateInput: (value) => {
                if (!value || value.length < 8) {
                    return 'Master password must be at least 8 characters';
                }
                return null;
            },
        });

        if (!masterKey) {
            return false;
        }

        // Confirm master key
        const confirm = await vscode.window.showInputBox({
            prompt: 'Confirm master password',
            password: true,
        });

        if (masterKey !== confirm) {
            vscode.window.showErrorMessage('Passwords do not match');
            return false;
        }

        await this.context.secrets.store('quantlab.masterKey', masterKey);
    }

    // Step 2: Prompt for broker API credentials
    const apiKey = await vscode.window.showInputBox({
        prompt: `Enter ${broker} API key`,
        placeHolder: 'API Key',
    });
    if (!apiKey) {
        return false;
    }

    const apiSecret = await vscode.window.showInputBox({
        prompt: `Enter ${broker} API secret`,
        password: true,
        placeHolder: 'API Secret',
    });
    if (!apiSecret) {
        return false;
    }

    // Store in VS Code SecretStorage
    await this.context.secrets.store(`quantlab.broker.${broker}.apiKey`, apiKey);
    await this.context.secrets.store(`quantlab.broker.${broker}.apiSecret`, apiSecret);

    return true;
}
```

**Verification**:
1. Clear all stored credentials
2. Start live session -- master key prompt appears
3. Enter credentials -- stored securely
4. Restart extension -- no re-prompt for master key (already exists)

**Dependencies**: FIX-CGP-008

---

### FIX-CGP-010 [P0] Gate session start with TrustManager verification

**Problem**: Live trading can start without verifying workspace trust or strategy integrity. A tampered strategy could execute unauthorized trades.

**Evidence**:
- `extensions/quantlab/src/core/trading/SessionManager.ts:418` -- `startSession()` doesn't call TrustManager
- `extensions/quantlab/src/core/trust/TrustManager.ts:321` -- `verifyForLiveTrading()` exists but isn't called

**Root Cause**: Trust verification was implemented but never integrated into the session start flow.

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// In startSession() and startDaemonSession(), add trust gate:

public async startSession(strategyPath: string, mode: 'paper' | 'live'): Promise<string> {
    // FIX-CGP-010: Gate with TrustManager for live trading
    if (mode === 'live') {
        const trustManager = TrustManager.getInstance();
        const verification = await trustManager.verifyForLiveTradingWithPrompts(strategyPath);

        if (!verification.trusted) {
            throw new Error(
                `Strategy trust verification failed: ${verification.reason}. ` +
                'Live trading requires workspace trust and strategy integrity verification.'
            );
        }
    }

    // CODEX-006: Live trading MUST go through daemon
    if (mode === 'live') {
        return this.startDaemonSession(strategyPath, mode);
    }

    // Paper trading path...
    const config = vscode.workspace.getConfiguration('quantlab.trading');
    const useDaemonForPaper = config.get<boolean>('useDaemonForPaper', false);
    if (useDaemonForPaper) {
        return this.startDaemonSession(strategyPath, mode);
    }
    return this._startInExtensionSession(strategyPath, mode);
}
```

**Verification**:
1. Open untrusted workspace, try to start live session -- blocked with trust prompt
2. Trust workspace and strategy -- live session starts
3. Modify strategy file -- trust revoked, next live start blocked

**Dependencies**: Phase 0 (session start must work)

---

### CODEX-007 [P1] Route kill switch through DaemonClient for daemon sessions

**Problem**: Kill switch uses in-extension broker adapter to flatten positions. For daemon-managed sessions, it should route through `DaemonClient.flattenPositions()` to use daemon-side safety controls.

**Evidence**:
- `extensions/quantlab/src/views/trade/KillSwitch.ts:89` -- `flattenPositions()` uses broker adapter
- Daemon has circuit breaker, exposure manager, reconciliation that would be bypassed

**Root Cause**: Kill switch was written before daemon architecture existed.

**Files to modify**:
- `extensions/quantlab/src/views/trade/KillSwitch.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/views/trade/KillSwitch.ts
// Update flattenPositions() to route through daemon when appropriate:

import { SessionManager } from '../../core/trading/SessionManager';

private async flattenPositions(sessionId: string): Promise<void> {
    const sessionManager = SessionManager.getInstance();

    // CODEX-007: Route through daemon for daemon-managed sessions
    if (sessionManager.isUsingDaemon(sessionId)) {
        const client = sessionManager.getDaemonClient(sessionId);
        if (client) {
            try {
                await client.flattenPositions();
                return;
            } catch (error) {
                // Fall through to direct broker as last resort
                console.error('Daemon flatten failed, attempting direct broker:', error);
            }
        }
    }

    // Fallback: direct broker adapter (paper sessions or daemon unavailable)
    const positions = await sessionManager.getAllPositions(sessionId);
    for (const position of positions) {
        if (position.quantity !== 0) {
            await sessionManager.submitOrder(sessionId, {
                symbol: position.symbol,
                side: position.quantity > 0 ? 'sell' : 'buy_to_cover',
                quantity: Math.abs(position.quantity),
                orderType: 'market',
                timeInForce: 'ioc',
            });
        }
    }
}

private async cancelOrders(sessionId: string): Promise<void> {
    const sessionManager = SessionManager.getInstance();

    // CODEX-007: Route through daemon for daemon-managed sessions
    if (sessionManager.isUsingDaemon(sessionId)) {
        const client = sessionManager.getDaemonClient(sessionId);
        if (client) {
            try {
                // Cancel all via daemon
                const orders = await client.getOrders();
                for (const order of orders) {
                    await client.cancelOrder(order.orderId);
                }
                return;
            } catch (error) {
                console.error('Daemon cancel failed, attempting direct:', error);
            }
        }
    }

    // Fallback: direct cancellation
    const orders = await sessionManager.getAllOpenOrders(sessionId);
    for (const order of orders) {
        await sessionManager.cancelOrder(sessionId, order.orderId);
    }
}
```

**Verification**:
1. Start live session via daemon
2. Execute kill switch
3. Check daemon logs: flatten request received and processed with circuit breaker checks
4. All positions closed, all orders cancelled

**Dependencies**: Phase 0, CODEX-006

---

### NEW-SEC-001 [P1] Remove os.environ fallback in _connect_broker

**Problem**: If IPC credential sync fails, daemon falls back to `os.environ` for broker credentials. This is insecure -- env vars are visible to other processes.

**Evidence**:
- `engine/quantlab/daemon/main.py:1895-1897` -- `os.environ` fallback for credentials

**Root Cause**: Development convenience that should not exist in production.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# In _connect_broker() (around line 1895):

async def _connect_broker(self):
    """Connect to broker using IPC-provided credentials."""
    credentials = self._credentials

    if not credentials:
        # NEW-SEC-001: Do NOT fall back to os.environ
        raise RuntimeError(
            "No broker credentials available. Credentials must be provided "
            "via IPC credentials.set before starting a session. "
            "Environment variable fallback is disabled for security."
        )

    # REMOVED: os.environ fallback
    # BEFORE:
    #   api_key = credentials.get("api_key") or os.environ.get("ALPACA_API_KEY", "")
    #   api_secret = credentials.get("api_secret") or os.environ.get("ALPACA_API_SECRET", "")
    # AFTER:
    api_key = credentials.get("api_key")
    api_secret = credentials.get("api_secret")

    if not api_key or not api_secret:
        raise RuntimeError(
            f"Incomplete credentials for broker '{self._config.broker}'. "
            "Both api_key and api_secret are required."
        )

    # Connect to broker
    await self._broker.connect(api_key=api_key, api_secret=api_secret)
```

**Verification**:
1. Unset `ALPACA_API_KEY` and `ALPACA_API_SECRET` env vars
2. Start daemon without IPC credentials -- should raise RuntimeError
3. Start daemon with IPC credentials -- should connect successfully
4. `grep -rn "os.environ.*ALPACA\|os.environ.*API_KEY\|os.environ.*API_SECRET" engine/quantlab/daemon/` -- 0 hits

**Dependencies**: FIX-CGP-008

---

### NEW-SEC-002 [P1] Wire log_order_submit/fill/cancel/reject into trading path

**Problem**: Order lifecycle events (submit, fill, cancel, reject) should be audit-logged for compliance. Currently only partial logging.

**Evidence**:
- `engine/quantlab/daemon/main.py` -- order handlers exist but audit log calls may be missing

**Root Cause**: Audit logging infrastructure exists but not consistently wired.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# Add audit logging to all order lifecycle methods:

async def _handle_order_submit(self, params: dict) -> dict:
    """Handle order submission."""
    order = self._create_order_from_params(params)

    # NEW-SEC-002: Audit log order submission
    self._audit_logger.info(
        "ORDER_SUBMIT session=%s order_id=%s symbol=%s side=%s qty=%s type=%s",
        self._config.session_id, order.order_id, order.symbol,
        order.side, order.quantity, order.order_type,
    )

    try:
        result = await self._submit_order(order)
        return {"success": True, "order_id": order.order_id}
    except Exception as e:
        self._audit_logger.warning(
            "ORDER_REJECT session=%s order_id=%s reason=%s",
            self._config.session_id, order.order_id, str(e),
        )
        return {"success": False, "error": str(e)}

async def _handle_broker_fill(self, fill_data: dict):
    """Handle fill from broker."""
    # NEW-SEC-002: Audit log fill
    self._audit_logger.info(
        "ORDER_FILL session=%s order_id=%s symbol=%s side=%s qty=%s price=%s",
        self._config.session_id, fill_data.get("order_id"),
        fill_data.get("symbol"), fill_data.get("side"),
        fill_data.get("quantity"), fill_data.get("price"),
    )
    # ... existing fill processing ...

async def _handle_order_cancel(self, params: dict) -> dict:
    """Handle order cancellation."""
    order_id = params.get("order_id")

    # NEW-SEC-002: Audit log cancellation
    self._audit_logger.info(
        "ORDER_CANCEL session=%s order_id=%s",
        self._config.session_id, order_id,
    )

    try:
        await self._cancel_order(order_id)
        return {"success": True, "order_id": order_id}
    except Exception as e:
        return {"success": False, "error": str(e)}
```

Also ensure audit logger is configured:

```python
# In LiveTradingDaemon.__init__():
import logging

self._audit_logger = logging.getLogger(f"quantlab.audit.{config.session_id}")
# Audit log goes to separate file
audit_handler = logging.FileHandler(
    Path.home() / ".quantlab" / "logs" / f"audit_{config.session_id}.log"
)
audit_handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s %(message)s"
))
self._audit_logger.addHandler(audit_handler)
self._audit_logger.setLevel(logging.INFO)
```

**Verification**:
1. Submit, fill, cancel orders through daemon
2. Check `~/.quantlab/logs/audit_*.log` -- all events logged
3. Each log line has: timestamp, event type, session ID, order ID, relevant details

**Dependencies**: Phase 0

---

### NEW-SEC-003 [P1] Trust storage per-workspace, not global

**Problem**: TrustManager stores trust data in global state, shared across all workspaces. A malicious workspace could inherit trust from a legitimate one.

**Evidence**:
- `extensions/quantlab/src/core/trust/TrustManager.ts:454` -- `loadTrustStore()` uses global state key `'quantlab.trustStore'`

**Root Cause**: Simpler implementation used global storage.

**Files to modify**:
- `extensions/quantlab/src/core/trust/TrustManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trust/TrustManager.ts
// Change trust store key to include workspace identity:

private getTrustStoreKey(): string {
    // NEW-SEC-003: Per-workspace trust storage
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        // Use workspace URI hash for isolation
        const crypto = require('crypto');
        const workspaceId = crypto.createHash('sha256')
            .update(workspaceFolders[0].uri.toString())
            .digest('hex')
            .substring(0, 16);
        return `quantlab.trustStore.${workspaceId}`;
    }
    return 'quantlab.trustStore.global';
}

// Update loadTrustStore():
private async loadTrustStore(): Promise<void> {
    const key = this.getTrustStoreKey();
    const stored = this.globalState.get<TrustStoreData>(key);
    if (stored) {
        this.trustedWorkspaces = new Map(Object.entries(stored.workspaces ?? {}));
        this.trustedStrategies = new Map(Object.entries(stored.strategies ?? {}));
    }
}

// Update saveTrustStore():
private async saveTrustStore(): Promise<void> {
    const key = this.getTrustStoreKey();
    await this.globalState.update(key, {
        workspaces: Object.fromEntries(this.trustedWorkspaces),
        strategies: Object.fromEntries(this.trustedStrategies),
    });
}
```

**Verification**:
1. Trust a strategy in workspace A
2. Open workspace B -- strategy should NOT be trusted
3. Trust the same strategy in workspace B -- both workspaces have independent trust
4. Revoke trust in A -- B still trusts it

**Dependencies**: None

---

### NEW-SEC-004 [P1] Extension update trust revocation

**Problem**: When the extension updates, strategy trust should be re-evaluated since the trust model code may have changed.

**Evidence**:
- `extensions/quantlab/src/core/trust/TrustManager.ts` -- no update-triggered revocation

**Root Cause**: Extension updates weren't considered in trust lifecycle.

**Files to modify**:
- `extensions/quantlab/src/core/trust/TrustManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trust/TrustManager.ts
// Add version tracking to trust store:

private static readonly TRUST_SCHEMA_VERSION = 1;

private async loadTrustStore(): Promise<void> {
    const key = this.getTrustStoreKey();
    const stored = this.globalState.get<TrustStoreData>(key);

    if (stored) {
        // NEW-SEC-004: Check schema version on extension update
        if (stored.schemaVersion !== TrustManager.TRUST_SCHEMA_VERSION) {
            this._logger.info(
                'Trust store schema version changed (%d -> %d), re-verification required',
                stored.schemaVersion, TrustManager.TRUST_SCHEMA_VERSION
            );
            // Mark all strategies as needing re-verification
            this.trustedStrategies = new Map();
            this.trustedWorkspaces = new Map(Object.entries(stored.workspaces ?? {}));
            // Save cleared strategies
            await this.saveTrustStore();
            return;
        }

        this.trustedWorkspaces = new Map(Object.entries(stored.workspaces ?? {}));
        this.trustedStrategies = new Map(Object.entries(stored.strategies ?? {}));
    }
}

private async saveTrustStore(): Promise<void> {
    const key = this.getTrustStoreKey();
    await this.globalState.update(key, {
        schemaVersion: TrustManager.TRUST_SCHEMA_VERSION,
        workspaces: Object.fromEntries(this.trustedWorkspaces),
        strategies: Object.fromEntries(this.trustedStrategies),
    });
}
```

**Verification**:
1. Trust a strategy, verify it's trusted
2. Bump `TRUST_SCHEMA_VERSION` to 2
3. Reload extension -- all strategy trust should be cleared
4. Workspace trust preserved (re-verification prompt for strategies)

**Dependencies**: NEW-SEC-003

---

## Phase Verification Checklist

- [ ] Token values never appear in INFO-level logs
- [ ] No FD leaks during Unix daemonization
- [ ] Broker credentials sync from extension to daemon via IPC
- [ ] Master key prompt appears on first credential setup
- [ ] TrustManager gates live trading (untrusted strategy blocked)
- [ ] Kill switch routes through daemon for daemon sessions
- [ ] No `os.environ` fallback for broker credentials
- [ ] All order lifecycle events audit-logged
- [ ] Trust store is per-workspace, not global
- [ ] Extension update triggers strategy trust re-verification
- [ ] `grep -r "os.environ.*ALPACA" engine/quantlab/daemon/` returns 0 hits

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "TrustManager not implemented" | TrustManager.ts is 644 lines with workspace/strategy verification |
| "Kill switch missing" | KillSwitch.ts exists (114 lines) but routes through wrong path for daemon sessions |
| "No secure storage" | secureStorage.ts wraps VS Code SecretStorage, but sync to daemon is missing |
