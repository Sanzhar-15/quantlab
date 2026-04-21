# Phase 1: Critical Infrastructure

**Duration**: 5 weeks
**Priority**: CRITICAL - Foundation for safe live trading
**Spec References**: Technical Spec §1.5-1.6, §11.1, §11.4.1, §13.3
**Decisions Reference**: A4, A5, E27, E28, E29, E30, F33, N87, N96-N100

---

## Objectives

This phase establishes the foundational infrastructure required for safe live trading:

1. **Daemon Process Architecture** - Live trading that survives UI crashes (Hybrid: Python + TypeScript IPC)
2. **IPC Protocol** - JSON-RPC 2.0 over Unix sockets / Named pipes
3. **Exposure Reservation Model** - Prevent concurrent order race conditions
4. **Secrets Encrypted Fallback** - Secure credential storage on headless systems
5. **Structured Logging** - JSON logs with rotation and retention
6. **Health & Watchdog** - Daemon health endpoint and UI watchdog
7. **Benchmark Harness** - Performance regression detection

---

## 1. Live Daemon Architecture

### 1.1 Background

**Current State**: Live trading runs in the same process as the UI. If the UI crashes, positions are orphaned.

**Target State**: Live trading runs in a separate daemon process that:
- Survives UI termination
- Can be reconnected to by restarted UI
- Maintains circuit breakers independently
- Checkpoints state for crash recovery

### 1.2 Implementation Tasks

| Task | Effort | Files Affected |
|------|--------|----------------|
| Create daemon process entry point | 3d | `engine/daemon/main.py` (NEW) |
| Implement PID file management | 1d | `engine/daemon/lifecycle.py` (NEW) |
| Implement IPC socket communication | 3d | `engine/daemon/ipc.py` (NEW) |
| Implement UI reconnection logic | 2d | `extensions/quantlab/src/core/trading/DaemonClient.ts` (NEW) |
| Implement daemon watchdog | 2d | `engine/daemon/watchdog.py` (NEW) |
| Implement checkpoint/recovery | 3d | `engine/daemon/checkpoint.py` (NEW) |
| System sleep/wake handling | 2d | `engine/daemon/power.py` (NEW) |
| Update SessionManager for daemon | 2d | `extensions/quantlab/src/core/trading/SessionManager.ts` |

### 1.3 Directory Structure (New)

```
~/.quantlab/
├── sessions/
│   ├── {session_id}.pid       # PID file
│   └── {session_id}.state     # Checkpoint state
├── sockets/
│   └── {session_id}.sock      # IPC socket (Unix)
└── logs/
    └── daemon_{session_id}.log
```

### 1.4 IPC Protocol (Decision N96)

**Protocol**: JSON-RPC 2.0 over Unix sockets (Linux/macOS) or Named pipes (Windows)

```typescript
// Request format
{ "jsonrpc": "2.0", "method": "submitOrder", "params": {...}, "id": "req-001" }

// Response format
{ "jsonrpc": "2.0", "result": {...}, "id": "req-001" }

// Notification (no response)
{ "jsonrpc": "2.0", "method": "progress", "params": { "percent": 45 } }
```

### 1.5 IPC Message Catalog (from ChatGPT plan)

**Complete message types with reliability classes** (see Appendix_B for full details):

| Stream | Payload Type | Class | Ack | Buffer | Snapshot |
|--------|--------------|-------|-----|--------|----------|
| control | session.start | Critical | Yes | None | N/A |
| control | session.stop | Critical | Yes | None | N/A |
| control | session.pause | Critical | Yes | None | N/A |
| control | session.resume | Critical | Yes | None | N/A |
| control | order.submit | Critical | Yes | None | N/A |
| control | order.cancel | Critical | Yes | None | N/A |
| control | order.modify | Critical | Yes | None | N/A |
| control | flatten.request | Critical | Yes | None | N/A |
| control | risk.action | Critical | Yes | None | N/A |
| state | positions.update | Important | No | 1000 | Yes |
| state | orders.update | Important | No | 1000 | Yes |
| state | fills.update | Important | No | 1000 | Yes |
| state | performance.update | Important | No | 1000 | Yes |
| status | heartbeat | Telemetry | No | 100 | N/A |
| status | connection.status | Important | No | 1000 | Yes |
| status | risk.alert | Important | No | 1000 | Yes |
| logs | log.entry | Telemetry | No | 1000 | No |

**Reliability Classes**:
- **Critical**: ACK required, retry 3x with exponential backoff
- **Important**: Best-effort + snapshot on reconnect, bounded buffer
- **Telemetry**: Fire-and-forget, dropped when buffer full

### 1.6 IPC Authentication (Decision E29)

- Socket/pipe has 0600 permissions (owner only)
- Token file generated on daemon start: `~/.quantlab/sessions/{id}.token`
- All IPC requests must include token
- Token rotated on each session start

### 1.7 Message Reliability (Decision E30)

| Message Type | Reliability |
|--------------|-------------|
| Orders (critical) | ACK required, retry 3x with exponential backoff |
| Progress | Fire-and-forget (loss acceptable) |
| Buffer limit | 1000 messages, then backpressure |

### 1.7 Key Interfaces

```typescript
// DaemonClient.ts
interface DaemonClient {
  connect(sessionId: string, token: string): Promise<DaemonHandle>;
  reconnect(): Promise<SessionState | null>;
  sendCommand(cmd: DaemonCommand): Promise<CommandResult>;
  onStateChange(callback: (state: SessionState) => void): Disposable;
  health(): Promise<HealthStatus>;  // Decision N98
  disconnect(): void;
}

interface DaemonCommand {
  type: 'start' | 'stop' | 'pause' | 'resume' | 'flatten';
  payload?: any;
}
```

```python
# engine/daemon/main.py
class LiveTradingDaemon:
    def __init__(self, session_config: SessionConfig):
        self.session_id = session_config.id
        self.strategy = load_strategy(session_config.strategy_path)
        self.broker = connect_broker(session_config.broker)
        self.exposure_manager = ExposureManager(session_config.risk_limits)

    async def run(self):
        """Main daemon loop."""
        await self.checkpoint_loop()
        await self.heartbeat_loop()
        await self.trading_loop()
```

### 1.8 Testing Requirements

| Test ID | Description | Type |
|---------|-------------|------|
| D001 | Daemon starts as detached process | Integration |
| D002 | UI crash doesn't stop daemon | Chaos |
| D003 | UI reconnects to running daemon | Integration |
| D004 | Checkpoint written on signal | Unit |
| D005 | State recovered from checkpoint | Integration |
| D006 | Sleep/wake handled correctly | Integration |
| D007 | Health endpoint returns status | Unit |
| D008 | Watchdog detects dead daemon | Integration |
| D009 | Graceful shutdown completes in <60s | Integration |
| D010 | IPC token authentication works | Security |

### 1.9 Acceptance Criteria

- [ ] Daemon process survives `kill -9` on Electron process
- [ ] UI can reconnect within 5 seconds of restart
- [ ] Checkpoint written within 1 second of state change
- [ ] Recovery loses <1 bar of state on crash

### 1.10 Restart Policy (Decisions L69, N99)

**CRITICAL**: The daemon must NEVER auto-restart. This prevents surprise trading after system recovery.

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| OS reboot | No auto-start | User must consciously start live sessions (L69) |
| Daemon crash | Watchdog shows dialog, NO auto-restart | Avoid surprise trading (N99) |
| UI restart | Can reconnect to existing daemon | Daemon survives UI crash |

**On app launch after OS reboot**:
1. Check for previous session checkpoint
2. If found, show dialog: "Previous session was interrupted. Reconnect?"
3. User chooses: [Reconnect] | [Discard] | [View Only]

**On watchdog detecting dead daemon**:
1. Show modal: "Daemon is unresponsive"
2. Options: [Attempt Reconnect] | [Stop Session] | [View Logs]
3. Do NOT automatically restart the daemon

| Test ID | Description |
|---------|-------------|
| D011 | Daemon does not auto-start after reboot |
| D012 | Watchdog shows dialog but does not auto-restart |

### 1.11 Market Hours and Overnight State (Decision H50)

The daemon stays running overnight for users with swing/overnight positions.

**Daemon states**:

| State | Description | Resource Usage |
|-------|-------------|----------------|
| ACTIVE | Market open, strategy running | Normal |
| PAUSED | User paused | Low (no signals) |
| MARKET_CLOSED | Outside market hours | Minimal |

**Market closed behavior**:
- Strategy evaluation paused (no signals generated)
- Positions maintained
- Heartbeat continues (5s interval)
- Memory usage reduced (release indicator caches)
- Ready for pre-market if user configures

**Transition triggers**:
- Market close → Enter MARKET_CLOSED state
- Market open → Resume ACTIVE state (if was running)
- User can configure pre-market start time

| Test ID | Description |
|---------|-------------|
| D013 | Daemon enters MARKET_CLOSED state after close |
| D014 | Daemon resumes ACTIVE state at market open |

---

## 2. Exposure Reservation Model

### 2.1 Background

**Current State**: Risk limits checked at order submission time only. Concurrent orders can both pass checks but breach limits when filled.

**Target State**: Thread-safe reservation system that:
- Reserves exposure before order submission
- Releases on fill/cancel/reject
- Handles partial fills correctly
- Supports order modification

### 2.1.1 Dual Implementation Requirement

**IMPORTANT**: ExposureManager must be implemented in BOTH languages:

| Component | Language | Purpose |
|-----------|----------|---------|
| `engine/risk/exposure.py` | Python | Daemon-side enforcement (authoritative) |
| `extensions/quantlab/src/core/risk/ExposureManager.ts` | TypeScript | UI-side pre-check (advisory) |

The Python implementation in the daemon is the **authoritative source**. The TypeScript implementation provides early feedback to the UI before orders reach the daemon.

### 2.2 Implementation Tasks

| Task | Effort | Files Affected |
|------|--------|----------------|
| Create Python ExposureManager (authoritative) | 2d | `engine/risk/exposure.py` (NEW) |
| Create TypeScript ExposureManager (advisory) | 2d | `extensions/quantlab/src/core/risk/ExposureManager.ts` (NEW) |
| Implement reservation logic (both) | 2d | Both files |
| Implement commit/release on fill | 1d | `engine/risk/exposure.py` |
| Integrate with daemon order submission | 2d | `engine/daemon/main.py` |
| Integrate UI pre-check | 1d | `extensions/quantlab/src/core/trading/SessionManager.ts` |
| Handle order modifications | 1d | `engine/risk/exposure.py` |
| Implement timeout cleanup | 1d | Same |
| Unit tests (100% coverage) | 2d | `tests/risk/exposure.test.ts`, `tests/risk/test_exposure.py` (NEW) |

### 2.3 Key Interface

```typescript
// ExposureManager.ts
class ExposureManager {
  private maxExposure: number;
  private currentExposure: number = 0;
  private reservedExposure: number = 0;
  private reservations: Map<string, ReservationHandle> = new Map();

  reserve(order: OrderRequest): ReservationResult {
    // Thread-safe reservation
    const projected = this.calculateProjectedExposure(order);
    const total = this.currentExposure + this.reservedExposure + projected;

    if (total > this.maxExposure) {
      return { success: false, reason: 'EXPOSURE_LIMIT_BREACH' };
    }

    const handle = this.createReservation(order.id, projected);
    return { success: true, handle };
  }

  commit(orderId: string, fill: Fill): void {
    // Convert reservation to actual exposure
    const reservation = this.reservations.get(orderId);
    if (reservation) {
      this.reservedExposure -= reservation.amount;
      this.currentExposure += fill.actualExposure;

      if (fill.isPartial) {
        // Keep partial reservation
        this.reservations.set(orderId, {
          ...reservation,
          amount: reservation.amount - fill.actualExposure
        });
      } else {
        this.reservations.delete(orderId);
      }
    }
  }

  release(orderId: string): void {
    // Release reservation (cancel/reject)
    const reservation = this.reservations.get(orderId);
    if (reservation) {
      this.reservedExposure -= reservation.amount;
      this.reservations.delete(orderId);
    }
  }
}
```

### 2.4 Testing Requirements

| Test ID | Description | Type |
|---------|-------------|------|
| E001 | Single order reserves correctly | Unit |
| E002 | Concurrent orders reserve correctly | Unit |
| E003 | Fill commits reservation | Unit |
| E004 | Cancel releases reservation | Unit |
| E005 | Partial fill partial release | Unit |
| E006 | Reservation prevents breach | Unit |
| E007 | Order modification adjusts reservation | Unit |
| E008 | Timeout releases stale reservation | Unit |
| E009 | Thread safety under load | Stress |

### 2.5 Acceptance Criteria

- [ ] 100% test coverage on ExposureManager
- [ ] No exposure breaches in concurrent order tests
- [ ] Timeout cleanup runs every 30 seconds
- [ ] Reservation metrics exposed for monitoring

### 2.6 Consecutive Loss Tracking (Decision L74)

Track consecutive losing trades and trigger circuit breaker at threshold.

```python
# engine/risk/consecutive.py
class ConsecutiveLossTracker:
    def __init__(self, limit: int = 3):
        self.limit = limit
        self.consecutive_losses = 0

    def record_trade(self, pnl: Decimal) -> bool:
        """Returns True if circuit breaker should trigger."""
        if pnl < 0:
            self.consecutive_losses += 1
            if self.consecutive_losses >= self.limit:
                return True  # Trigger circuit breaker
        else:
            self.consecutive_losses = 0  # Reset on win
        return False
```

**Implementation Tasks**:

| Task | Effort | Files |
|------|--------|-------|
| Consecutive loss tracker | 0.5d | `engine/risk/consecutive.py` (NEW) |
| Integration with fill handler | 0.5d | `engine/daemon/fills.py` |
| Circuit breaker trigger | 0.5d | `engine/risk/circuit_breaker.py` |

**Testing Requirements**:

| Test ID | Description |
|---------|-------------|
| E010 | 3 consecutive losses triggers circuit breaker |
| E011 | Win resets consecutive loss counter |

---

## 5. Structured Logging (Decision N87)

### 5.1 Log Files

| File | Content | Rotation | Retention |
|------|---------|----------|-----------|
| `app.log` | UI events | 10MB × 5 files | 7 days |
| `engine.log` | Engine events | 50MB × 10 files | 30 days |
| `daemon.log` | Per-session daemon | 50MB × 5 files | 90 days |
| `audit.log` | Trading actions | Never rotated | **7 years** (compliance) |

### 5.2 Format

**JSON Lines** (one JSON object per line):

```json
{"timestamp": "2026-01-25T14:30:00Z", "level": "INFO", "logger": "daemon", "message": "Order submitted", "context": {"order_id": "ord-123", "symbol": "AAPL"}}
```

### 5.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Logging configuration | 1d | `engine/logging/config.py` (NEW) |
| Rotation handler | 0.5d | Same |
| Audit log (append-only) | 1d | `engine/logging/audit.py` (NEW) |

---

## 6. Secrets Encrypted Fallback

### 3.1 Background

**Current State**: Secrets stored only in OS Keychain. Fails on headless Linux.

**Target State**: Two-tier secrets storage:
1. Primary: OS Keychain (when available)
2. Fallback: AES-256-GCM encrypted file with Argon2id key derivation

### 3.2 Implementation Tasks

| Task | Effort | Files Affected |
|------|--------|----------------|
| Detect keychain availability | 1d | `extensions/quantlab/src/core/secrets/backend.ts` (NEW) |
| Implement encrypted file backend | 3d | `extensions/quantlab/src/core/secrets/encrypted.ts` (NEW) |
| Implement Argon2id key derivation | 1d | Same |
| Implement master key prompting | 1d | `extensions/quantlab/src/ui/MasterKeyPrompt.ts` (NEW) |
| Implement failed unlock backoff | 1d | `extensions/quantlab/src/core/secrets/encrypted.ts` |
| Implement lockout after failures | 0.5d | Same |
| CLI command `quantlab secrets init` | 1d | `cli/src/commands/secrets.rs` (NEW) |
| Migration from keychain | 1d | `extensions/quantlab/src/core/secrets/migration.ts` (NEW) |
| Security tests | 2d | `tests/secrets/` (NEW) |

### 3.3 Key Interfaces

```typescript
// secrets/backend.ts
interface SecretsBackend {
  isAvailable(): boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

class KeychainBackend implements SecretsBackend { /* ... */ }
class EncryptedFileBackend implements SecretsBackend {
  constructor(masterKey: string) {
    // Derive encryption key using Argon2id
    // memory=64MB, iterations=3
  }
}

function getSecretsBackend(): SecretsBackend {
  if (KeychainBackend.isAvailable()) {
    return new KeychainBackend();
  }

  const masterKey = getMasterKey(); // From env or prompt
  return new EncryptedFileBackend(masterKey);
}
```

### 3.4 File Format

```
~/.quantlab/secrets.enc

Header (64 bytes):
  - Magic: "QLSEC\x00\x01\x00" (8 bytes)
  - Argon2 salt (32 bytes)
  - Argon2 params (time=3, mem=64MB, parallelism=4) (12 bytes)
  - Reserved (12 bytes)

Body:
  - AES-256-GCM encrypted JSON blob
  - Nonce (12 bytes) + Ciphertext + Tag (16 bytes)
```

### 3.5 Testing Requirements

| Test ID | Description | Type |
|---------|-------------|------|
| S001 | Keychain used when available | Unit |
| S002 | Encrypted file used when keychain unavailable | Unit |
| S003 | File has 0600 permissions | Unit |
| S004 | Master key minimum 16 chars enforced | Unit |
| S005 | Exponential backoff on failed unlock | Unit |
| S006 | Lockout after 10 failures | Unit |
| S007 | Secrets never in logs | Security |
| S008 | Secrets never in crash dumps | Security |

### 3.6 Acceptance Criteria

- [ ] Headless Linux server can store secrets
- [ ] Master key prompt appears when needed
- [ ] Lockout activates after 10 failed attempts
- [ ] No plaintext secrets in filesystem

### 3.7 Key Rotation Workflow (Decision H47)

Users must be able to change their master password and re-encrypt all secrets (user-initiated rotation only).

**Flow**:
1. User selects "Change Master Password" from Settings > Security
2. Prompt for current password (verify against stored key)
3. Prompt for new password (minimum 16 chars, with confirmation)
4. Re-derive encryption key using Argon2id with new password
5. Decrypt all secrets with old key
6. Re-encrypt all secrets with new key
7. Verify decryption works with new key
8. Atomically replace encrypted file
9. Clear old key from memory

**Implementation Tasks**:

| Task | Effort | Files |
|------|--------|-------|
| Add "Change Password" settings UI | 1d | `extensions/quantlab/src/ui/ChangePasswordDialog.ts` (NEW) |
| Implement re-encryption logic | 1d | `extensions/quantlab/src/core/secrets/rotation.ts` (NEW) |
| Add atomic file replacement | 0.5d | `extensions/quantlab/src/core/secrets/encrypted.ts` |
| Add rotation tests | 0.5d | `tests/secrets/rotation.test.ts` (NEW) |

**Testing Requirements**:

| Test ID | Description |
|---------|-------------|
| S009 | Password change re-encrypts all secrets |
| S010 | Old password fails after rotation |
| S011 | Rotation failure leaves secrets intact (atomic) |
| S012 | Rotation works with 50+ stored secrets |

---

## 7. Benchmark Harness

### 4.1 Background

**Current State**: No systematic performance testing.

**Target State**: Reproducible benchmark suite integrated with CI:
- Fixed datasets and strategies
- Statistical measurement (median, p95, stddev)
- Regression detection with thresholds

### 4.2 Implementation Tasks

| Task | Effort | Files Affected |
|------|--------|----------------|
| Create benchmark datasets | 1d | `benchmarks/data/` (NEW) |
| Create benchmark strategies | 1d | `benchmarks/strategies/` (NEW) |
| Implement benchmark runner | 2d | `benchmarks/runner.py` (NEW) |
| Implement statistical analysis | 1d | `benchmarks/analysis.py` (NEW) |
| CI integration | 1d | `.github/workflows/benchmark.yml` (NEW) |
| Regression checker | 1d | `benchmarks/check.py` (NEW) |

### 4.3 Benchmark Definitions

| Benchmark | Dataset | Bars | Strategy | Target p95 |
|-----------|---------|------|----------|------------|
| `bench_small` | 1Y daily | 252 | SMA crossover | 0.5s |
| `bench_medium` | 5Y daily | 1,260 | RSI + MACD | 2.0s |
| `bench_large` | 1Y minute | 98,280 | Momentum | 60s |
| `bench_multi` | 5Y 10-sym | 12,600 | Rotation | 10s |

### 4.4 CI Integration

```yaml
# .github/workflows/benchmark.yml
name: Performance Benchmark

on:
  push:
    branches: [main]
  pull_request:

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run benchmarks
        run: python -m benchmarks.runner --output results.json

      - name: Check regression
        run: python -m benchmarks.check --baseline main --threshold 1.5

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: results.json
```

### 7.5 Acceptance Criteria

- [ ] All benchmarks deterministic (same result on re-run)
- [ ] P95 latency within spec thresholds
- [ ] CI fails on regression (bench_small/medium: +50%, bench_large: +25%)
- [ ] Results archived for historical analysis

---

## Phase 1 Deliverables Checklist

### Week 1
- [ ] Daemon process skeleton compiles and runs
- [ ] PID file management working
- [ ] JSON-RPC 2.0 protocol implemented
- [ ] IPC token authentication working

### Week 2
- [ ] Daemon IPC communication working
- [ ] UI can connect to daemon
- [ ] ExposureManager class with basic reservation
- [ ] Structured logging configured

### Week 3
- [ ] ExposureManager fully implemented with tests
- [ ] Secrets backend detection working
- [ ] Encrypted file backend complete
- [ ] Health check endpoint working

### Week 4
- [ ] Daemon checkpoint/recovery working
- [ ] Master key prompt working
- [ ] Watchdog implemented
- [ ] Benchmark datasets created

### Week 5
- [ ] System sleep/wake handling
- [ ] Graceful shutdown sequence
- [ ] All security tests passing
- [ ] Benchmark CI integration
- [ ] Phase 1 integration testing complete
- [ ] **Gate: Unit tests 80% engine coverage**

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Daemon IPC race conditions | Medium | High | Extensive concurrency testing |
| Argon2 too slow on low-end hardware | Low | Medium | Configurable parameters |
| Keychain detection false positives | Low | Low | Manual override setting |
| Benchmark flakiness | Medium | Low | Warmup runs, multiple iterations |

---

## Dependencies

### Python Dependencies (New)
- `argon2-cffi` - Key derivation (Decision F33)
- `cryptography` - AES-256-GCM
- `psutil` - Process management
- `zoneinfo` - Timezone handling (stdlib in Python 3.9+)

### Node Dependencies (New)
- None required for Phase 1 (use existing VS Code infrastructure)

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Daemon uptime | 99.9% | Monitoring |
| Exposure calculation time | <1ms | Benchmark |
| Secrets retrieval time | <100ms | Benchmark |
| Benchmark variance | <10% | CI stats |

---

## Order ID Generation (Decision N100)

**Format**: `{type}-{uuidv4}`

Examples:
- `ord-550e8400-e29b-41d4-a716-446655440000`
- `flat-550e8400-e29b-41d4-a716-446655440001`
- `stop-550e8400-e29b-41d4-a716-446655440002`

---

*Phase 1 must complete before Phase 2 begins. Phase 3 pre-work (UI mockups) can begin in parallel.*
*Gate: Unit tests 80% engine coverage required to proceed.*
