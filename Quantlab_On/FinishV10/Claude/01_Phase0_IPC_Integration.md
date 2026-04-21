# Phase 0: IPC Integration (19 fixes)

**BLOCKS EVERYTHING** -- Nothing works until the TypeScript extension can communicate with the Python daemon.

## Phase Overview

The Codex audit revealed 4 additional P0 blockers (socket path, CLI flags, readiness signal, session config) that completely prevent daemon startup. Combined with the ChatGPT and Claude audit findings on auth handshake, method naming, and schema casing, there are 19 fixes needed before any other phase can proceed.

## Prerequisites

None -- this is the first phase.

---

## Fix List (Execution Order)

### CODEX-001 [P0] Fix socket path mismatch

**Problem**: Daemon binds `~/.quantlab/sockets/{session_id}.sock` but extension connects to `~/.quantlab/sessions/{session_id}.sock`. They will NEVER connect.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:168` -- `IPCServer.__init__` uses `~/.quantlab/sockets/`
- `extensions/quantlab/src/core/ipc/SocketTransport.ts:79` -- `getSocketPath()` uses `~/.quantlab/sessions/`

**Root Cause**: Two developers independently chose directory names without a shared spec.

**Resolution**: Use the extension convention `~/.quantlab/sessions/` since PID files and tokens already live there.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# In IPCServer.__init__ (around line 168), change the socket directory:

# BEFORE:
#   self._socket_dir = Path.home() / ".quantlab" / "sockets"
# AFTER:
self._socket_dir = Path.home() / ".quantlab" / "sessions"
```

Full context -- find the `socket_path` property or `__init__` where the socket directory is set and replace `"sockets"` with `"sessions"`:

```python
class IPCServer:
    def __init__(self, session_id: str, ...):
        self._session_id = session_id
        # Fix: use sessions/ to match extension SocketTransport.ts:79
        self._socket_dir = Path.home() / ".quantlab" / "sessions"
        self._socket_dir.mkdir(parents=True, exist_ok=True)
        self._socket_path = self._socket_dir / f"{session_id}.sock"
        # ... rest of init
```

**Verification**:
1. Start daemon with `python -m quantlab.daemon start --session-id test --strategy test.py --broker alpaca --symbols AAPL`
2. Check `ls ~/.quantlab/sessions/test.sock` exists
3. Extension `SocketTransport.connect()` should find and connect to the socket

**Dependencies**: None (do this first)

---

### CODEX-002 [P0] Fix CLI flag `--symbol` -> `--symbols` and add `--broker`

**Problem**: Extension sends `--symbol` (singular), daemon expects `--symbols` (plural). Extension doesn't pass `--broker`.

**Evidence**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:285` -- `buildDaemonArgs()` builds arg list
- `engine/quantlab/daemon/__main__.py:25-142` -- `parse_args()` expects `--symbols` (nargs="+") and `--broker`

**Root Cause**: Extension was written against an earlier CLI spec.

**Files to modify**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/LiveDaemonManager.ts
// In buildDaemonArgs() method (around line 285):

private buildDaemonArgs(config: DaemonConfig): string[] {
    const args: string[] = [
        '-m', 'quantlab.daemon',
        'start',
        '--session-id', config.sessionId,
        '--strategy', config.strategyPath,
        '--broker', config.broker ?? 'alpaca',           // CODEX-002: pass broker
        '--symbols', ...(config.symbols ?? ['AAPL']),     // CODEX-002: plural --symbols
        '--timeframe', config.timeframe ?? '1min',
    ];

    if (config.paper) {
        args.push('--paper');
    }

    // Risk limits
    if (config.riskLimits) {
        if (config.riskLimits.maxExposure !== undefined) {
            args.push('--max-exposure', String(config.riskLimits.maxExposure));
        }
        if (config.riskLimits.maxPositionSize !== undefined) {
            args.push('--max-position-size', String(config.riskLimits.maxPositionSize));
        }
        if (config.riskLimits.dailyLossLimit !== undefined) {
            args.push('--daily-loss-limit', String(config.riskLimits.dailyLossLimit));
        }
        if (config.riskLimits.maxDrawdownPercent !== undefined) {
            args.push('--max-drawdown-percent', String(config.riskLimits.maxDrawdownPercent));
        }
        if (config.riskLimits.consecutiveLossLimit !== undefined) {
            args.push('--consecutive-loss-limit', String(config.riskLimits.consecutiveLossLimit));
        }
    }

    if (config.logLevel) {
        args.push('--log-level', config.logLevel);
    }

    return args;
}
```

**Verification**:
1. Set breakpoint in `buildDaemonArgs`, start a daemon session
2. Verify args array contains `--symbols` (not `--symbol`) and `--broker`
3. Daemon should parse args without error

**Dependencies**: None

---

### CODEX-003 [P0] Add `DAEMON_READY` stdout signal or replace with socket+health readiness

**Problem**: Extension waits for `"DAEMON_READY"` string in stdout (`LiveDaemonManager.ts:160`) but daemon never prints it. Startup hangs forever until timeout.

**Evidence**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:160` -- `waitForReady()` polls or watches stdout for "DAEMON_READY"
- `engine/quantlab/daemon/main.py` -- grep for "DAEMON_READY" returns 0 hits

**Root Cause**: Readiness signal was specified but never implemented in the daemon.

**Resolution**: Add stdout signal in daemon AND add socket-existence fallback in extension.

**Files to modify**:
- `engine/quantlab/daemon/main.py`
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`

**Implementation (Python side)**:

```python
# engine/quantlab/daemon/main.py
# In LiveTradingDaemon.start() method, after IPC server starts listening:

async def start(self):
    """Start the live trading daemon."""
    try:
        # ... existing initialization code ...

        # Start IPC server
        await self._ipc_server.start()

        # CODEX-003: Signal readiness to parent process (extension watches stdout)
        print("DAEMON_READY", flush=True)
        self._logger.info("Daemon ready, IPC server listening on %s", self._ipc_server.socket_path)

        # ... rest of start (broker connection, strategy load, etc.) ...
    except Exception as e:
        self._logger.error("Failed to start daemon: %s", e)
        raise
```

**Implementation (TypeScript side -- fallback)**:

```typescript
// extensions/quantlab/src/core/trading/LiveDaemonManager.ts
// In waitForReady() (around line 341), add socket-existence fallback:

private async waitForReady(sessionId: string, timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 500;

    while (Date.now() - startTime < timeoutMs) {
        // Check 1: stdout signal already received (set by process stdout handler)
        if (this.readySignalReceived.get(sessionId)) {
            return true;
        }

        // Check 2: Socket exists AND health check responds (fallback)
        try {
            const socketPath = getSocketPath(sessionId);
            if (await socketExists(sessionId)) {
                // Try a quick health check
                const client = new DaemonClient({ sessionId });
                try {
                    await client.connect();
                    const health = await client.getHealth();
                    if (health && health.status === 'ok') {
                        await client.disconnect();
                        return true;
                    }
                    await client.disconnect();
                } catch {
                    // Socket exists but daemon not ready yet -- continue polling
                }
            }
        } catch {
            // Socket doesn't exist yet -- continue polling
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return false;
}
```

**Verification**:
1. Start daemon from extension
2. Extension should detect readiness within 2-3 seconds (not timeout at 30s)
3. Check output channel shows daemon ready messages

**Dependencies**: CODEX-001 (socket path must match first)

---

### CODEX-004 [P0] Pass broker name and symbol list in session config

**Problem**: Extension doesn't pass broker name in session config. Daemon requires it to connect to the correct broker.

**Evidence**:
- `extensions/quantlab/src/core/trading/SessionManager.ts:1122` -- `startDaemonSession()` builds config
- `engine/quantlab/daemon/main.py:84-96` -- `SessionConfig` requires `broker` and `symbols`

**Root Cause**: Session config construction in extension was incomplete.

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// In startDaemonSession() (around line 1122), ensure broker and symbols are passed:

private async startDaemonSession(strategyPath: string, mode: 'paper' | 'live'): Promise<string> {
    const sessionId = this.generateSessionId();

    // Get broker configuration from settings
    const config = vscode.workspace.getConfiguration('quantlab.trading');
    const broker = config.get<string>('broker', 'alpaca');
    const symbols = config.get<string[]>('symbols', ['AAPL']);
    const timeframe = config.get<string>('timeframe', '1min');

    // Get risk limits from settings
    const riskConfig = vscode.workspace.getConfiguration('quantlab.risk');
    const riskLimits = {
        maxExposure: riskConfig.get<number>('maxExposure'),
        maxPositionSize: riskConfig.get<number>('maxPositionSize'),
        dailyLossLimit: riskConfig.get<number>('dailyLossLimit'),
        maxDrawdownPercent: riskConfig.get<number>('maxDrawdownPercent'),
        consecutiveLossLimit: riskConfig.get<number>('consecutiveLossLimit'),
    };

    const daemonConfig: DaemonConfig = {
        sessionId,
        strategyPath,
        broker,                    // CODEX-004: pass broker
        symbols,                   // CODEX-004: pass symbols
        timeframe,
        paper: mode === 'paper',
        riskLimits,
        logLevel: config.get<string>('logLevel', 'INFO'),
    };

    // Start daemon process
    const manager = LiveDaemonManager.getInstance();
    await manager.startDaemon(daemonConfig);

    // Wait for daemon to be ready
    const ready = await manager.waitForReady(sessionId);
    if (!ready) {
        throw new Error(`Daemon for session ${sessionId} failed to start within timeout`);
    }

    // Connect daemon client
    const client = new DaemonClient({ sessionId });
    await client.connect();
    this.daemonClients.set(sessionId, client);

    // Set up event handlers
    this.setupDaemonEventHandlers(sessionId, client);

    return sessionId;
}
```

**Verification**:
1. Start a daemon session from the extension
2. Check daemon logs show correct broker and symbols
3. Daemon should connect to the broker without error

**Dependencies**: CODEX-002 (CLI flags must be correct)

---

### CODEX-006 [P0] Route live trading through daemon (not in-extension broker adapter)

**Problem**: `startLiveSession` in `tradeCommands.ts:29` calls `sessionManager.startSession(path, 'live')` which uses an in-extension broker adapter, completely bypassing daemon safety controls (circuit breaker, exposure manager, reconciliation).

**Evidence**:
- `extensions/quantlab/src/commands/tradeCommands.ts:29` -- `quantlab.startLiveSession` calls `sessionManager.startSession(path, 'live')`
- `extensions/quantlab/src/core/trading/SessionManager.ts:418` -- `startSession()` uses in-extension broker adapter
- `extensions/quantlab/src/core/trading/SessionManager.ts:1122` -- `startDaemonSession()` uses daemon (correct path)

**Root Cause**: Architectural decision not yet enforced. Both paths exist; live trading must always use daemon.

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// In startSession() (around line 418), route live mode through daemon:

public async startSession(strategyPath: string, mode: 'paper' | 'live'): Promise<string> {
    // CODEX-006: Live trading MUST go through daemon for safety controls
    if (mode === 'live') {
        return this.startDaemonSession(strategyPath, mode);
    }

    // Paper trading can use either path
    // Check if daemon mode is preferred for paper too
    const config = vscode.workspace.getConfiguration('quantlab.trading');
    const useDaemonForPaper = config.get<boolean>('useDaemonForPaper', false);

    if (useDaemonForPaper) {
        return this.startDaemonSession(strategyPath, mode);
    }

    // Existing in-extension paper trading path (no safety concern for paper)
    return this._startInExtensionSession(strategyPath, mode);
}

// Rename existing startSession body to _startInExtensionSession
private async _startInExtensionSession(strategyPath: string, mode: 'paper' | 'live'): Promise<string> {
    // ... existing startSession implementation for paper trading ...
}
```

**Verification**:
1. Execute `quantlab.startLiveSession` command
2. Verify a daemon process spawns (check `ps aux | grep quantlab.daemon`)
3. Verify no direct broker adapter usage for live sessions

**Dependencies**: CODEX-001, CODEX-002, CODEX-003, CODEX-004 (daemon must be startable first)

---

### FIX-CGP-006 [P0] Create/fix daemon CLI entry point

**Problem**: The `__main__.py` CLI entry point needs to be consistent with what the extension invokes.

**Evidence**:
- `engine/quantlab/daemon/__main__.py` -- 321 lines, implements start/status/stop subcommands
- Extension invokes: `python -m quantlab.daemon start --session-id X --strategy Y --broker Z --symbols A B`

**Root Cause**: CLI entry point exists but may have inconsistencies with extension's invocation pattern.

**Files to modify**:
- `engine/quantlab/daemon/__main__.py`

**Implementation**:

Verify and ensure the following in `parse_args()`:

```python
# engine/quantlab/daemon/__main__.py
# Ensure parse_args() matches what LiveDaemonManager.buildDaemonArgs() sends:

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Quantlab Live Trading Daemon"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Start command
    start_parser = subparsers.add_parser("start", help="Start a live trading session")
    start_parser.add_argument("--session-id", required=True, help="Unique session identifier")
    start_parser.add_argument("--strategy", required=True, help="Path to strategy file")
    start_parser.add_argument("--broker", default="alpaca", help="Broker name (default: alpaca)")
    start_parser.add_argument("--symbols", nargs="+", required=True, help="Symbols to trade")
    start_parser.add_argument("--timeframe", default="1min", help="Bar timeframe")
    start_parser.add_argument("--paper", action="store_true", help="Paper trading mode")
    start_parser.add_argument("--daemonize", action="store_true", help="Run as background daemon")

    # Risk limits
    start_parser.add_argument("--max-exposure", type=float, help="Maximum total exposure")
    start_parser.add_argument("--max-position-size", type=float, help="Maximum position size")
    start_parser.add_argument("--daily-loss-limit", type=float, help="Daily loss limit (percent)")
    start_parser.add_argument("--max-drawdown-percent", type=float, help="Max drawdown percent")
    start_parser.add_argument("--consecutive-loss-limit", type=int, help="Max consecutive losses")
    start_parser.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"],
                              default="INFO", help="Logging level")

    # Status command
    status_parser = subparsers.add_parser("status", help="Check daemon status")
    status_parser.add_argument("--session-id", help="Session to check (all if omitted)")

    # Stop command
    stop_parser = subparsers.add_parser("stop", help="Stop a daemon")
    stop_parser.add_argument("--session-id", required=True, help="Session to stop")
    stop_parser.add_argument("--flatten", action="store_true", help="Flatten positions before stop")
    stop_parser.add_argument("--timeout", type=float, default=60.0, help="Shutdown timeout")

    return parser.parse_args()
```

**Verification**:
1. `python -m quantlab.daemon start --session-id test --strategy test.py --broker alpaca --symbols AAPL MSFT` should parse without error
2. `python -m quantlab.daemon status` should work
3. `python -m quantlab.daemon stop --session-id test` should work

**Dependencies**: None

---

### FIX-CGP-001 [P0] Add auth handshake after negotiate

**Problem**: Daemon requires explicit `authenticate` message with token. Extension only adds `_auth` param to negotiate message but doesn't send a separate auth message.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:357-470` -- `_handle_client()` expects negotiate then authenticate
- `extensions/quantlab/src/core/trading/DaemonClient.ts:154-225` -- `connect()` and `negotiate()` methods

**Root Cause**: Extension was built against a simpler auth model; daemon evolved to require separate handshake.

**Files to modify**:
- `extensions/quantlab/src/core/trading/DaemonClient.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/DaemonClient.ts
// In connect() method (around line 154), add explicit auth after negotiate:

public async connect(): Promise<void> {
    if (this.state === 'connected') {
        return;
    }

    this.setState('connecting');

    try {
        // Step 1: Establish transport connection
        await this.transport.connect();

        // Step 2: Protocol negotiation
        const negotiateResult = await this.negotiate();
        if (!negotiateResult.success) {
            throw new Error(`Protocol negotiation failed: ${negotiateResult.reason}`);
        }

        // Step 3: FIX-CGP-001 -- Explicit authentication
        const authResult = await this.authenticate();
        if (!authResult.success) {
            throw new Error(`Authentication failed: ${authResult.reason}`);
        }

        this.setState('connected');
        this.startHeartbeat();
        this.emit('connected');
    } catch (error) {
        this.setState('disconnected');
        throw error;
    }
}

// Add authenticate() method:
private async authenticate(): Promise<{ success: boolean; reason?: string }> {
    const token = await this.loadToken();
    if (!token) {
        return { success: false, reason: 'No auth token found' };
    }

    try {
        const result = await this.request('authenticate', {
            token,
            client_name: 'quantlab-extension',
            client_version: this.config.clientVersion ?? '1.0.0',
        });

        return { success: true };
    } catch (error: any) {
        return {
            success: false,
            reason: error.message ?? 'Authentication rejected',
        };
    }
}

private async loadToken(): Promise<string | null> {
    const tokenPath = path.join(
        os.homedir(), '.quantlab', 'sessions', `${this.config.sessionId}.token`
    );
    try {
        return await fs.promises.readFile(tokenPath, 'utf-8');
    } catch {
        return null;
    }
}
```

**Verification**:
1. Start daemon, attempt extension connection
2. Check daemon logs show "authenticate" message received and accepted
3. Subsequent IPC calls should work

**Dependencies**: CODEX-001 (socket path), CODEX-003 (daemon must be ready)

---

### FIX-CGP-002 [P0] Standardize IPC method names

**Problem**: Daemon has `pause`/`resume`/`stop` but spec and extension expect `session.pause`/`session.resume`/`session.stop`.

**Evidence**:
- `engine/quantlab/daemon/main.py:792-844` -- `_register_ipc_handlers()` registers method names
- `extensions/quantlab/src/core/trading/DaemonClient.ts:318-392` -- client calls `session.*` methods

**Root Cause**: Daemon registered shorter names without namespace prefix.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# In _register_ipc_handlers() (around line 792), use namespaced method names:

def _register_ipc_handlers(self):
    """Register all IPC method handlers."""
    server = self._ipc_server

    # Health & status
    server.register_handler("health", self._handle_health)
    server.register_handler("status", self._handle_status)

    # Session control -- FIX-CGP-002: use session.* namespace
    server.register_handler("session.start", self._handle_session_start)
    server.register_handler("session.pause", self._handle_session_pause)
    server.register_handler("session.resume", self._handle_session_resume)
    server.register_handler("session.stop", self._handle_session_stop)

    # Orders -- use order.* namespace
    server.register_handler("order.submit", self._handle_order_submit)
    server.register_handler("order.cancel", self._handle_order_cancel)
    server.register_handler("order.modify", self._handle_order_modify)

    # Positions
    server.register_handler("positions.get", self._handle_positions_get)
    server.register_handler("orders.get", self._handle_orders_get)
    server.register_handler("fills.get", self._handle_fills_get)
    server.register_handler("flatten.all", self._handle_flatten_all)
    server.register_handler("flatten.request", self._handle_flatten_request)

    # Risk & circuit breaker
    server.register_handler("circuit_breaker.status", self._handle_circuit_breaker_status)
    server.register_handler("risk.status", self._handle_risk_status)

    # Credentials
    server.register_handler("credentials.get", self._handle_credentials_get)
    server.register_handler("credentials.set", self._handle_credentials_set)
    server.register_handler("credentials.status", self._handle_credentials_status)

    # Reconciliation
    server.register_handler("reconciliation.trigger", self._handle_reconciliation_trigger)
    server.register_handler("reconciliation.status", self._handle_reconciliation_status)
    server.register_handler("reconciliation.apply", self._handle_reconciliation_apply)

    # System
    server.register_handler("update.check_allowed", self._handle_update_check_allowed)
    server.register_handler("heartbeat", self._handle_heartbeat)
```

**Verification**:
1. From extension, call `daemonClient.pauseSession()` -- should map to `session.pause`
2. Check daemon logs show method name matches registered handler
3. No "method not found" errors

**Dependencies**: FIX-CGP-001 (auth must work first)

---

### FIX-CGP-003 [P0] Add camelCase <-> snake_case schema adapter

**Problem**: Daemon sends snake_case JSON (Python convention). Extension expects camelCase (TypeScript convention). Daemon wraps responses in objects; extension may expect raw arrays.

**Evidence**:
- `engine/quantlab/daemon/main.py` -- all handlers return snake_case dicts
- `extensions/quantlab/src/core/trading/DaemonClient.ts` -- client code uses camelCase properties

**Root Cause**: No translation layer between Python and TypeScript naming conventions.

**Files to create**:
- `extensions/quantlab/src/core/ipc/SchemaAdapter.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/ipc/SchemaAdapter.ts

/**
 * Bidirectional adapter between daemon snake_case and extension camelCase schemas.
 *
 * Phase 0: immediate fix. Long-term: shared schema package.
 */

export class SchemaAdapter {
    /**
     * Convert snake_case keys to camelCase (daemon -> extension).
     */
    static toCamelCase<T = any>(obj: any): T {
        if (obj === null || obj === undefined) {
            return obj as T;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => SchemaAdapter.toCamelCase(item)) as T;
        }
        if (typeof obj === 'object' && !(obj instanceof Date)) {
            const result: Record<string, any> = {};
            for (const [key, value] of Object.entries(obj)) {
                const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                result[camelKey] = SchemaAdapter.toCamelCase(value);
            }
            return result as T;
        }
        return obj as T;
    }

    /**
     * Convert camelCase keys to snake_case (extension -> daemon).
     */
    static toSnakeCase<T = any>(obj: any): T {
        if (obj === null || obj === undefined) {
            return obj as T;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => SchemaAdapter.toSnakeCase(item)) as T;
        }
        if (typeof obj === 'object' && !(obj instanceof Date)) {
            const result: Record<string, any> = {};
            for (const [key, value] of Object.entries(obj)) {
                const snakeKey = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
                result[snakeKey] = SchemaAdapter.toSnakeCase(value);
            }
            return result as T;
        }
        return obj as T;
    }

    /**
     * Unwrap daemon response envelope.
     * Daemon wraps arrays in { data: [...] }; extension expects raw arrays.
     */
    static unwrapResponse<T = any>(response: any, key?: string): T {
        if (response === null || response === undefined) {
            return response as T;
        }

        // If a specific key is requested, extract it
        if (key && typeof response === 'object' && key in response) {
            return SchemaAdapter.toCamelCase(response[key]);
        }

        // Auto-unwrap common patterns
        if (typeof response === 'object' && !Array.isArray(response)) {
            // { data: [...] } -> [...]
            if ('data' in response && Array.isArray(response.data)) {
                return SchemaAdapter.toCamelCase(response.data);
            }
            // { positions: [...] } -> [...]
            if ('positions' in response && Array.isArray(response.positions)) {
                return SchemaAdapter.toCamelCase(response.positions);
            }
            // { orders: [...] } -> [...]
            if ('orders' in response && Array.isArray(response.orders)) {
                return SchemaAdapter.toCamelCase(response.orders);
            }
            // { fills: [...] } -> [...]
            if ('fills' in response && Array.isArray(response.fills)) {
                return SchemaAdapter.toCamelCase(response.fills);
            }
        }

        // Default: just convert casing
        return SchemaAdapter.toCamelCase(response);
    }

    /**
     * Wrap extension request params for daemon.
     */
    static wrapRequest(params: Record<string, any>): Record<string, any> {
        return SchemaAdapter.toSnakeCase(params);
    }
}
```

Then integrate into `DaemonClient.ts`:

```typescript
// extensions/quantlab/src/core/trading/DaemonClient.ts
// Add import:
import { SchemaAdapter } from '../ipc/SchemaAdapter';

// In request() method (around line 518), wrap outgoing and unwrap incoming:
public async request<T = any>(method: string, params?: Record<string, any>): Promise<T> {
    const wrappedParams = params ? SchemaAdapter.wrapRequest(params) : undefined;
    const rawResult = await this._sendRequest(method, wrappedParams);
    return SchemaAdapter.toCamelCase<T>(rawResult);
}

// In handleNotification() (around line 664), convert incoming notifications:
private handleNotification(method: string, params: any): void {
    const converted = SchemaAdapter.toCamelCase(params);
    // ... rest of notification handling with converted params ...
}
```

**Verification**:
1. Call `getPositions()` -- daemon returns `{ positions: [{ symbol: "AAPL", avg_price: 150.0 }] }`
2. Extension should receive `[{ symbol: "AAPL", avgPrice: 150.0 }]`
3. Call `submitOrder({ limitPrice: 150 })` -- daemon should receive `{ limit_price: 150 }`

**Dependencies**: FIX-CGP-001, FIX-CGP-002

---

### FIX-CGP-004 [P0] Add positions.get, orders.get, fills.get handlers

**Problem**: Extension calls `positions.get`, `orders.get`, `fills.get` but daemon may not have all handlers registered.

**Evidence**:
- `engine/quantlab/daemon/main.py:1532-1598` -- handlers exist but may need verification
- `extensions/quantlab/src/core/trading/DaemonClient.ts:371-438` -- client calls these methods

**Root Cause**: Handlers were partially implemented.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

Ensure these handlers are fully implemented and registered:

```python
# engine/quantlab/daemon/main.py

async def _handle_positions_get(self, params: dict) -> dict:
    """Return current positions."""
    positions = []
    for symbol, pos in self._positions.items():
        positions.append({
            "symbol": symbol,
            "quantity": pos.quantity,
            "avg_price": pos.avg_price,
            "market_price": pos.market_price,
            "market_value": pos.market_value,
            "unrealized_pnl": pos.unrealized_pnl,
            "realized_pnl": pos.realized_pnl,
            "side": "long" if pos.quantity > 0 else "short",
            "cost_basis": pos.cost_basis,
        })
    return {"positions": positions}

async def _handle_orders_get(self, params: dict) -> dict:
    """Return open orders."""
    orders = []
    for order in self._open_orders.values():
        orders.append({
            "order_id": order.order_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": order.quantity,
            "filled_quantity": order.filled_quantity,
            "limit_price": order.limit_price,
            "stop_price": order.stop_price,
            "status": order.status.value,
            "created_at": order.created_at.isoformat(),
            "time_in_force": order.time_in_force.value,
        })
    return {"orders": orders}

async def _handle_fills_get(self, params: dict) -> dict:
    """Return recent fills."""
    limit = params.get("limit", 100)
    fills = []
    for fill in self._recent_fills[-limit:]:
        fills.append({
            "fill_id": fill.fill_id,
            "order_id": fill.order_id,
            "symbol": fill.symbol,
            "side": fill.side.value,
            "quantity": fill.quantity,
            "price": fill.price,
            "commission": fill.commission,
            "timestamp": fill.timestamp.isoformat(),
        })
    return {"fills": fills}
```

**Verification**:
1. From extension, call `daemonClient.getPositions()` -- should return array
2. Call `daemonClient.getOrders()` -- should return array
3. Call `daemonClient.getFills()` -- should return array with most recent fills

**Dependencies**: FIX-CGP-002 (method names must match)

---

### FIX-CGP-005 [P0] Add `*.update` notification suffixes

**Problem**: Daemon emits `positions` notification but client listens for `positions.update` (suffix mismatch).

**Evidence**:
- `engine/quantlab/daemon/main.py:1738` -- `_broadcast_position_update()` uses notification name
- `extensions/quantlab/src/core/trading/DaemonClient.ts:664` -- `handleNotification()` routes by method name

**Root Cause**: Naming convention mismatch between daemon broadcast and client listener.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# Update broadcast methods to use .update suffix:

async def _broadcast_position_update(self, position_data: dict):
    """Broadcast position update to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        method="positions.update",   # FIX-CGP-005: add .update suffix
        params=position_data,
    ))

async def _broadcast_order_update(self, order_data: dict):
    """Broadcast order update to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        method="orders.update",      # FIX-CGP-005: add .update suffix
        params=order_data,
    ))

async def _broadcast_fill_update(self, fill_data: dict):
    """Broadcast fill notification to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        method="fills.update",       # FIX-CGP-005: add .update suffix
        params=fill_data,
    ))

async def _broadcast_risk_alert(self, alert_data: dict):
    """Broadcast risk alert to all connected clients."""
    await self._ipc_server.broadcast(Notification(
        method="risk.alert",         # Keep as-is (no change needed)
        params=alert_data,
    ))

async def _broadcast_connection_status(self, status_data: dict):
    """Broadcast connection status update."""
    await self._ipc_server.broadcast(Notification(
        method="connection.update",  # FIX-CGP-005: add .update suffix
        params=status_data,
    ))
```

**Verification**:
1. Start daemon with connected extension client
2. When position changes, extension should receive `positions.update` notification
3. DaemonClient.handleNotification() should route to correct handler

**Dependencies**: FIX-CGP-002, FIX-CGP-003

---

### FIX-P001 [P0] Register missing IPC message types

**Problem**: Some message types expected by the protocol are not registered as handlers.

**Evidence**:
- `engine/quantlab/daemon/main.py:792-844` -- registered handlers
- `engine/quantlab/protocol/message.py` -- defines all message types

**Root Cause**: Handler registration was done incrementally and some were missed.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

After FIX-CGP-002 is applied, verify all expected methods have handlers. Add any missing ones:

```python
# engine/quantlab/daemon/main.py
# In _register_ipc_handlers(), add any missing handlers:

# These should all be registered (verify each exists):
# - health
# - status
# - session.start, session.pause, session.resume, session.stop
# - order.submit, order.cancel, order.modify
# - positions.get, orders.get, fills.get
# - flatten.all, flatten.request
# - circuit_breaker.status, risk.status
# - credentials.get, credentials.set, credentials.status
# - reconciliation.trigger, reconciliation.status, reconciliation.apply
# - update.check_allowed
# - heartbeat

# Add placeholder for any missing:
async def _handle_risk_status(self, params: dict) -> dict:
    """Return current risk status."""
    return {
        "exposure": self._exposure_manager.snapshot().to_dict() if self._exposure_manager else {},
        "circuit_breaker": {
            "state": self._circuit_breaker.state.value if self._circuit_breaker else "unknown",
            "trip_count": self._circuit_breaker.trip_count if self._circuit_breaker else 0,
        },
        "daily_pnl": self._calculate_daily_pnl(),
        "risk_limits": self._config.risk_limits,
    }

async def _handle_credentials_set(self, params: dict) -> dict:
    """Set broker credentials securely."""
    broker = params.get("broker")
    credentials = params.get("credentials", {})
    if not broker or not credentials:
        return {"success": False, "error": "Missing broker or credentials"}

    try:
        self._secrets_manager.store(broker, credentials)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def _handle_heartbeat(self, params: dict) -> dict:
    """Respond to heartbeat."""
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "uptime_seconds": (datetime.utcnow() - self._start_time).total_seconds(),
    }
```

**Verification**:
1. Call every registered method from test client
2. No "method not found" errors
3. All return valid response dicts

**Dependencies**: FIX-CGP-002

---

### CODEX-008 [P1] Handle IPC state snapshot after auth (id=null response)

**Problem**: Daemon sends state snapshot as JSON-RPC result with `id: null` after auth. Client ignores results without matching pending request ID.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:444` -- sends snapshot after successful auth
- `extensions/quantlab/src/core/trading/DaemonClient.ts:601-623` -- `handleMessage()` routes by presence of `id`

**Root Cause**: JSON-RPC spec says results must have an `id` matching the request. `id: null` is valid but won't match any pending request.

**Files to modify**:
- `extensions/quantlab/src/core/trading/DaemonClient.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/DaemonClient.ts
// In handleMessage() (around line 601):

private handleMessage(message: any): void {
    if (!message || typeof message !== 'object') {
        return;
    }

    // JSON-RPC response (has result or error)
    if ('id' in message && message.id !== null && message.id !== undefined) {
        if ('error' in message) {
            this.handleErrorResponse(message);
        } else {
            this.handleResponse(message);
        }
        return;
    }

    // CODEX-008: Handle state snapshot (result with id=null, sent after auth)
    if ('result' in message && (message.id === null || message.id === undefined)) {
        this.handleStateSnapshot(message.result);
        return;
    }

    // JSON-RPC notification (has method, no id)
    if ('method' in message) {
        this.handleNotification(message.method, message.params);
        return;
    }
}

private handleStateSnapshot(snapshot: any): void {
    if (!snapshot) {
        return;
    }

    const converted = SchemaAdapter.toCamelCase(snapshot);
    this.emit('stateSnapshot', converted);

    // Apply snapshot to local state
    if (converted.positions) {
        this.emit('positionsUpdate', converted.positions);
    }
    if (converted.orders) {
        this.emit('ordersUpdate', converted.orders);
    }
    if (converted.status) {
        this.emit('statusUpdate', converted.status);
    }
}
```

**Verification**:
1. Connect to daemon, authenticate
2. State snapshot should be received and processed (not silently dropped)
3. Extension UI should show initial positions/orders

**Dependencies**: FIX-CGP-001, FIX-CGP-003

---

### FIX-CGP-007 [P1] Fix token ownership race

**Problem**: Daemon generates token, writes to file. Extension must wait for file before connecting. Race condition if extension connects before token is written.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:56-142` -- `TokenManager.generate()` writes token file
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:160` -- waits for readiness

**Root Cause**: No synchronization between daemon token write and extension token read.

**Files to modify**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/LiveDaemonManager.ts
// Add token polling to waitForReady() or startDaemon():

private async waitForToken(sessionId: string, timeoutMs: number = 10000): Promise<string | null> {
    const tokenPath = path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.token`);
    const startTime = Date.now();
    const pollIntervalMs = 200;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const token = await fs.promises.readFile(tokenPath, 'utf-8');
            if (token && token.trim().length > 0) {
                return token.trim();
            }
        } catch {
            // File doesn't exist yet
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return null;
}

// In startDaemon(), after spawning process:
public async startDaemon(config: DaemonConfig, options?: DaemonStartOptions): Promise<void> {
    // ... spawn process ...

    // Wait for token file to appear (daemon writes it before DAEMON_READY)
    const token = await this.waitForToken(config.sessionId);
    if (!token) {
        throw new Error(`Daemon token for session ${config.sessionId} not generated within timeout`);
    }

    // Wait for daemon ready (socket + health check)
    const ready = await this.waitForReady(config.sessionId, options?.readyTimeoutMs);
    if (!ready) {
        throw new Error(`Daemon for session ${config.sessionId} failed to become ready`);
    }
}
```

**Verification**:
1. Start daemon, verify token file exists before extension connects
2. Race condition eliminated: extension polls until token is available
3. No "authentication failed" errors due to missing token

**Dependencies**: CODEX-003 (readiness flow)

---

### FIX-P003 [P1] Compute fresh state snapshot on reconnect

**Problem**: On client reconnect, daemon should send a fresh state snapshot so client can resync. Currently may send stale cached data.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:439-449` -- snapshot sent after auth

**Root Cause**: Snapshot is captured once and may not reflect current state on reconnect.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# In _handle_client() after successful auth, call snapshot callback:

async def _handle_client(self, reader, writer):
    """Handle incoming client connection."""
    client = ClientConnection(reader, writer)

    try:
        # ... negotiate + authenticate ...

        # After auth, send fresh snapshot
        if self._snapshot_callback:
            snapshot = await self._snapshot_callback()
            await client.send_result(None, snapshot)  # id=null for unsolicited snapshot

        # Add to connected clients
        self._clients.add(client)
        # ... message loop ...

# In IPCServer.__init__, add snapshot callback:
def __init__(self, session_id: str, snapshot_callback=None, ...):
    self._snapshot_callback = snapshot_callback
    # ...

# engine/quantlab/daemon/main.py
# In __init__, pass snapshot callback to IPC server:

def __init__(self, config: SessionConfig):
    # ...
    self._ipc_server = IPCServer(
        session_id=config.session_id,
        snapshot_callback=self._get_state_snapshot,
    )

async def _get_state_snapshot(self) -> dict:
    """Build fresh state snapshot for newly connected clients."""
    return {
        "status": self.state,
        "session_id": self._config.session_id,
        "positions": [
            {
                "symbol": sym,
                "quantity": pos.quantity,
                "avg_price": pos.avg_price,
                "market_price": pos.market_price,
                "unrealized_pnl": pos.unrealized_pnl,
            }
            for sym, pos in self._positions.items()
        ],
        "orders": [
            {
                "order_id": o.order_id,
                "symbol": o.symbol,
                "side": o.side.value,
                "quantity": o.quantity,
                "status": o.status.value,
            }
            for o in self._open_orders.values()
        ],
        "risk": {
            "exposure": self._exposure_manager.snapshot().to_dict() if self._exposure_manager else {},
            "circuit_breaker_state": self._circuit_breaker.state.value if self._circuit_breaker else "unknown",
        },
        "timestamp": datetime.utcnow().isoformat(),
    }
```

**Verification**:
1. Connect client, verify snapshot received
2. Disconnect and reconnect -- new snapshot should reflect current state, not cached
3. Add a position between connections -- reconnect snapshot includes it

**Dependencies**: FIX-CGP-001

---

### NEW-IPC-001 [P1] Add _meta.sequence consumption in DaemonClient

**Problem**: Daemon sends `_meta.sequence` numbers for ordering guarantees, but client ignores them.

**Evidence**:
- `engine/quantlab/daemon/main.py` -- broadcasts include sequence numbers
- `extensions/quantlab/src/core/trading/DaemonClient.ts` -- no sequence tracking

**Root Cause**: Feature was added on daemon side but not consumed on client side.

**Files to modify**:
- `extensions/quantlab/src/core/trading/DaemonClient.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/DaemonClient.ts
// Add sequence tracking:

private lastSequence: number = 0;
private sequenceGapCallbacks: Array<(gap: { expected: number; received: number }) => void> = [];

private handleNotification(method: string, params: any): void {
    // NEW-IPC-001: Track sequence numbers
    if (params && params._meta && typeof params._meta.sequence === 'number') {
        const seq = params._meta.sequence;
        if (seq > this.lastSequence + 1 && this.lastSequence > 0) {
            // Gap detected -- may have missed messages
            this.emit('sequenceGap', {
                expected: this.lastSequence + 1,
                received: seq,
                method,
            });
        }
        this.lastSequence = seq;
    }

    const converted = SchemaAdapter.toCamelCase(params);

    // Route notification by method name
    switch (method) {
        case 'positions.update':
            this.emit('positionsUpdate', converted);
            break;
        case 'orders.update':
            this.emit('ordersUpdate', converted);
            break;
        case 'fills.update':
            this.emit('fillsUpdate', converted);
            break;
        case 'risk.alert':
            this.emit('riskAlert', converted);
            break;
        case 'connection.update':
            this.emit('connectionUpdate', converted);
            break;
        case 'heartbeat':
            this.emit('heartbeat', converted);
            break;
        default:
            this.emit('notification', { method, params: converted });
    }
}
```

**Verification**:
1. Monitor notifications -- sequence numbers should increment
2. Simulate gap (e.g., by dropping a message) -- `sequenceGap` event should fire
3. No state corruption from out-of-order messages

**Dependencies**: FIX-CGP-005

---

### FIX-P005 [P2] Fix version negotiation (pick highest mutual)

**Problem**: Version negotiation picks first version instead of highest mutually supported version.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:472-525` -- `_handle_negotiate()`

**Root Cause**: Simple implementation that doesn't properly negotiate.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# In _handle_negotiate() (around line 472):

async def _handle_negotiate(self, client: ClientConnection, params: dict) -> dict:
    """Handle protocol version negotiation."""
    client_versions = params.get("supported_versions", ["1.0"])

    # FIX-P005: Pick highest mutually supported version
    mutual = sorted(
        set(client_versions) & set(self.SUPPORTED_VERSIONS),
        key=lambda v: tuple(int(x) for x in v.split(".")),
        reverse=True,
    )

    if not mutual:
        return {
            "success": False,
            "error": f"No compatible protocol version. Server supports: {self.SUPPORTED_VERSIONS}, "
                     f"client supports: {client_versions}",
        }

    selected_version = mutual[0]
    client.protocol_version = selected_version

    return {
        "success": True,
        "version": selected_version,
        "server_versions": self.SUPPORTED_VERSIONS,
    }
```

**Verification**:
1. Client sends `["1.0", "2.0"]`, server supports `["1.0"]` -- selects "1.0"
2. Client sends `["1.0", "2.0"]`, server supports `["1.0", "2.0"]` -- selects "2.0"
3. Client sends `["3.0"]`, server supports `["1.0"]` -- returns error

**Dependencies**: None

---

### FIX-P004 [P2] Replace magic error numbers with ErrorCode enum

**Problem**: IPC error responses use raw integers like `-32600`, `-32601`. These should use a named enum.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:521-530` -- error codes are inline integers

**Root Cause**: Quick implementation without proper constants.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# Add at module level (around line 20):

class ErrorCode:
    """JSON-RPC 2.0 error codes."""
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603

    # Custom application errors
    AUTH_REQUIRED = -32000
    AUTH_FAILED = -32001
    SESSION_NOT_FOUND = -32002
    RATE_LIMITED = -32003
    EXPOSURE_LIMIT = -32004
    CIRCUIT_BREAKER = -32005

# Replace all magic numbers:
# BEFORE: {"code": -32601, "message": "Method not found"}
# AFTER:  {"code": ErrorCode.METHOD_NOT_FOUND, "message": "Method not found"}
```

**Verification**:
1. `grep -rn "32600\|32601\|32700" engine/quantlab/daemon/ipc.py` -- only in ErrorCode class
2. All error responses use `ErrorCode.*` constants

**Dependencies**: None

---

### FIX-D008 [P2] Fix broadcast dict-during-iteration race

**Problem**: Broadcasting iterates over connected clients dict, but a client may disconnect during iteration causing `RuntimeError: dictionary changed size during iteration`.

**Evidence**:
- `engine/quantlab/daemon/ipc.py:289-299` -- `broadcast()` iterates `self._clients`

**Root Cause**: Concurrent modification of client set during async broadcast.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py
# In IPCServer.broadcast() (around line 289):

async def broadcast(self, notification: Notification):
    """Broadcast notification to all connected clients."""
    # FIX-D008: Copy client set to avoid dict-during-iteration race
    async with self._clients_lock:
        clients = list(self._clients)

    # Send to all clients, remove disconnected ones
    disconnected = []
    for client in clients:
        try:
            await client.send(notification.to_dict())
        except (ConnectionError, BrokenPipeError, OSError):
            disconnected.append(client)
        except Exception as e:
            self._logger.warning("Broadcast error for client %s: %s", client.id, e)
            disconnected.append(client)

    # Clean up disconnected clients
    if disconnected:
        async with self._clients_lock:
            for client in disconnected:
                self._clients.discard(client)
                try:
                    await client.close()
                except Exception:
                    pass
```

**Verification**:
1. Connect multiple clients, disconnect one mid-broadcast
2. No `RuntimeError: dictionary changed size during iteration`
3. Disconnected client is removed from set

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] Daemon starts and creates socket at `~/.quantlab/sessions/{id}.sock`
- [ ] Extension receives `DAEMON_READY` signal or detects readiness via health check
- [ ] Extension connects to daemon socket successfully
- [ ] Auth handshake (negotiate + authenticate) completes without error
- [ ] IPC method names match between extension and daemon
- [ ] camelCase/snake_case conversion works for requests and responses
- [ ] `getPositions()`, `getOrders()`, `getFills()` return correct data
- [ ] Position/order/fill notifications arrive with `.update` suffix
- [ ] State snapshot received on connect (including reconnect)
- [ ] Sequence numbers tracked, gaps detected
- [ ] Version negotiation picks highest mutual version
- [ ] Error responses use named ErrorCode constants
- [ ] Broadcast handles client disconnection gracefully
- [ ] Token race condition resolved (extension waits for token)
- [ ] All 19 fixes verified

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "Extension has no IPC client" | DaemonClient.ts is 728 lines with full JSON-RPC implementation |
| "No socket transport" | SocketTransport.ts is 336 lines with reconnection logic |
| "No daemon process management" | LiveDaemonManager.ts is 407 lines with spawn, stop, status |
| "Auth not implemented" | Token-based auth exists in DaemonClient but handshake sequence needs fixing |
