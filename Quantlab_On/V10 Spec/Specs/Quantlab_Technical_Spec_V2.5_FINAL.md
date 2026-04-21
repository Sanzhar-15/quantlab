# Quantlab Technical Specification V2.5
## Execution Model, Contracts, Data Provenance

**Product**: Quantlab — Quantitative Trading Development Environment  
**Company**: Delta Plus  
**Version**: 2.5 FINAL  
**Date**: 2026-01-25  
**Status**: Approved for Implementation

---

## Document Control

### Canonical Document Set
| Document | Version | Audience | Status |
|----------|---------|----------|--------|
| Product Specification | V10.5 | Product, Design, Frontend | Current |
| **This Document** | V2.5 | Backend, Engine, QA | Current |
| Operations Specification | V1.3 | DevOps, Release, Support | Current |
| Test Specification | V1.2 | QA, Engineering | Current |
| Design System | V1.0 | Design, Frontend | Current |

### Changes from V2.4
| Section | Change |
|---------|--------|
| §1.4 | Added complete Python cache exclusions; added Unicode NFC normalization |
| §1.5 | **NEW**: Live Trading Process Architecture (daemon requirement) |
| §1.6 | **NEW**: Daemon Process Implementation Details |
| §6.4 | **NEW**: Corporate Action Handling |
| §8.3 | **NEW**: Numerical Reproducibility Tolerances |
| §9.7 | **NEW**: Trade Drift Detection |
| §10.5 | **NEW**: Data Provider Adapter Interface |
| §10.6 | **NEW**: Fill Reconciliation |
| §10.7 | **NEW**: Position Reconciliation Edge Cases |
| §11.1 | Added encrypted file fallback for secrets |
| §11.4.1 | **NEW**: Exposure Reservation Model (with order modification) |
| §12.3 | **NEW**: Tamper-Evident Audit Log |
| §13.3 | **NEW**: Reproducible Benchmark Harness |
| §14.3 | **NEW**: Market Calendar Schema |
| §14.4 | **NEW**: Timezone Handling |
| §14.5 | **NEW**: Decimal Precision |
| §15.3 | **NEW**: Message Ordering Guarantees |
| §15.4 | **NEW**: Protocol Versioning |
| §17.4 | **NEW**: Report Export Schemas |
| §18.6 | **NEW**: Code Modification Contract (CST requirement) |
| §19.4 | Added debugger privacy bounds |
| §19.5 | **NEW**: Debug File Performance Requirements |
| §19.6 | **NEW**: Memory-Mapped File Specification |
| §20.5 | **NEW**: AI Panel Input Sanitization |
| §20.6 | **NEW**: AI Panel Security Model |

### Supersedes
All previous specifications are **ARCHIVED — DO NOT IMPLEMENT**:
- ~~System Specification V1.0~~
- ~~Technical Specification V2.0, V2.1, V2.2, V2.3, V2.4~~

### Normative Language
This document uses RFC-2119 terminology:
- **MUST** / **REQUIRED**: Absolute requirement
- **SHOULD** / **RECOMMENDED**: May be omitted with good reason
- **MAY** / **OPTIONAL**: Truly optional

---

## Table of Contents

1. Engine Architecture
2. Execution Model
3. Backtest Contract
4. Order Type Simulation
5. Short Selling Model
6. Data Provenance
7. Feature Store Contract
8. Environment Reproducibility
9. Metrics Dictionary
10. Plugin Architecture
11. Security & Safety
12. Failure Modes & Recovery
13. Performance Expectations
14. Data Schemas
15. Streaming Protocol
16. Error Taxonomy
17. Artifact Contracts
18. Strategy API Contract
19. Time-Travel Debugger Contract
20. AI Panel Data Flow
21. Non-Goals & Deferred

---

# §1. Engine Architecture

## 1.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           QUANTLAB UI (Electron)                         │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │   Editor     │  │    Chart     │  │    Trade     │                  │
│  │   Views      │  │    Views     │  │    Views     │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Streaming Protocol (§15)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          RUNNER MANAGER                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                     │
│  │ LocalRunner │  │DockerRunner │  │RemoteRunner │                     │
│  │  (Backtest) │  │   (V2)      │  │    (V2)     │                     │
│  └──────┬──────┘  └─────────────┘  └─────────────┘                     │
│         │                                                               │
│  ┌──────┴──────┐                                                       │
│  │ LiveDaemon  │  ← NEW: Separate process for live trading             │
│  │  (§1.5)     │                                                       │
│  └─────────────┘                                                       │
└─────────┼───────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         QUANTLAB ENGINE (Python)                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │  Parser   │  │ Backtest  │  │   Live    │  │ Portfolio │           │
│  │           │  │  Engine   │  │  Engine   │  │  Manager  │           │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘           │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Debug State (Memory-Mapped File)                │  │
│  │                    Accessed directly by UI for Time-Travel         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## 1.2 Communication Architecture

| Channel | Transport | Content | Frequency |
|---------|-----------|---------|-----------|
| **Control** | IPC (JSON) | Start, stop, cancel, config | Low |
| **Progress** | IPC (JSON) | Progress %, ETA, logs | ~1/second |
| **Results** | IPC (JSON) | Final metrics, artifact paths | Once |
| **Debug State** | Memory-mapped file | Bar snapshots for Time-Travel | Per bar (when enabled) |
| **Large Data** | Disk files | Trade lists, equity curves | On completion |

## 1.3 Strategy Request Types

```typescript
type StrategyRequest = SingleFileStrategy | PackageStrategy;

interface SingleFileStrategy {
  type: 'single';
  path: string;
  code: string;
  hash: string;  // SHA-256 of normalized code
}

interface PackageStrategy {
  type: 'package';
  rootPath: string;
  entryPoint: string;
  files: FileEntry[];
  packageHash: string;  // Combined hash (see §1.4)
}
```

## 1.4 Package Hash Algorithm [REVISED]

Package hash MUST include all files that affect execution with **deterministic normalization**.

### Included Files

```
INCLUDED FILE EXTENSIONS
├── *.py        (Python source)
├── *.yaml      (Configuration)
├── *.yml       (Configuration)
├── *.json      (Configuration)
├── *.toml      (Configuration)
└── *.pyx       (Cython source)

EXCLUDED (always)
├── __pycache__/
├── *.pyc
├── .git/
├── .quantlab/
├── *.log
├── .env            # Secrets - NEVER hash
├── .env.*
├── node_modules/
├── .venv/          # Python virtual environments [NEW]
├── venv/           # [NEW]
├── env/            # [NEW]
├── .tox/           # [NEW]
├── .nox/           # [NEW]
├── .pytest_cache/  # [NEW]
├── .mypy_cache/    # [NEW]
├── .ruff_cache/    # [NEW]
├── .hypothesis/    # [NEW]
├── .coverage       # [NEW]
├── htmlcov/        # [NEW]
├── .cache/         # [NEW]
├── *.egg-info/     # [NEW]
├── dist/           # [NEW]
├── build/          # [NEW]
├── *.so            # [NEW] Compiled extensions
├── *.pyd           # [NEW] Windows compiled
└── .ipynb_checkpoints/  # [NEW] Jupyter
```

### Custom Ignore File

Users MAY create `.quantlabignore` (gitignore syntax):

```
# .quantlabignore
scratch/
experiments/
*.bak
```

### Normalization Rules (Cross-Platform Determinism) [REVISED]

```python
import unicodedata

def normalize_for_hash(file_path: str, content: bytes) -> bytes:
    """Normalize file content for deterministic hashing across OS."""
    
    # 1. Decode as UTF-8 (reject non-UTF-8 files)
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        raise HashError(f"Non-UTF-8 file: {file_path}")
    
    # 2. Unicode NFC normalization (macOS uses NFD by default) [NEW]
    text = unicodedata.normalize('NFC', text)
    
    # 3. Normalize line endings to LF
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    
    # 4. Strip trailing whitespace per line
    lines = [line.rstrip() for line in text.split('\n')]
    
    # 5. Ensure single trailing newline
    normalized = '\n'.join(lines)
    if normalized and not normalized.endswith('\n'):
        normalized += '\n'
    
    return normalized.encode('utf-8')

def compute_package_hash(root_path: str) -> str:
    """Compute deterministic package hash."""
    
    # 1. List all included files
    files = list_included_files(root_path)  # Applies extension + ignore rules
    
    # 2. Sort by normalized path (forward slashes, case-sensitive)
    files.sort(key=lambda f: f.replace('\\', '/'))
    
    # 3. Build hash input
    hash_input = []
    for file_path in files:
        relative = os.path.relpath(file_path, root_path).replace('\\', '/')
        content = read_file(file_path)
        normalized = normalize_for_hash(relative, content)
        file_hash = hashlib.sha256(normalized).hexdigest()
        hash_input.append(f"{relative}:{file_hash}\n")
    
    # 4. Final hash
    combined = ''.join(hash_input).encode('utf-8')
    return hashlib.sha256(combined).hexdigest()
```

### Symlink Policy

Symlinks are **resolved** before hashing. If a symlink points outside the package, it is **excluded** with a warning.

## 1.5 Live Trading Process Architecture [NEW]

### Process Isolation Requirement

Live trading sessions MUST run in a **separate daemon process** that survives UI termination.

| Component | Process | Lifecycle |
|-----------|---------|-----------|
| Quantlab UI | Main (Electron) | User-controlled |
| Backtest Engine | Child of Main | Dies with UI |
| **Live Trading Engine** | **Daemon/Service** | **Independent** |

### Implementation Architecture

```
┌─────────────────┐         ┌─────────────────┐
│  Quantlab UI    │◄───────►│  Live Daemon    │
│  (Electron)     │   IPC   │  (Python)       │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │ UI can crash/close        │ Continues running
         │                           │ Maintains positions
         ▼                           ▼
    User closes app          Daemon persists until:
                             - Explicit stop command
                             - Circuit breaker triggers
                             - Emergency flatten completes
```

### Daemon Lifecycle

```python
# Daemon startup
def start_live_daemon(session_config: SessionConfig) -> DaemonHandle:
    """Start live trading daemon as independent process."""
    
    pid_file = f"~/.quantlab/sessions/{session_config.id}.pid"
    
    # Check for existing daemon
    if os.path.exists(pid_file):
        existing = read_pid(pid_file)
        if process_running(existing):
            return reconnect_daemon(existing)
    
    # Start new daemon
    daemon_process = subprocess.Popen(
        ['quantlab-live-daemon', '--config', session_config.path],
        start_new_session=True,  # Detach from parent
        stdout=open(f'~/.quantlab/logs/daemon_{session_config.id}.log', 'a'),
        stderr=subprocess.STDOUT,
    )
    
    write_pid(pid_file, daemon_process.pid)
    return DaemonHandle(pid=daemon_process.pid, config=session_config)
```

### UI Reconnection

```python
def reconnect_to_daemon() -> Optional[SessionState]:
    """Called on UI startup to find running daemons."""
    
    for pid_file in glob('~/.quantlab/sessions/*.pid'):
        pid = read_pid(pid_file)
        if process_running(pid):
            # Reconnect via IPC
            session = query_daemon_state(pid)
            return session
    
    return None  # No active sessions
```

### Daemon Termination Conditions

| Condition | Behavior |
|-----------|----------|
| User stops session | Graceful shutdown, close positions per config |
| Circuit breaker | Execute configured action, then idle |
| Emergency flatten | Complete flatten, then shutdown |
| System shutdown | Write checkpoint, positions remain at broker |
| Daemon crash | On restart, reconcile with broker |

## 1.6 Daemon Process Implementation Details [NEW]

### Directory Structure

```
~/.quantlab/
├── sessions/
│   ├── {session_id}.pid       # PID file
│   └── {session_id}.state     # Checkpoint state
├── sockets/
│   └── {session_id}.sock      # IPC socket (Unix) or named pipe (Windows)
└── logs/
    └── daemon_{session_id}.log
```

### Daemon Manager Implementation

```python
import os
import sys
import subprocess
from pathlib import Path

class DaemonManager:
    """Manage live trading daemon lifecycle."""
    
    BASE_DIR = Path.home() / '.quantlab'
    PID_DIR = BASE_DIR / 'sessions'
    SOCKET_DIR = BASE_DIR / 'sockets'
    LOG_DIR = BASE_DIR / 'logs'
    
    def __init__(self):
        # Ensure directories exist
        self.PID_DIR.mkdir(parents=True, exist_ok=True)
        self.SOCKET_DIR.mkdir(parents=True, exist_ok=True)
        self.LOG_DIR.mkdir(parents=True, exist_ok=True)
    
    def start_daemon(self, session_config: SessionConfig) -> DaemonHandle:
        """Start a new daemon process."""
        
        # Check for existing daemon
        existing = self._find_existing_daemon(session_config.id)
        if existing:
            if existing.is_alive():
                raise DaemonAlreadyRunningError(
                    f"Daemon already running for session {session_config.id} "
                    f"(PID: {existing.pid})"
                )
            else:
                # Stale - clean up
                self._cleanup_stale_daemon(session_config.id)
        
        # Create socket path
        socket_path = self.SOCKET_DIR / f'{session_config.id}.sock'
        log_path = self.LOG_DIR / f'daemon_{session_config.id}.log'
        
        # Build daemon command
        cmd = [
            sys.executable, '-m', 'quantlab.daemon',
            '--session-id', session_config.id,
            '--config', str(session_config.path),
            '--socket', str(socket_path),
            '--log', str(log_path),
        ]
        
        # Start detached process
        if sys.platform == 'win32':
            # Windows: use CREATE_NEW_PROCESS_GROUP
            daemon = subprocess.Popen(
                cmd,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
                stdout=open(log_path, 'a'),
                stderr=subprocess.STDOUT,
            )
        else:
            # Unix: use start_new_session
            daemon = subprocess.Popen(
                cmd,
                start_new_session=True,
                stdout=open(log_path, 'a'),
                stderr=subprocess.STDOUT,
            )
        
        # Write PID file
        pid_path = self.PID_DIR / f'{session_config.id}.pid'
        pid_path.write_text(str(daemon.pid))
        
        # Wait for socket to be ready
        if not self._wait_for_socket(socket_path, timeout=10):
            daemon.kill()
            raise DaemonStartError("Daemon failed to create socket within timeout")
        
        return DaemonHandle(
            pid=daemon.pid,
            socket_path=socket_path,
            session_id=session_config.id,
            log_path=log_path
        )
    
    def _find_existing_daemon(self, session_id: str) -> Optional[DaemonHandle]:
        """Check for existing daemon for this session."""
        pid_path = self.PID_DIR / f'{session_id}.pid'
        
        if not pid_path.exists():
            return None
        
        try:
            pid = int(pid_path.read_text().strip())
        except (ValueError, IOError):
            return None
        
        handle = DaemonHandle(pid=pid, session_id=session_id)
        return handle
    
    def _cleanup_stale_daemon(self, session_id: str):
        """Remove stale PID and socket files."""
        (self.PID_DIR / f'{session_id}.pid').unlink(missing_ok=True)
        (self.SOCKET_DIR / f'{session_id}.sock').unlink(missing_ok=True)
        (self.PID_DIR / f'{session_id}.state').unlink(missing_ok=True)

class DaemonHandle:
    """Handle to a running daemon process."""
    
    def __init__(self, pid: int, session_id: str, socket_path: Path = None, log_path: Path = None):
        self.pid = pid
        self.session_id = session_id
        self.socket_path = socket_path
        self.log_path = log_path
        self._connection = None
    
    def is_alive(self) -> bool:
        """Check if daemon process is still running."""
        try:
            os.kill(self.pid, 0)  # Signal 0 = existence check
            return True
        except (ProcessLookupError, PermissionError):
            return False
    
    def connect(self) -> DaemonConnection:
        """Establish IPC connection to daemon."""
        if self._connection is None:
            self._connection = DaemonConnection(self.socket_path)
        return self._connection
    
    def send_command(self, command: str, **kwargs) -> CommandResult:
        """Send command to daemon."""
        conn = self.connect()
        return conn.send({'command': command, **kwargs})
```

### System Sleep/Wake Handling

```python
class DaemonSleepHandler:
    """Handle system sleep/wake events."""
    
    def __init__(self, daemon: LiveTradingDaemon):
        self.daemon = daemon
        self._register_sleep_hooks()
    
    def _register_sleep_hooks(self):
        """Register for system sleep/wake notifications."""
        if sys.platform == 'darwin':
            # macOS: Use IOKit notifications
            self._register_macos_hooks()
        elif sys.platform == 'win32':
            # Windows: Use power management events
            self._register_windows_hooks()
        else:
            # Linux: Use systemd or DBus
            self._register_linux_hooks()
    
    def on_sleep(self):
        """Called before system sleeps."""
        log.info("System entering sleep - checkpointing state")
        self.daemon.checkpoint()
        self.daemon.disconnect_broker()  # Clean disconnect
    
    def on_wake(self):
        """Called after system wakes."""
        log.info("System woke - reconnecting")
        
        # Reconnect to broker
        if not self.daemon.reconnect_broker(timeout=30):
            log.error("Failed to reconnect to broker after wake")
            self.daemon.trigger_circuit_breaker("broker_reconnect_failed")
            return
        
        # Reconcile positions
        result = self.daemon.reconcile_positions()
        if result.discrepancies:
            log.warning(f"Position discrepancies after wake: {result.discrepancies}")
            self.daemon.notify_user("Position discrepancies detected after system wake")
```

### Resource Limits

| Resource | Limit | Enforcement |
|----------|-------|-------------|
| Memory | 4 GB (configurable) | OS cgroup/job object |
| CPU | No limit | — |
| File descriptors | 1024 | ulimit |
| Log file size | 100 MB | Rotation |

### Log Rotation

```yaml
# daemon_log_rotation.yaml
max_size_mb: 100
max_files: 10
compress: true
retention_days: 30
```

---

# §2. Execution Model

## 2.1 Job Lifecycle

```
                    ┌──────────┐
                    │  QUEUED  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ STARTING │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
         ┌──────────│ RUNNING  │──────────┐
         │          └────┬─────┘          │
         │               │                │
    ┌────▼─────┐   ┌─────▼────┐    ┌─────▼────┐
    │CANCELLED │   │COMPLETED │    │  FAILED  │
    └──────────┘   └──────────┘    └──────────┘
```

## 2.2 Cancellation Semantics

| Type | Trigger | Behavior |
|------|---------|----------|
| **Soft** | Click Cancel | Set flag; finish current unit; save checkpoint |
| **Hard** | Shift+Cancel OR 10s after soft | SIGTERM; force stop; save what's possible |

## 2.3 Concurrency Configuration

| Setting | Default | Range |
|---------|---------|-------|
| Max concurrent jobs | 2 | 1-8 |
| Queue depth | 10 | 5-50 |
| Memory limit per job | 4 GB | 1-16 GB |
| Job timeout | 1 hour | 5 min - 24 hours |

## 2.4 Checkpointing

Checkpointing MUST be enabled when:
- Estimated duration > 5 minutes
- Debug mode is ON
- User explicitly requests

## 2.5 Strategy State Serialization

### State Categories

| Category | Captured | Method |
|----------|----------|--------|
| Portfolio state | ✓ Always | Engine-managed |
| Indicator buffers | ✓ Always | Engine-managed |
| RNG state | ✓ Always | Engine-managed (numpy + Python random) |
| User instance variables | ✓ If serializable | Pickle |
| Global variables | ⚠ Best-effort | Module inspection |
| External state | ✗ Never | User responsibility |

### Serialization Contract

```python
class MyStrategy(ql.Strategy):
    # Exclude from checkpoint
    __quantlab_no_checkpoint__ = ['db_connection']
    
    def __init__(self):
        self.counter = 0           # ✓ Captured
        self.db_connection = None  # ✗ Excluded
```

### Size Limits

| Limit | Value | On Exceed |
|-------|-------|-----------|
| Max serialized state | 100 MB | Warning + truncate |
| Max single attribute | 10 MB | Exclude attribute |

---

# §3. Backtest Contract

## 3.1 Canonical Time Indexing

**Terminology (use consistently everywhere)**:

| Term | Definition |
|------|------------|
| **Signal Bar** | Bar t — the bar whose data is used to compute signals |
| **Execution Bar** | Bar t+1 — the bar during which orders can fill |

### Timing Diagram

```
BAR t-1 CLOSES
     │
     ▼
BAR t COMPLETES (all OHLCV known)
     │
     ▼
SIGNAL BAR = t
├── Indicators calculated using bars [0..t]
├── Strategy logic evaluates
├── Signal generated (BUY/SELL/etc.)
└── Order created and queued
     │
     ▼
BAR t+1 OPENS
     │
     ▼
EXECUTION BAR = t+1
├── MARKET orders fill at open[t+1]
├── LIMIT/STOP orders evaluated against bar t+1 range
├── Fills processed
└── Portfolio updated
     │
     ▼
BAR t+1 CLOSES
     │
     ▼
EQUITY RECORDED (mark-to-market at close[t+1])
```

### Index Mapping in Debugger

| Debugger Position | Shows | Orders |
|-------------------|-------|--------|
| Bar t | Signal bar t state | Orders generated this bar |
| "Step to next trade" | Jumps to bar t+1 | Shows fill at execution bar |

## 3.2 Fill Assumptions

| Assumption | Fill Price | Description |
|------------|------------|-------------|
| `next_open` | `open[t+1]` | **Realistic** — fill at execution bar open |
| `next_close` | `close[t+1]` | Fill at execution bar close |
| `typical_price` | `(O+H+L+C)/4` of bar t+1 | **Optimistic** — assumes favorable intrabar |

**Default**: `next_open`

## 3.3 Slippage Scope

**Slippage applies ONLY to market-like executions:**

| Order Type | Slippage Applied | Rationale |
|------------|------------------|-----------|
| MARKET | ✓ Yes | Uncertain execution price |
| LIMIT | ✗ No | Price guaranteed by definition |
| STOP (triggered) | ✓ Yes | Becomes market on trigger |
| STOP_LIMIT (triggered) | ✗ No | Becomes limit on trigger |

## 3.4 Slippage Models

| Model | Formula | Default |
|-------|---------|---------|
| `none` | `price` | — |
| `fixed_bps` | `price × (1 + dir × bps/10000)` | 10 bps |
| `volatility` | `price × (1 + dir × k × ATR/price)` | k=0.1 |

**Default**: `volatility` with k=0.1

## 3.5 Commission Models

| Model | Formula | Default |
|-------|---------|---------|
| `none` | 0 | — |
| `per_share` | `shares × cost` | $0.005 |
| `per_trade` | `flat` | $1.00 |

**Default**: `per_share` at $0.005

## 3.6 Aggregate Volume Participation

**The participation rate applies PER SYMBOL PER BAR across ALL orders.**

```python
def process_bar_orders(symbol: str, orders: List[Order], bar: Bar, config: Config):
    max_shares = bar.volume * config.participation_rate  # Default 10%
    filled_shares = 0
    
    # Priority: exits > stop-losses > entries
    sorted_orders = sort_by_priority(orders)
    
    for order in sorted_orders:
        available = max_shares - filled_shares
        fill_qty = min(order.remaining_qty, available)
        if fill_qty > 0:
            execute_fill(order, fill_qty, bar)
            filled_shares += fill_qty
```

## 3.7 Forward-Fill Signal Policy

**Default: Signals on forward-filled bars are BLOCKED.**

```python
config = BacktestConfig(
    allowSignalsOnForwardFill=False  # Default
)
```

When a bar is forward-filled (synthetic):
- `volume` is set to 0
- Signal evaluation is skipped
- Warning logged

## 3.8 Multi-Asset Alignment

| Option | Behavior |
|--------|----------|
| `reference` (default) | Use reference calendar; forward-fill others |
| `intersection` | Only bars where ALL assets have data |
| `union` | Any bar where ANY asset has data |

---

# §4. Order Type Simulation

## 4.1 Supported Order Types (V1)

| Type | Support | Notes |
|------|---------|-------|
| MARKET | ✓ MUST | — |
| LIMIT | ✓ MUST | — |
| STOP | ✓ MUST | — |
| STOP_LIMIT | ✓ MUST | — |

## 4.2 MARKET Orders

```
Fill at: open[t+1] (next_open assumption)
Then: Apply slippage
Then: Apply commission
```

## 4.3 LIMIT Orders

```python
def fill_buy_limit(limit_price: float, bar: Bar) -> float | None:
    if bar.low <= limit_price:
        return min(bar.open, limit_price)  # Price improvement possible
    return None  # No fill
```

## 4.4 STOP Orders

```python
def fill_buy_stop(stop_price: float, bar: Bar) -> float | None:
    if bar.high >= stop_price:
        if bar.open >= stop_price:
            return bar.open  # Gap through
        return stop_price  # Triggered at stop price (conservative)
    return None  # Not triggered

def fill_sell_stop(stop_price: float, bar: Bar) -> float | None:
    if bar.low <= stop_price:
        if bar.open <= stop_price:
            return bar.open  # Gap through
        return stop_price  # Triggered at stop price (conservative)
    return None  # Not triggered
```

## 4.5 Time-in-Force

| TIF | Behavior |
|-----|----------|
| GFD | Cancel at session close |
| GTC | Carry to next bar |
| IOC | Fill immediately or cancel |

**Default**: GFD

## 4.6 Partial Fills

Trigger: `order_size > bar_volume × participation_rate`

| TIF | Behavior |
|-----|----------|
| GFD | Fill partial, carry remainder, cancel at close |
| GTC | Fill partial, carry remainder indefinitely |
| IOC | Fill partial, cancel remainder immediately |

---

# §5. Short Selling Model

## 5.1 V1 Model

| Aspect | V1 Behavior |
|--------|-------------|
| Short positions | ✓ Allowed |
| Margin model | 100% collateral required |
| Max gross exposure | 100% of equity |
| Borrow fee | Configurable (accrued per bar) |
| Leverage | None (100% collateral = no leverage) |

## 5.2 Portfolio Accounting

```typescript
interface PortfolioState {
  cash: number;                // Includes short proceeds
  collateralReserved: number;  // Held against shorts
  longValue: number;           // Mark-to-market
  shortValue: number;          // Mark-to-market (absolute)
  
  // Derived
  equity: number;              // cash + longValue - shortValue
  buyingPower: number;         // cash - collateralReserved
  netExposure: number;         // longValue - shortValue
  grossExposure: number;       // longValue + shortValue
}
```

### Equity Identity (MUST hold at all times)

```
equity = cash + longValue - shortValue
```

## 5.3 Verified Example

```
INITIAL STATE
cash: $100,000 | longValue: $0 | shortValue: $0
equity: $100,000 ✓

ACTION 1: BUY 100 AAPL @ $500 = $50,000
cash: $50,000 | longValue: $50,000 | shortValue: $0
equity: $50,000 + $50,000 - $0 = $100,000 ✓

ACTION 2: SHORT 100 MSFT @ $500 = $50,000 (100% collateral)
cash: $50,000 + $50,000 (proceeds) = $100,000
collateralReserved: $50,000
longValue: $50,000 | shortValue: $50,000
equity: $100,000 + $50,000 - $50,000 = $100,000 ✓
buyingPower: $100,000 - $50,000 = $50,000
grossExposure: ($50,000 + $50,000) / $100,000 = 100%
```

## 5.4 Borrow Fee Accrual

```python
def accrue_borrow_fee(position: Position, bar_duration: timedelta, annual_rate: float):
    """Accrue borrow fee proportional to bar duration."""
    
    year_fraction = bar_duration.total_seconds() / (365.25 * 24 * 3600)
    fee = abs(position.value) * annual_rate * year_fraction
    
    return fee  # Deducted from cash at bar close
```

| Timeframe | Bar Duration | Fee per $50K short @ 0.5% annual |
|-----------|--------------|----------------------------------|
| Daily | 1 day | $0.68 |
| Hourly | 1 hour | $0.03 |
| 1-minute | 1 minute | $0.0005 |

---

# §6. Data Provenance

## 6.1 DataRev (Data Revision)

```typescript
interface DataRev {
  id: string;                    // Unique identifier
  hash: string;                  // Content hash
  hashMethod: 'full' | 'sampled'; // See §6.2
  
  symbol: string;
  timeframe: string;
  dateRange: DateRange;
  
  source: {
    provider: string;
    fetchedAt: Date;
    adjustments: string[];       // ['splits', 'dividends']
  };
  
  rowCount: number;
  schema: ColumnSchema[];
}
```

## 6.2 Hashing Policy

### Standard Files (< 100 MB)

Full content hash using SHA-256.

### Large Files (≥ 100 MB) — Non-Pinned

Sampled hash for quick identity:
- First 10 MB
- Last 10 MB
- Every 100th row
- Metadata (row count, column types)

**Labeled as**: `hashMethod: 'sampled'`

### Pinned Data — ALWAYS Full Hash

When a run is pinned, data MUST be fully hashed:

```python
def hash_for_pin(file_path: str) -> str:
    """Streaming full hash for pinned data."""
    hasher = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            hasher.update(chunk)
    return hasher.hexdigest()
```

**Rationale**: Pinned runs claim "guaranteed reproduction" — this requires full content verification.

## 6.3 Universe Versioning

### Static vs Point-in-Time

| Type | Definition | Use Case |
|------|------------|----------|
| **Static** | Fixed member list | Exploration, screening |
| **Point-in-Time** | Membership by date | Unbiased backtesting |

### UniverseRev Contract [NEW]

```typescript
interface UniverseRev {
  id: string;
  name: string;
  type: 'static' | 'point_in_time';
  
  // For static
  members?: string[];  // Symbol list
  
  // For point-in-time
  source?: {
    provider: string;
    index: string;  // e.g., "SP500"
    fetchedAt: Date;
  };
  
  dateRange: DateRange;
  hash: string;  // Hash of membership data
}
```

### Survivorship Bias Warning

**When using static universe for backtesting:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ SURVIVORSHIP BIAS WARNING                                                  │
│                                                                              │
│ You are backtesting with a static universe (S&P 500 current members).       │
│                                                                              │
│ This introduces survivorship bias because:                                  │
│ • Companies that were delisted or removed are excluded                      │
│ • Results will be optimistically biased                                     │
│                                                                              │
│ For unbiased results, use point-in-time universe membership.                │
│                                                                              │
│ [Use Point-in-Time] [Continue with Warning] [Learn More]                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6.4 Corporate Action Handling [NEW]

### Handling Modes

```python
from enum import Enum

class CorporateActionMode(Enum):
    IGNORE = 'ignore'           # Pretend they don't exist (simplest)
    ADJUST_PRICES = 'adjust'    # Adjust historical prices (most common)
    SIMULATE = 'simulate'       # Simulate actual portfolio impact (most realistic)
```

### Configuration

```yaml
# backtest_config.yaml
corporate_actions:
  splits:
    mode: adjust_prices    # Recommended default
    
  dividends:
    mode: ignore           # V1 default - no dividend modeling
    # Future: reinvest, cash_accumulate
    
  spinoffs:
    mode: warn             # Alert user, require manual decision
    
  mergers:
    mode: warn             # Alert user
    
  delistings:
    mode: close_at_last    # Close position at last known price
    warning: true
```

### Implementation

```python
class CorporateActionHandler:
    """Handle corporate actions during backtests."""
    
    def handle_split(
        self, 
        symbol: str, 
        ratio: float,  # e.g., 4.0 for 4-for-1 split
        ex_date: date,
        mode: CorporateActionMode
    ) -> SplitResult:
        
        if mode == CorporateActionMode.IGNORE:
            return SplitResult(action='ignored', warning=True)
        
        elif mode == CorporateActionMode.ADJUST_PRICES:
            # Adjust all historical prices before ex-date
            adjustment_factor = 1 / ratio
            self.data_manager.adjust_prices(
                symbol=symbol,
                before_date=ex_date,
                factor=adjustment_factor
            )
            # Also adjust volume inversely
            self.data_manager.adjust_volume(
                symbol=symbol,
                before_date=ex_date,
                factor=ratio
            )
            return SplitResult(
                action='prices_adjusted',
                factor=adjustment_factor,
                affected_bars=self.data_manager.count_adjusted(symbol, ex_date)
            )
        
        elif mode == CorporateActionMode.SIMULATE:
            # Actually adjust the position on ex-date
            position = self.portfolio.get_position(symbol)
            if position and position.quantity != 0:
                old_qty = position.quantity
                new_qty = int(old_qty * ratio)
                new_avg_price = position.avg_price / ratio
                
                # Handle fractional shares (cash in lieu)
                fractional = (old_qty * ratio) - new_qty
                if fractional > 0:
                    cash_value = fractional * self._get_price(symbol, ex_date)
                    self.portfolio.add_cash(cash_value)
                
                position.update(quantity=new_qty, avg_price=new_avg_price)
                
                return SplitResult(
                    action='simulated',
                    old_qty=old_qty,
                    new_qty=new_qty,
                    fractional_cash=cash_value if fractional > 0 else 0
                )
        
        return SplitResult(action='no_position')
    
    def handle_delisting(
        self,
        symbol: str,
        delist_date: date,
        last_price: float,
        reason: str
    ) -> DelistingResult:
        """Handle delisted security."""
        
        position = self.portfolio.get_position(symbol)
        if not position or position.quantity == 0:
            return DelistingResult(action='no_position')
        
        # Close position at last known price
        pnl = position.quantity * (last_price - position.avg_price)
        self.portfolio.close_position(symbol, last_price)
        
        # Log warning
        log.warning(
            f"Position in {symbol} closed due to delisting. "
            f"Reason: {reason}. P&L: ${pnl:,.2f}"
        )
        
        return DelistingResult(
            action='closed_at_last_price',
            quantity=position.quantity,
            close_price=last_price,
            pnl=pnl,
            reason=reason
        )
```

### Warning Display

```
⚠ CORPORATE ACTION DETECTED
────────────────────────────────────────────────────────────────
Symbol: AAPL
Date: 2024-08-28
Type: 4-for-1 Stock Split

Your backtest is configured to use "Adjust Prices" mode.
All historical prices before this date will be adjusted by factor 0.25.

Impact on your backtest:
• Price series will be continuous (no artificial gap)
• Historical indicators will reflect split-adjusted prices
• Volume will be adjusted inversely (×4)

For more accurate results with corporate actions, consider using
split-adjusted data from your data provider.

[View Documentation] [Continue]
```

### Default Modes by Asset Class

| Asset Class | Splits | Dividends | Delistings |
|-------------|--------|-----------|------------|
| US Equity | ADJUST_PRICES | IGNORE | CLOSE_AT_LAST + WARN |
| ETF | ADJUST_PRICES | IGNORE | CLOSE_AT_LAST + WARN |
| Crypto | N/A | N/A | CLOSE_AT_LAST + WARN |

---

# §7. Feature Store Contract

## 7.1 Cache Key Definition

```python
def compute_feature_cache_key(
    feature_code_hash: str,
    data_rev_hash: str,
    symbol: str,
    timeframe: str,
    date_range: DateRange,
    engine_version: str,
    dependency_hashes: List[str]
) -> str:
    """
    Deterministic cache key for feature computation.
    All components MUST be included to prevent stale features.
    """
    components = [
        f"code:{feature_code_hash}",
        f"data:{data_rev_hash}",
        f"symbol:{symbol}",
        f"tf:{timeframe}",
        f"range:{date_range.start}:{date_range.end}",
        f"engine:{engine_version}",
        f"deps:{','.join(sorted(dependency_hashes))}"
    ]
    return hashlib.sha256('\n'.join(components).encode()).hexdigest()
```

## 7.2 Look-Ahead Protection

Features MUST be computed using only data available at bar close:

```python
@ql.feature
def my_feature(data):
    # ✓ OK: uses data up to current bar
    return data.close.rolling(20).mean()
    
    # ✗ FORBIDDEN: uses future data
    return data.close.shift(-1)  # Raises FeatureLeakageError
```

### Validation

Engine SHOULD detect common leakage patterns:
- Negative shifts
- Future indexing
- Lookahead in joins

---

# §8. Environment Reproducibility

## 8.1 Environment Snapshot

```typescript
interface EnvironmentSnapshot {
  quantlabVersion: string;
  engineVersion: string;
  
  python: {
    version: string;
    source: 'bundled' | 'venv' | 'conda' | 'system';
  };
  
  packages: PackageVersion[];
  
  system: {
    os: string;
    architecture: string;
  };
  
  randomState: {
    numpySeed: number;
    pythonRandomState: any;
  };
}
```

## 8.2 Determinism Enforcement

When reproducing a pinned run:
1. Restore RNG states exactly
2. Disable parallel execution
3. Warn on version mismatches
4. Proceed with best-effort reproduction

## 8.3 Numerical Reproducibility Tolerances [NEW]

### Reproduction Guarantee

When reproducing a pinned run, results are considered **equivalent** if within tolerance:

| Metric Type | Absolute Tolerance | Relative Tolerance |
|-------------|-------------------|-------------------|
| Equity values | $0.01 | 1e-6 |
| Returns | — | 1e-6 |
| Ratios (Sharpe, etc.) | 1e-4 | 1e-4 |
| Trade counts | 0 | — |
| Signal bars | 0 | — |

### Cross-Platform Variance Sources

| Source | Mitigation |
|--------|------------|
| IEEE 754 floating point | Accept 1e-15 variance |
| SIMD optimizations | Disable for pinned reproduction |
| Library versions | Snapshot in environment |

### Comparison Output

```
REPRODUCTION COMPARISON
═══════════════════════════════════════════════════════════
Metric              Original        Reproduced      Status
───────────────────────────────────────────────────────────
Total Return        15.2341%        15.2341%        ✓ MATCH
Sharpe Ratio        1.4523          1.4524          ✓ WITHIN TOL
Max Drawdown        8.34%           8.34%           ✓ MATCH
Trade Count         47              47              ✓ EXACT
Final Equity        $115,234.12     $115,234.11     ✓ WITHIN TOL
═══════════════════════════════════════════════════════════
Result: REPRODUCTION SUCCESSFUL (all metrics within tolerance)
```

---

# §9. Metrics Dictionary

## 9.1 Return Series Specification

**All metrics use SIMPLE PERCENTAGE RETURNS on EQUITY.**

```python
def calculate_returns(equity_curve: List[float]) -> List[float]:
    """
    Canonical return series.
    - Simple returns (not log)
    - On total equity
    - Per bar frequency
    """
    return [(eq[i] - eq[i-1]) / eq[i-1] for i in range(1, len(eq))]
```

### What's Included in Equity

| Component | Included |
|-----------|----------|
| Cash | ✓ |
| Long positions (MTM) | ✓ |
| Short positions (MTM) | ✓ (as liability) |
| Commissions | ✓ (deducted) |
| Slippage | ✓ (in fill price) |
| Borrow fees | ✓ (deducted) |

## 9.2 Annualization Factors

| Timeframe | Calendar | Periods/Year |
|-----------|----------|--------------|
| Daily | NYSE | 252 |
| Daily | Crypto 24/7 | 365 |
| Hourly | NYSE | 1,638 |
| 1-min | NYSE | 98,280 |

## 9.3 Risk-Adjusted Metrics

### Risk-Free Rate [NEW]

```
Default Rf: 0% (zero)
Configurable: settings.metrics.riskFreeRate
Source: User-provided or fetched from data provider
```

### Sharpe Ratio

```
Sharpe = (mean(returns) - rf) / std(returns) × √(ann_factor)
```

### Sortino Ratio

```
Sortino = (mean(returns) - rf) / downside_std × √(ann_factor)
```

### Calmar Ratio

```
Calmar = CAGR / |max_drawdown|
```

## 9.4 Trade Metrics

| Metric | Formula |
|--------|---------|
| Trade Count | Completed round-trips only |
| Win Rate | Winning trades / Total trades |
| Profit Factor | Gross profit / Gross loss |
| Average Trade | Total P&L / Trade count |

### Trade Definition

- Entry + full exit = 1 trade
- Partial close: NOT counted until fully closed
- Break-even (P&L = 0): Counted as loss (conservative)

## 9.5 Max Drawdown

```python
def max_drawdown(equity_curve):
    peak = equity_curve[0]
    max_dd = 0
    for eq in equity_curve:
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak
        max_dd = max(max_dd, dd)
    return max_dd
```

## 9.6 Stability Score

```
Stability = R² of equity curve vs linear regression

Interpretation:
- ≥ 0.85: Good (stable growth)
- 0.70-0.85: Warning
- < 0.70: Poor (erratic)
```

## 9.7 Trade Drift Detection [NEW]

Detect statistically significant differences between backtest and live performance.

### Statistical Methodology

```python
from scipy import stats
import numpy as np

class TradeDriftDetector:
    """Detect statistically significant drift between backtest and live."""
    
    def __init__(self, significance_level: float = 0.05, min_trades: int = 30):
        self.alpha = significance_level
        self.min_trades = min_trades
    
    def compare_sessions(
        self, 
        backtest: BacktestResult, 
        live: LiveSession
    ) -> DriftAnalysis:
        
        # Check minimum sample size
        if live.trade_count < self.min_trades:
            return DriftAnalysis(
                status='insufficient_data',
                message=f'Need {self.min_trades} trades, have {live.trade_count}'
            )
        
        metrics = {}
        
        # Win rate comparison (two-proportion z-test)
        metrics['win_rate'] = self._compare_proportions(
            backtest.win_count, backtest.trade_count,
            live.win_count, live.trade_count
        )
        
        # Average trade comparison (Welch's t-test)
        metrics['avg_trade'] = self._compare_means(
            backtest.trade_returns,
            live.trade_returns
        )
        
        # Sharpe ratio comparison (bootstrap)
        metrics['sharpe'] = self._compare_sharpe_bootstrap(
            backtest.daily_returns,
            live.daily_returns
        )
        
        # Identify significant drifts
        significant_drifts = [
            k for k, v in metrics.items() 
            if v.p_value < self.alpha
        ]
        
        return DriftAnalysis(
            status='drift_detected' if significant_drifts else 'no_drift',
            metrics=metrics,
            significant_drifts=significant_drifts,
            confidence_level=1 - self.alpha
        )
    
    def _compare_proportions(self, x1, n1, x2, n2) -> MetricComparison:
        """Two-proportion z-test for win rates."""
        p1, p2 = x1/n1, x2/n2
        p_pooled = (x1 + x2) / (n1 + n2)
        se = np.sqrt(p_pooled * (1 - p_pooled) * (1/n1 + 1/n2))
        z = (p1 - p2) / se
        p_value = 2 * (1 - stats.norm.cdf(abs(z)))
        
        return MetricComparison(
            backtest_value=p1,
            live_value=p2,
            difference=p2 - p1,
            p_value=p_value,
            test_used='two_proportion_z'
        )
    
    def _compare_means(self, returns1, returns2) -> MetricComparison:
        """Welch's t-test for average trade returns."""
        t_stat, p_value = stats.ttest_ind(returns1, returns2, equal_var=False)
        
        return MetricComparison(
            backtest_value=np.mean(returns1),
            live_value=np.mean(returns2),
            difference=np.mean(returns2) - np.mean(returns1),
            p_value=p_value,
            test_used='welch_t'
        )
    
    def _compare_sharpe_bootstrap(
        self, returns1, returns2, n_bootstrap: int = 10000
    ) -> MetricComparison:
        """Bootstrap test for Sharpe ratio difference."""
        
        def sharpe(r):
            return np.mean(r) / np.std(r) * np.sqrt(252) if np.std(r) > 0 else 0
        
        sharpe1, sharpe2 = sharpe(returns1), sharpe(returns2)
        observed_diff = sharpe2 - sharpe1
        
        # Bootstrap under null hypothesis
        combined = np.concatenate([returns1, returns2])
        n1 = len(returns1)
        
        bootstrap_diffs = []
        for _ in range(n_bootstrap):
            np.random.shuffle(combined)
            bs1, bs2 = combined[:n1], combined[n1:]
            bootstrap_diffs.append(sharpe(bs2) - sharpe(bs1))
        
        # Two-tailed p-value
        p_value = np.mean(np.abs(bootstrap_diffs) >= np.abs(observed_diff))
        
        return MetricComparison(
            backtest_value=sharpe1,
            live_value=sharpe2,
            difference=observed_diff,
            p_value=p_value,
            test_used='bootstrap'
        )
```

### User Display

```
TRADE DRIFT ANALYSIS (95% confidence)
════════════════════════════════════════════════════════════════
Metric          Backtest    Live        Drift       p-value     Sig?
────────────────────────────────────────────────────────────────
Win Rate        58.2%       51.4%       -6.8%       0.032       ⚠ YES
Avg Trade       0.42%       0.38%       -0.04%      0.241       No
Sharpe          1.42        0.98        -0.44       0.008       ⚠ YES
════════════════════════════════════════════════════════════════
⚠ Significant drift detected in 2 of 3 metrics.
   Consider reviewing strategy performance and market conditions.
```

### False Alarm Control

When running multiple comparisons, apply Bonferroni correction:

```python
def apply_multiple_testing_correction(metrics: Dict[str, MetricComparison]) -> Dict:
    """Apply Bonferroni correction for multiple hypothesis tests."""
    n_tests = len(metrics)
    adjusted_alpha = self.alpha / n_tests
    
    for metric in metrics.values():
        metric.adjusted_p_value = min(metric.p_value * n_tests, 1.0)
        metric.significant_after_correction = metric.adjusted_p_value < self.alpha
    
    return metrics
```

---

# §10. Plugin Architecture

## 10.1 Broker Adapter Interface

```typescript
interface BrokerAdapter {
  // Connection
  connect(): Promise<ConnectionResult>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  
  // Account
  getAccount(): Promise<AccountInfo>;
  getPositions(): Promise<Position[]>;
  getBuyingPower(): Promise<BuyingPower>;
  
  // Order Lifecycle
  submitOrder(order: OrderRequest): Promise<OrderSubmitResult>;
  cancelOrder(orderId: string): Promise<CancelResult>;
  replaceOrder(orderId: string, updates: OrderUpdates): Promise<ReplaceResult>;
  getOrder(orderId: string): Promise<OrderStatus>;
  getOpenOrders(): Promise<OrderStatus[]>;
  
  // Streaming
  subscribeOrderUpdates(callback: OrderUpdateCallback): Subscription;
  subscribePositionUpdates(callback: PositionUpdateCallback): Subscription;
  
  // Reconciliation
  reconcilePositions(expected: Position[]): Promise<ReconciliationResult>;
  reconcileOrders(expected: Order[]): Promise<ReconciliationResult>;
}
```

## 10.2 Idempotency Contract

```typescript
interface OrderRequest {
  clientOrderId: string;  // REQUIRED - idempotency key
  // Format: "{sessionId}-{sequenceNumber}"
  // Resubmitting same key returns existing order (no duplicate)
}
```

## 10.3 Order Status Transitions

```
NEW → ACCEPTED → PARTIAL_FILLED → FILLED
         ↓              ↓
      REJECTED      CANCELLED
```

## 10.4 Rate Limiting

Adapters MUST implement:
- Exponential backoff on rate limit errors
- Request queuing with priority
- Configurable max requests/second

## 10.5 Data Provider Adapter Interface [NEW]

Live trading requires market data. This interface defines the contract for data providers.

```typescript
interface DataProviderAdapter {
  // Connection
  connect(): Promise<ConnectionResult>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  
  // Subscription
  subscribe(symbols: string[], dataTypes: DataType[]): Promise<Subscription>;
  unsubscribe(subscriptionId: string): Promise<void>;
  
  // Streaming callbacks
  onQuote(callback: (quote: Quote) => void): void;
  onBar(callback: (bar: Bar) => void): void;
  onTrade(callback: (trade: TradeEvent) => void): void;
  
  // Historical (for gap fill)
  getHistoricalBars(symbol: string, range: DateRange): Promise<Bar[]>;
  
  // Health
  getLatency(): number;
  getLastUpdate(symbol: string): Date;
}

interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  timestamp: Date;     // UTC
  exchange: string;
}

type DataType = 'quote' | 'bar_1m' | 'bar_5m' | 'bar_1h' | 'bar_1d' | 'trade';
```

### Live Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Data Provider  │────►│  Data Manager   │────►│   Live Engine   │
│  (Polygon, etc) │     │  (Normalization)│     │                 │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                        ┌────────▼────────┐
                        │  Staleness      │
                        │  Detector       │
                        └─────────────────┘
```

### Quote Staleness Detection

```python
class QuoteStalenessMonitor:
    STALE_THRESHOLD_SECONDS = 30
    CRITICAL_THRESHOLD_SECONDS = 60
    
    def check_quote(self, symbol: str) -> StalenessLevel:
        last_update = self.last_updates.get(symbol)
        if last_update is None:
            return StalenessLevel.MISSING
        
        age = (datetime.now(UTC) - last_update).total_seconds()
        
        if age > self.CRITICAL_THRESHOLD_SECONDS:
            return StalenessLevel.CRITICAL  # Pause trading
        elif age > self.STALE_THRESHOLD_SECONDS:
            return StalenessLevel.STALE      # Warning
        else:
            return StalenessLevel.FRESH
```

### Data Provider Failover

| Scenario | Behavior |
|----------|----------|
| Primary provider down | Failover to backup within 5s |
| Both providers down | Pause strategy, alert user |
| Data gap detected | Fill from historical API |
| Quote staleness > 60s | Pause trading for symbol |

## 10.6 Fill Reconciliation [NEW]

Fills from brokers can arrive out of order or be duplicated during network issues.

```python
class FillReconciler:
    """Handle out-of-order and duplicate fills from broker."""
    
    def __init__(self):
        self.processed_fills: Set[str] = set()  # Idempotency
        self.pending_fills: Dict[str, Fill] = {}  # Out-of-order buffer
    
    def process_fill(self, fill: Fill) -> bool:
        # Idempotency check
        if fill.fill_id in self.processed_fills:
            log.warning(f"Duplicate fill ignored: {fill.fill_id}")
            return False
        
        # Sequence check
        order = self.orders.get(fill.order_id)
        if order and fill.sequence_number != order.expected_fill_sequence:
            # Out of order - buffer it
            self.pending_fills[fill.fill_id] = fill
            log.warning(f"Out-of-order fill buffered: {fill.fill_id}")
            return False
        
        # Process in order
        self._apply_fill(fill)
        self.processed_fills.add(fill.fill_id)
        if order:
            order.expected_fill_sequence += 1
            self._process_buffered_fills(order)
        return True
```

### Unknown Order State Handling

| State | Action |
|-------|--------|
| Order "PENDING" > 30s | Query broker for status |
| Broker returns "UNKNOWN" | Mark as "NEEDS_RECONCILIATION" |
| Fill for unknown order | Log, alert, attempt to match |

## 10.7 Position Reconciliation Edge Cases [NEW]

```python
class ReconciliationPolicy:
    """Handle complex reconciliation scenarios."""
    
    def reconcile_with_broker(self) -> ReconciliationResult:
        broker_positions = self.broker.getPositions()
        engine_positions = self.engine.getPositions()
        
        discrepancies = []
        
        for symbol in set(broker_positions.keys()) | set(engine_positions.keys()):
            broker_qty = broker_positions.get(symbol, Position(0)).quantity
            engine_qty = engine_positions.get(symbol, Position(0)).quantity
            
            if broker_qty != engine_qty:
                discrepancy = Discrepancy(
                    symbol=symbol,
                    broker_qty=broker_qty,
                    engine_qty=engine_qty,
                    delta=broker_qty - engine_qty,
                    cause=self._diagnose_cause(symbol)
                )
                discrepancies.append(discrepancy)
        
        return ReconciliationResult(discrepancies=discrepancies)
    
    def _diagnose_cause(self, symbol: str) -> DiscrepancyCause:
        # Check for missed fills
        unprocessed = self.broker.get_fills_since(self.last_sync)
        if any(f.symbol == symbol for f in unprocessed):
            return DiscrepancyCause.MISSED_FILLS
        
        # Check for corporate actions
        corp_actions = self.data_provider.get_corporate_actions(symbol, self.last_sync)
        if corp_actions:
            return DiscrepancyCause.CORPORATE_ACTION
        
        return DiscrepancyCause.EXTERNAL_TRADE
```

### Corporate Action Handling

| Action | Behavior |
|--------|----------|
| Stock split | Adjust position quantity, warn user |
| Reverse split | Adjust position quantity, handle fractional |
| Cash dividend | Add to cash (if enabled in config) |
| Spinoff | Alert user, manual reconciliation required |

---

# §11. Security & Safety

## 11.1 Secrets Storage [REVISED]

### Primary: OS Keychain

| Platform | Backend |
|----------|---------|
| Windows | Windows Credential Manager |
| macOS | Keychain |
| Linux | libsecret (GNOME Keyring / KWallet) |

### Fallback: Encrypted File [NEW]

When OS Keychain is unavailable (headless servers, minimal Linux installs):

| Aspect | Specification |
|--------|---------------|
| Location | `~/.quantlab/secrets.enc` |
| Encryption | AES-256-GCM |
| Key Derivation | Argon2id (memory=64MB, iterations=3) |
| Unlock Methods | 1. Environment variable `QUANTLAB_MASTER_KEY` |
|                | 2. Interactive password prompt |

### Detection Logic

```python
def get_secrets_backend():
    if os_keychain_available():
        return KeychainBackend()
    elif os.path.exists(ENCRYPTED_FILE):
        return EncryptedFileBackend()
    else:
        # First run on headless system
        raise SecretsSetupRequired(
            "No secrets backend available. "
            "Run 'quantlab secrets init' to create encrypted storage."
        )
```

### Security Requirements

- Master key MUST be ≥ 16 characters
- Encrypted file MUST have 0600 permissions
- Failed unlock attempts: exponential backoff (1s, 2s, 4s, 8s, max 60s)
- After 10 failed attempts: lock for 1 hour

**Never stored in**: workspace files, logs, artifacts, crash dumps.

## 11.2 Secrets Redaction

```typescript
const REDACTION_RULES = {
  // Known secret field names
  fields: ['api_key', 'api_secret', 'password', 'token', 'secret'],
  
  // Provider-specific patterns
  patterns: [
    /APCA-API-KEY-ID[:=]\s*\S+/,
    /APCA-API-SECRET-KEY[:=]\s*\S+/,
    /Bearer\s+[a-zA-Z0-9._-]+/,
  ],
};
```

## 11.3 Strategy Sandbox

| Resource | Limit |
|----------|-------|
| File read | Workspace + data dirs only |
| File write | Workspace only |
| Network | Blocked |
| Subprocess | Blocked |
| Memory | 4 GB (configurable) |

## 11.4 Risk Limits

### Enforcement Points

| Limit | Check | On Breach |
|-------|-------|-----------|
| Max order size | Pre-order | Reject |
| Max position size | Pre-order | Reject |
| Max gross exposure | Pre-order (with reservation) | Reject |
| Daily loss limit | Post-fill | Circuit breaker |
| Max drawdown | Post-fill | Circuit breaker |

### Circuit Breaker Actions

| Action | Orders | Positions | Session |
|--------|--------|-----------|---------|
| Pause and Alert | Cancel | Keep | Paused |
| Pause and Flatten | Cancel | Close | Stopped |
| Alert Only | Keep | Keep | Running |

## 11.4.1 Exposure Reservation Model [NEW]

### Problem

Concurrent order submissions can both pass pre-submission checks but breach limits when both fill.

### Solution: Reservation-Based Exposure

```python
import threading

class ExposureManager:
    def __init__(self, max_gross_exposure: float):
        self.max_exposure = max_gross_exposure
        self.current_exposure = 0.0
        self.reserved_exposure = 0.0
        self._lock = threading.Lock()
    
    def reserve(self, order: Order) -> bool:
        """Reserve exposure before order submission."""
        with self._lock:
            projected = order.projected_exposure()
            total = self.current_exposure + self.reserved_exposure + projected
            
            if total > self.max_exposure:
                return False  # Reject order
            
            self.reserved_exposure += projected
            return True
    
    def commit(self, order: Order, fill: Fill):
        """Convert reservation to actual exposure on fill."""
        with self._lock:
            self.reserved_exposure -= order.projected_exposure()
            self.current_exposure += fill.actual_exposure()
    
    def release(self, order: Order):
        """Release reservation on cancel/reject."""
        with self._lock:
            self.reserved_exposure -= order.projected_exposure()
```

### Reservation Lifecycle

```
Order Created
     │
     ▼
reserve() called
     │
     ├─── Returns False → Order Rejected (limit would breach)
     │
     └─── Returns True → Order Submitted
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           FILLED          REJECTED        CANCELLED
              │               │               │
              ▼               ▼               ▼
         commit()        release()       release()
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Partial fill | commit() partial, keep remainder reserved |
| Order timeout | release() unfilled portion |
| Engine crash | On recovery, recalculate from broker positions |

### Order Modification Handling [NEW]

When modifying an order's size, the reservation must be adjusted:

```python
def modify_order(self, order_id: str, new_qty: int, new_price: float) -> bool:
    """Handle order modification with reservation adjustment."""
    
    original_order = self.orders[order_id]
    
    # Calculate exposure difference
    old_exposure = original_order.projected_exposure()
    new_exposure = self._calculate_exposure(new_qty, new_price)
    delta = new_exposure - old_exposure
    
    if delta > 0:
        # Needs MORE exposure - must reserve additional
        if not self.exposure_manager.reserve_additional(order_id, delta):
            return False  # Cannot modify - would breach limit
    
    # Send modification to broker
    result = self.broker.replaceOrder(order_id, new_qty, new_price)
    
    if result.success:
        if delta < 0:
            # Needs LESS exposure - release excess
            self.exposure_manager.release_partial(order_id, -delta)
        return True
    else:
        # Modification failed - release any additional reservation
        if delta > 0:
            self.exposure_manager.release_additional(order_id, delta)
        return False
```

### Reservation Timeout

Reservations that don't resolve within timeout are automatically released:

```python
class ExposureManager:
    RESERVATION_TIMEOUT_SECONDS = 30
    
    def reserve(self, order: Order) -> ReservationHandle:
        handle = ReservationHandle(
            order_id=order.id,
            exposure=order.projected_exposure(),
            expires_at=datetime.now(UTC) + timedelta(seconds=self.RESERVATION_TIMEOUT_SECONDS)
        )
        self._schedule_cleanup(handle)
        return handle
    
    def _cleanup_expired(self):
        """Background task to clean up expired reservations."""
        now = datetime.now(UTC)
        for handle in list(self.reservations.values()):
            if handle.expires_at < now:
                log.warning(f"Reservation expired for order {handle.order_id}")
                self.release(handle.order_id)
```

---

# §12. Failure Modes & Recovery

## 12.1 Session Ledger

Durable, append-only record for all live sessions:

```typescript
interface SessionLedger {
  sessionId: string;
  mode: 'paper' | 'live';
  entries: LedgerEntry[];  // Append-only
}

type LedgerEntry = 
  | SessionStartEntry
  | BarEntry
  | SignalEntry
  | OrderEntry
  | FillEntry
  | PositionSnapshotEntry
  | ErrorEntry;
```

### Durability Guarantees

| Guarantee | Requirement |
|-----------|-------------|
| Write-ahead | Entry written BEFORE action |
| Sync | fsync after OrderEntry and FillEntry |
| Corruption detection | CRC32 per entry |

## 12.2 Broker Disconnect

| Duration | Behavior |
|----------|----------|
| < 30s | Auto-reconnect |
| 30s - 5min | Warning, retry |
| > 5min | Circuit breaker |

## 12.3 Tamper-Evident Audit Log [NEW]

For live trading, audit logs MUST provide tamper evidence via hash chaining.

```python
import hashlib
import json
import os
from datetime import datetime, UTC

class TamperEvidentLog:
    """Append-only log with hash chaining for integrity."""
    
    GENESIS_HASH = 'genesis'
    
    def __init__(self, path: str):
        self.path = path
        self.prev_hash = self._load_last_hash() or self.GENESIS_HASH
    
    def append(self, entry: dict) -> str:
        """Append entry with hash chain."""
        
        # Serialize entry deterministically
        entry_json = json.dumps(entry, sort_keys=True, default=str)
        
        # Compute hash including previous hash
        hash_input = f"{self.prev_hash}:{entry_json}"
        entry_hash = hashlib.sha256(hash_input.encode()).hexdigest()
        
        # Build record
        record = {
            'timestamp': datetime.now(UTC).isoformat(),
            'sequence': self._get_next_sequence(),
            'entry': entry,
            'prev_hash': self.prev_hash,
            'hash': entry_hash
        }
        
        # Write with fsync for durability
        with open(self.path, 'a') as f:
            f.write(json.dumps(record) + '\n')
            f.flush()
            os.fsync(f.fileno())
        
        self.prev_hash = entry_hash
        return entry_hash
    
    def verify_integrity(self) -> IntegrityResult:
        """Verify entire log chain."""
        prev_hash = self.GENESIS_HASH
        
        with open(self.path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                record = json.loads(line)
                
                # Verify chain continuity
                if record['prev_hash'] != prev_hash:
                    return IntegrityResult(
                        valid=False,
                        broken_at=line_num,
                        reason=f"Chain broken: expected {prev_hash}, got {record['prev_hash']}"
                    )
                
                # Verify hash correctness
                entry_json = json.dumps(record['entry'], sort_keys=True, default=str)
                expected_hash = hashlib.sha256(
                    f"{prev_hash}:{entry_json}".encode()
                ).hexdigest()
                
                if record['hash'] != expected_hash:
                    return IntegrityResult(
                        valid=False,
                        broken_at=line_num,
                        reason='Hash mismatch - possible tampering'
                    )
                
                prev_hash = record['hash']
        
        return IntegrityResult(valid=True, entries_verified=line_num)
```

### Log Rotation with Integrity

When rotating logs, preserve the hash chain across files:

```python
def rotate_log(self):
    """Rotate log while preserving integrity chain."""
    
    # 1. Write rotation marker to current log
    rotation_marker = {
        'type': 'rotation',
        'reason': 'size_limit',
        'old_file': self.current_path,
        'new_file': self.next_path,
        'final_hash': self.prev_hash
    }
    final_hash = self.append(rotation_marker)
    
    # 2. Archive current log
    shutil.move(self.current_path, self.archive_path)
    
    # 3. Start new log with genesis referencing old
    self.current_path = self.next_path
    genesis = {
        'type': 'genesis',
        'continued_from': self.archive_path,
        'continued_hash': final_hash
    }
    self.prev_hash = final_hash  # Chain continues
    self.append(genesis)
```

### Export Format

For compliance/audit purposes, logs can be exported with verification:

```python
def export_for_audit(self, output_path: str) -> ExportResult:
    """Export log with integrity proof."""
    
    # Verify before export
    integrity = self.verify_integrity()
    if not integrity.valid:
        raise IntegrityError(integrity.reason)
    
    export = {
        'export_timestamp': datetime.now(UTC).isoformat(),
        'log_file': self.path,
        'entries': self._read_all_entries(),
        'final_hash': self.prev_hash,
        'verification': {
            'status': 'verified',
            'entries_count': integrity.entries_verified
        }
    }
    
    with open(output_path, 'w') as f:
        json.dump(export, f, indent=2)
    
    return ExportResult(path=output_path, hash=self.prev_hash)
```

## 12.4 Position Reconciliation

On reconnect:
1. Fetch broker positions
2. Compare to expected
3. If mismatch: pause session, show dialog
4. User chooses: Accept broker truth, Investigate, or Flatten

---

# §13. Performance Expectations

## 13.1 Backtest Benchmarks

**Reference**: 4-core CPU, 8GB RAM, SSD

| Data Size | Expected | Max |
|-----------|----------|-----|
| 1Y daily (252 bars) | < 1s | 2s |
| 5Y daily (1,260 bars) | < 2s | 5s |
| 1Y minute (98,280 bars) | < 60s | 120s |

## 13.2 UI Responsiveness

| Operation | Target | Max |
|-----------|--------|-----|
| App launch | 3s | 5s |
| View switch | 100ms | 200ms |
| Chart render (10K points) | 200ms | 500ms |
| Cancel response | 100ms | 500ms |

**MUST**: UI remains responsive (no freeze) under 95th percentile workloads.

## 13.3 Reproducible Benchmark Harness [NEW]

### Benchmark Dataset Specifications

| Benchmark | Dataset | Characteristics |
|-----------|---------|-----------------|
| `bench_small` | `benchmark_1y_daily.parquet` | 1 symbol, 252 bars, simple SMA crossover |
| `bench_medium` | `benchmark_5y_daily.parquet` | 1 symbol, 1,260 bars, RSI + MACD strategy |
| `bench_large` | `benchmark_1y_minute.parquet` | 1 symbol, 98,280 bars, momentum strategy |
| `bench_multi` | `benchmark_5y_10symbols.parquet` | 10 symbols, 12,600 bars total, rotation |

### Benchmark Strategy Specifications

```python
# bench_small: Simple SMA crossover
def strategy_bench_small(data):
    fast = ql.sma(data.close, 10)
    slow = ql.sma(data.close, 20)
    return ql.signals(
        entry_long=fast > slow,
        exit_long=fast < slow
    )

# Deterministic parameters - MUST use these exactly
CONFIG_BENCH_SMALL = {
    'initial_capital': 100000,
    'commission': 'per_share:0.005',
    'slippage': 'none',
    'fill_assumption': 'next_open',
}
```

### Measurement Protocol

```python
import time
import statistics
import gc

def run_benchmark(benchmark_name: str, iterations: int = 5) -> BenchmarkResult:
    """Run benchmark with statistical analysis."""
    
    times = []
    results = []
    
    # Warmup run (not counted)
    _run_once(benchmark_name)
    
    # Measured runs
    for i in range(iterations):
        # Force GC before each run
        gc.collect()
        
        start = time.perf_counter()
        result = _run_once(benchmark_name)
        elapsed = time.perf_counter() - start
        
        times.append(elapsed)
        results.append(result)
    
    # Verify determinism
    assert all(r.final_equity == results[0].final_equity for r in results), \
        "Non-deterministic results detected - benchmark invalid"
    
    return BenchmarkResult(
        name=benchmark_name,
        median_seconds=statistics.median(times),
        p95_seconds=statistics.quantiles(times, n=20)[18],
        std_dev=statistics.stdev(times),
        iterations=iterations,
        deterministic=True
    )
```

### Regression Thresholds

| Benchmark | Baseline (p95) | Regression Threshold |
|-----------|----------------|---------------------|
| `bench_small` | 0.5s | +50% (0.75s) |
| `bench_medium` | 2.0s | +50% (3.0s) |
| `bench_large` | 60s | +25% (75s) |
| `bench_multi` | 10s | +50% (15s) |

### CI Integration

```yaml
# .github/workflows/benchmark.yml
benchmark:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Run benchmarks
      run: python -m quantlab.benchmark --output benchmark_results.json
    - name: Check regression
      run: python -m quantlab.benchmark.check --baseline main --threshold 1.5
    - name: Upload results
      uses: actions/upload-artifact@v4
      with:
        name: benchmark-results
        path: benchmark_results.json
```

---

# §14. Data Schemas

## 14.1 OHLCV Schema

```typescript
interface OHLCVBar {
  timestamp: Date;     // Bar close time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

## 14.2 Trade Schema

```typescript
interface Trade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  entryPrice: number;
  entryTime: Date;
  exitPrice?: number;
  exitTime?: Date;
  pnl?: number;
  status: 'open' | 'closed';
}
```

## 14.3 Market Calendar Schema [NEW]

### Calendar Definition

```yaml
# calendars/nyse.yaml
name: "NYSE"
timezone: "America/New_York"

regular_hours:
  open: "09:30"
  close: "16:00"

extended_hours:
  pre_market: "04:00"
  after_hours: "20:00"

holidays:
  - date: "2026-01-01"
    name: "New Year's Day"
  - date: "2026-01-19"
    name: "Martin Luther King Jr. Day"
  - date: "2026-02-16"
    name: "Presidents' Day"
  - date: "2026-04-03"
    name: "Good Friday"
  - date: "2026-05-25"
    name: "Memorial Day"
  - date: "2026-07-03"
    name: "Independence Day (observed)"
  - date: "2026-09-07"
    name: "Labor Day"
  - date: "2026-11-26"
    name: "Thanksgiving"
  - date: "2026-12-25"
    name: "Christmas"

early_closes:
  - date: "2026-11-27"
    close: "13:00"
    name: "Day after Thanksgiving"
  - date: "2026-12-24"
    close: "13:00"
    name: "Christmas Eve"

# For annualization
trading_days_per_year: 252
```

### Built-in Calendars

| Calendar | Assets | Trading Days/Year |
|----------|--------|-------------------|
| `nyse` | US Equities, ETFs | 252 |
| `nasdaq` | US Equities, ETFs | 252 |
| `crypto_24_7` | Crypto | 365 |
| `cme` | Futures [V2] | ~250 |

### Custom Calendar

Users MAY define custom calendars in workspace:

```
workspace/
└── .quantlab/
    └── calendars/
        └── my_exchange.yaml
```

### Calendar Resolution

```python
def get_calendar(symbol: str) -> Calendar:
    # 1. Check workspace custom calendars
    if custom_calendar_exists(symbol):
        return load_custom_calendar(symbol)
    
    # 2. Check symbol metadata
    if symbol.calendar:
        return load_calendar(symbol.calendar)
    
    # 3. Infer from asset class
    if is_crypto(symbol):
        return load_calendar('crypto_24_7')
    
    # 4. Default
    return load_calendar('nyse')
```

## 14.4 Timezone Handling [NEW]

### Canonical Rules

| Rule | Specification |
|------|---------------|
| Internal storage | All timestamps UTC |
| Bar timestamp meaning | Bar CLOSE time (not open) |
| Display conversion | Convert to exchange local time |

### Timezone Policy Implementation

```python
from zoneinfo import ZoneInfo

class TimezonePolicy:
    """Canonical timezone handling."""
    
    INTERNAL_TZ = ZoneInfo('UTC')
    
    def to_internal(self, timestamp: datetime, source_tz: str) -> datetime:
        """Convert any timestamp to internal UTC."""
        if timestamp.tzinfo is None:
            # Assume source timezone
            timestamp = timestamp.replace(tzinfo=ZoneInfo(source_tz))
        return timestamp.astimezone(self.INTERNAL_TZ)
    
    def to_display(self, timestamp: datetime, calendar: str) -> datetime:
        """Convert UTC timestamp to exchange local time for display."""
        exchange_tz = self.calendars[calendar].timezone
        return timestamp.astimezone(ZoneInfo(exchange_tz))
    
    def is_dst_transition_day(self, date: date, calendar: str) -> bool:
        """Check if DST transition affects this trading day."""
        tz = ZoneInfo(self.calendars[calendar].timezone)
        # Check if UTC offset changes between market open and close
        open_time = datetime.combine(date, time(9, 30), tzinfo=tz)
        close_time = datetime.combine(date, time(16, 0), tzinfo=tz)
        return open_time.utcoffset() != close_time.utcoffset()
```

### DST Transition Handling

| Scenario | Behavior |
|----------|----------|
| Spring forward (lose hour) | Bar schedule shifts, no missing bars |
| Fall back (gain hour) | Bar schedule shifts, no duplicate bars |
| Cross-timezone backtest | Align to reference calendar, warn on gaps |

### Multi-Timezone Alignment

When backtesting assets from different timezones:

```python
def align_multi_timezone(
    reference_bars: DataFrame,
    other_bars: DataFrame,
    reference_calendar: str,
    other_calendar: str,
    method: str = 'forward_fill'
) -> DataFrame:
    """
    Align bars from different timezones to reference calendar.
    
    WARNING: Forward-fill across timezones can introduce look-ahead bias
    if the other market closes before the reference market.
    """
    # Convert both to UTC
    ref_utc = to_utc(reference_bars, reference_calendar)
    other_utc = to_utc(other_bars, other_calendar)
    
    # Align to reference timestamps
    aligned = other_utc.reindex(ref_utc.index, method=method)
    
    # Warn if potential look-ahead
    if has_look_ahead_risk(reference_calendar, other_calendar):
        log.warning(
            f"Forward-filling {other_calendar} to {reference_calendar} "
            f"may introduce look-ahead bias"
        )
    
    return aligned
```

## 14.5 Decimal Precision [NEW]

### Precision by Asset Class

```python
from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN

class PrecisionPolicy:
    """Asset-class specific precision handling."""
    
    PRECISION_RULES = {
        'equity_us': {
            'price_decimals': 2,        # $0.01 minimum tick
            'quantity_decimals': 0,     # Whole shares only
            'rounding': ROUND_HALF_UP
        },
        'equity_us_subpenny': {
            'price_decimals': 4,        # $0.0001 for sub-penny (dark pools)
            'quantity_decimals': 0,
            'rounding': ROUND_HALF_UP
        },
        'crypto': {
            'price_decimals': 8,        # Satoshi precision
            'quantity_decimals': 8,     # Fractional coins
            'rounding': ROUND_DOWN      # Never round up (insufficient funds)
        },
        'forex': {
            'price_decimals': 5,        # Pip precision
            'quantity_decimals': 0,     # Lot sizes
            'rounding': ROUND_HALF_UP
        }
    }
    
    def normalize_price(self, price: Decimal, asset_class: str) -> Decimal:
        rules = self.PRECISION_RULES[asset_class]
        quantizer = Decimal(10) ** -rules['price_decimals']
        return price.quantize(quantizer, rounding=rules['rounding'])
    
    def normalize_quantity(self, qty: Decimal, asset_class: str) -> Decimal:
        rules = self.PRECISION_RULES[asset_class]
        quantizer = Decimal(10) ** -rules['quantity_decimals']
        return qty.quantize(quantizer, rounding=ROUND_DOWN)  # Always round down qty
```

### Internal Representation

**All prices and quantities MUST use `Decimal`, not `float`.**

```python
# CORRECT
price = Decimal('100.50')
quantity = Decimal('100')

# WRONG - precision loss
price = 100.50  # float
quantity = 100.0  # float
```

### Comparison Tolerance

When comparing prices for equality (e.g., limit order matching):

```python
def prices_equal(a: Decimal, b: Decimal, asset_class: str) -> bool:
    """Compare prices with asset-class appropriate tolerance."""
    rules = PrecisionPolicy.PRECISION_RULES[asset_class]
    tolerance = Decimal(10) ** -rules['price_decimals']
    return abs(a - b) < tolerance
```

---

# §15. Streaming Protocol

## 15.1 Message Envelope

```typescript
interface StreamMessage {
  version: '1.0';
  type: MessageType;
  jobId: string;
  timestamp: Date;
  sequenceNumber: number;  // NEW: For ordering
  payload: any;
}
```

## 15.2 UI→Engine Commands

```typescript
type CommandType = 
  | 'parse_strategy'
  | 'run_backtest'
  | 'run_optimization'
  | 'run_wfa'
  | 'run_monte_carlo'
  | 'cancel_job'
  | 'start_session'
  | 'stop_session'
  | 'session_command';
```

## 15.3 Message Ordering Guarantees [NEW]

### Ordering Rules

| Message Type | Ordering Guarantee |
|--------------|-------------------|
| Control (commands) | FIFO per job |
| Progress updates | FIFO per job, may skip |
| Order events | STRICTLY ORDERED per symbol |
| Fill events | STRICTLY ORDERED per order |

### Sequence Number Contract

```typescript
interface OrderingContract {
  // Sender increments sequenceNumber monotonically per channel
  // Receiver MUST process in sequence order
  // If sequence gap detected: request resync
  
  onMessage(msg: StreamMessage) {
    if (msg.sequenceNumber !== this.expected[msg.jobId]) {
      this.requestResync(msg.jobId, this.expected[msg.jobId]);
      return;
    }
    this.expected[msg.jobId]++;
    this.process(msg);
  }
}
```

### Critical Event Acknowledgment

For order-related events, sender MUST wait for ACK:

```
UI                          Engine
 │                            │
 │──── submitOrder ──────────►│
 │                            │
 │◄─── ORDER_ACCEPTED ────────│
 │                            │
 │──── ACK(seq=42) ──────────►│
 │                            │
```

## 15.4 Protocol Versioning [NEW]

### Version Negotiation

```typescript
interface HandshakeRequest {
  clientType: 'ui' | 'cli' | 'api';
  clientVersion: string;
  protocolVersion: string;
  minProtocolVersion: string;
  capabilities: string[];
}

interface HandshakeResponse {
  serverVersion: string;
  protocolVersion: string;
  negotiatedVersion: string;
  status: 'compatible' | 'upgrade_recommended' | 'incompatible';
  deprecationWarnings?: string[];
}
```

### Compatibility Matrix

| Client Protocol | Server Protocol | Behavior |
|-----------------|-----------------|----------|
| 1.0 | 1.0 | Full compatibility |
| 1.1 | 1.0 | Client uses 1.0 features only |
| 1.0 | 1.1 | Server uses 1.0 features only |
| 2.0 | 1.x | **Incompatible** - block startup with upgrade message |

### Schema Evolution Rules

1. **Adding optional fields**: Always backward compatible
2. **Adding required fields**: Breaking change, increment major version
3. **Removing fields**: Deprecate for 2 releases, then remove
4. **Changing field types**: Breaking change, increment major version

### Deprecation Warnings

When using deprecated features, engine returns warnings:

```json
{
  "type": "deprecation_warning",
  "feature": "legacy_order_format",
  "message": "This order format is deprecated and will be removed in v2.0",
  "removeInVersion": "2.0",
  "migrationGuide": "https://docs.quantlab.dev/migration/orders"
}
```

---

# §16. Error Taxonomy

## 16.1 Error Categories

| Category | Example |
|----------|---------|
| DATA_* | DATA_SCHEMA_MISMATCH |
| ENGINE_* | ENGINE_PARSE_ERROR |
| BROKER_* | BROKER_ORDER_REJECTED |
| SYSTEM_* | SYSTEM_DISK_FULL |

## 16.2 UI Treatment

| Treatment | When |
|-----------|------|
| Inline | Validation errors |
| Toast | Transient, recoverable |
| Modal | Blocking decisions |
| Modal + report | Unexpected errors |

---

# §17. Artifact Contracts

## 17.1 Artifact Manifest

```typescript
interface ArtifactManifest {
  schemaVersion: '1.0';
  jobId: string;
  jobType: string;
  createdAt: Date;
  
  files: {
    name: string;
    path: string;
    format: string;
    checksum: string;
  }[];
}
```

## 17.2 Backtest Artifacts

```
backtest_{timestamp}_{hash}/
├── manifest.json
├── code/                    # MANDATORY
│   ├── snapshot.json
│   └── strategy.py
├── results.json
├── trades.parquet
├── equity.parquet
└── debug/                   # If debug enabled
```

## 17.3 Code Snapshot Mandate

**All run artifacts MUST include complete code snapshot.**

Required for:
- Reproducibility
- Run comparison (code diff)
- Audit trail

## 17.4 Report Export Schemas [NEW]

### PDF Export Schema

```yaml
pdf_report:
  version: "1.0"
  
  header:
    title: string          # "Backtest Report: {strategy_name}"
    generated_at: datetime
    quantlab_version: string
    
  provenance:
    strategy_hash: string
    data_rev: string
    environment_hash: string
    run_id: string
    
  summary:
    date_range: DateRange
    initial_capital: number
    final_equity: number
    total_return: number
    sharpe_ratio: number
    max_drawdown: number
    trade_count: number
    
  equity_chart:
    type: image/png
    width: 800
    height: 400
    
  metrics_table:
    columns: [metric_name, value, benchmark_value?]
    
  trades_table:
    columns: [date, symbol, side, quantity, price, pnl]
    max_rows: 100  # First/last 50 if > 100
    
  disclaimer:
    text: string   # Required legal disclaimer (see Product Spec §11.2)
    
  footer:
    page_numbers: true
    confidentiality: optional string
```

### HTML Export Schema

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="generator" content="Quantlab {version}">
  <meta name="created" content="{timestamp}">
  <meta name="run-id" content="{run_id}">
  <title>Backtest Report: {strategy_name}</title>
  <style>/* Embedded styles for standalone viewing */</style>
</head>
<body>
  <header>
    <h1>{strategy_name}</h1>
    <p class="provenance">
      Run ID: {run_id}<br>
      Strategy Hash: {strategy_hash}<br>
      Data Rev: {data_rev}
    </p>
  </header>
  
  <section id="summary">
    <!-- Key metrics in cards -->
  </section>
  
  <section id="equity-chart">
    <!-- Embedded SVG (preferred) or PNG -->
  </section>
  
  <section id="metrics">
    <!-- Full metrics table -->
  </section>
  
  <section id="trades">
    <!-- Trade list with client-side pagination -->
  </section>
  
  <footer>
    <p class="disclaimer">{required_disclaimer}</p>
  </footer>
</body>
</html>
```

### CSV Export Schema

```csv
# Quantlab Export v1.0
# Run ID: {run_id}
# Strategy: {strategy_name}
# Strategy Hash: {strategy_hash}
# Data Rev: {data_rev}
# Generated: {timestamp}
#
date,symbol,side,quantity,price,commission,slippage,pnl,cumulative_pnl
2024-01-15,AAPL,BUY,100,185.50,0.50,0.10,,
2024-02-20,AAPL,SELL,100,192.30,0.50,0.08,680.00,680.00
```

### Export Validation Requirements

All exports MUST:
1. Include provenance header (run_id, hashes)
2. Include required disclaimer text
3. Be deterministic (same run → same export, excluding generation timestamp)
4. Pass schema validation before file write

---

# §18. Strategy API Contract

## 18.1 Supported Forms

| Form | Signature | Support |
|------|-----------|---------|
| Vectorized | `def strategy(data) -> Signals` | ✓ Full |
| Event-driven | `def on_bar(ctx)` | ✓ Full |
| Class-based | `class MyStrategy(ql.Strategy)` | ✓ Full |

## 18.2 Vectorized API

```python
def strategy(data):
    """
    Args:
        data: DataFrame with OHLCV + any precomputed features
    
    Returns:
        ql.signals() with entry/exit conditions
    """
    fast = ql.sma(data.close, 10)
    slow = ql.sma(data.close, 20)
    
    return ql.signals(
        entry_long=fast > slow,
        exit_long=fast < slow
    )
```

### Parameter Extraction

```python
# Parameters declared with ql.param()
fast_period = ql.param('fast_period', default=10, min=5, max=50)

def strategy(data):
    fast = ql.sma(data.close, fast_period)
    ...
```

## 18.3 Event-Driven API

```python
def on_bar(ctx):
    """
    Called once per bar after bar completes.
    
    Args:
        ctx: Context with current bar, indicators, portfolio
    """
    if ctx.indicators['fast_ma'] > ctx.indicators['slow_ma']:
        ctx.buy()
```

### State Persistence

User state in module globals or closure variables:
- Captured at checkpoint
- Restored on resume

## 18.4 Class-Based API

```python
class MyStrategy(ql.Strategy):
    def __init__(self):
        self.fast_period = ql.param('fast_period', 10)
    
    def on_bar(self, ctx):
        fast = ql.sma(ctx.data.close, self.fast_period)
        if fast[-1] > fast[-2]:
            ctx.buy()
```

### Instance State

Instance variables:
- Captured via pickle at checkpoint
- Exclude non-serializable with `__quantlab_no_checkpoint__`

## 18.5 Debugger Compatibility

| Feature | Vectorized | Event-Driven | Class-Based |
|---------|------------|--------------|-------------|
| Time-travel scrubbing | ✓ | ✓ | ✓ |
| Condition capture | ✓ | ✓ | ✓ |
| Variable inspection | Limited | Full | Full |
| Bi-directional nav | ✓ | ✓ | ✓ |

## 18.6 Code Modification Contract [NEW]

### Formatting Preservation Requirement

When modifying strategy code (e.g., "Apply to Code" feature), the engine MUST preserve:
- All comments (inline and block)
- Whitespace and indentation style
- String quote style
- Trailing commas

### Required Implementation

Code modification MUST use a **Concrete Syntax Tree (CST)** library, not AST.

| Library | Status | Notes |
|---------|--------|-------|
| LibCST | RECOMMENDED | Full Python 3.x support, maintained by Meta |
| RedBaron | ACCEPTABLE | Alternative CST library |
| `ast` module | FORBIDDEN | Discards comments/formatting |

### Validation Test

```python
def test_formatting_preserved():
    original = '''
    # My strategy comment
    fast_period = ql.param('fast_period', default=10)  # inline comment
    '''
    
    modified = apply_param_change(original, 'fast_period', 'default', 15)
    
    # Comments must be preserved
    assert '# My strategy comment' in modified
    assert '# inline comment' in modified
    
    # Only the value changes
    assert 'default=15' in modified
```

---

# §19. Time-Travel Debugger Contract

## 19.1 Scope

The debugger provides deterministic replay of strategy execution with state inspection.

## 19.2 Supported Constructs

| Construct | Captured | Notes |
|-----------|----------|-------|
| Comparisons (`a > b`) | ✓ | Values + result |
| Boolean operators | ✓ | Short-circuit captured |
| Function returns | ✓ | `ql.*` functions |
| Variable assignments | ✓ | Top-level in strategy |
| Pandas operations | ⚠ Limited | Result only, not intermediate |
| NumPy operations | ⚠ Limited | Result only |
| External library calls | ✗ | Opaque |
| `eval()` / `exec()` | ✗ | Not supported |
| Numba JIT | ✗ | Not supported |

## 19.3 Unsupported / Limitations

When unsupported construct detected:

```
⚠ Some expressions could not be captured for debugging:
• Line 15: External library call (talib.RSI)
• Line 23: Numba JIT function

Time-Travel will show results but not intermediate values.
```

## 19.4 Recording Contract

| Item | Recorded | Rate |
|------|----------|------|
| Bar OHLCV | ✓ | Every bar |
| Indicator values | ✓ | Every bar |
| Conditions evaluated | ✓ | Every bar |
| Signal generated | ✓ | Every bar |
| Portfolio state | ✓ | Every bar |
| Orders/fills | ✓ | On event |

### Storage Limits

| Limit | Value |
|-------|-------|
| Max debug file | 4 GB |
| Bars before sampling | 100,000 |
| Sample rate (if exceeded) | Every 10th bar |

### Privacy Bounds [NEW]

| Data | Recorded | Never Recorded |
|------|----------|----------------|
| OHLCV prices | ✓ | — |
| Indicator values | ✓ | — |
| Signal logic | ✓ | — |
| Portfolio state | ✓ | — |
| Strategy code | ✓ (in artifact) | — |
| — | — | Broker credentials |
| — | — | API keys |
| — | — | Account numbers |

## 19.5 Performance Requirements [NEW]

| Operation | Target | Max |
|-----------|--------|-----|
| Jump to bar (< 1GB file) | 100ms | 500ms |
| Jump to bar (1-4GB file) | 200ms | 1000ms |
| Render state at bar | 50ms | 200ms |
| Load debug file index | 500ms | 2000ms |

### Storage Format Recommendation

For files > 1GB, use columnar format (Apache Arrow/Parquet) to enable:
- Efficient partial reads
- Column-based filtering
- Memory-mapped access

## 19.6 Memory-Mapped File Specification [NEW]

### Cross-Platform Implementation

```python
import mmap
import os
import sys
from pathlib import Path
from typing import Optional

class DebugFileManager:
    """Cross-platform memory-mapped debug file handling."""
    
    def __init__(self, path: Path):
        self.path = path
        self._lock_path = path.with_suffix('.lock')
        self._lock_file: Optional[IO] = None
        self._data_file: Optional[IO] = None
        self._mmap: Optional[mmap.mmap] = None
    
    def open(self, mode: str = 'r'):
        """Open debug file with platform-appropriate locking."""
        
        # Validate path is not on network drive
        self._validate_local_path()
        
        # Acquire exclusive lock
        self._acquire_lock()
        
        # Open the data file
        file_mode = 'r+b' if mode == 'r' else 'w+b'
        self._data_file = open(self.path, file_mode)
        
        # Memory-map the file
        if mode == 'r' and self.path.stat().st_size > 0:
            self._mmap = mmap.mmap(
                self._data_file.fileno(),
                0,  # Map entire file
                access=mmap.ACCESS_READ
            )
    
    def _validate_local_path(self):
        """Ensure file is on local storage, not network drive."""
        path_str = str(self.path.resolve())
        
        if sys.platform == 'win32':
            # Check for UNC paths (\\server\share)
            if path_str.startswith('\\\\'):
                raise DebugPathError(
                    "Debug files cannot be stored on network drives. "
                    f"Path: {path_str}"
                )
            # Check for mapped network drives
            drive = path_str[0:2] if len(path_str) >= 2 else ''
            if drive and self._is_network_drive_windows(drive):
                raise DebugPathError(
                    f"Debug files cannot be stored on network drives. "
                    f"Drive {drive} is a network location."
                )
        else:
            # Unix: Check mount type
            if self._is_network_mount_unix(self.path):
                raise DebugPathError(
                    "Debug files cannot be stored on network filesystems (NFS/CIFS). "
                    f"Path: {path_str}"
                )
    
    def _acquire_lock(self):
        """Acquire platform-specific file lock."""
        self._lock_file = open(self._lock_path, 'w')
        
        if sys.platform == 'win32':
            import msvcrt
            try:
                msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            except IOError:
                raise DebugFileLockError(
                    f"Debug file is locked by another process: {self.path}"
                )
        else:
            import fcntl
            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except IOError:
                raise DebugFileLockError(
                    f"Debug file is locked by another process: {self.path}"
                )
    
    def _release_lock(self):
        """Release file lock."""
        if self._lock_file:
            if sys.platform == 'win32':
                import msvcrt
                try:
                    msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except:
                    pass
            # Unix: lock released on file close
            self._lock_file.close()
            self._lock_file = None
            
            # Clean up lock file
            try:
                self._lock_path.unlink()
            except:
                pass
    
    def close(self):
        """Close memory-mapped file and release lock."""
        if self._mmap:
            self._mmap.close()
            self._mmap = None
        if self._data_file:
            self._data_file.close()
            self._data_file = None
        self._release_lock()
    
    def __enter__(self):
        self.open()
        return self
    
    def __exit__(self, *args):
        self.close()
```

### Platform Constraints

| Platform | Max File Size | Notes |
|----------|---------------|-------|
| Windows 32-bit | 2 GB | Limited by address space |
| Windows 64-bit | 4 GB | Spec limit (not OS limit) |
| macOS | 4 GB | Spec limit |
| Linux | 4 GB | Spec limit |

### Crash Recovery

If the application crashes while debug file is open:

```python
def cleanup_stale_locks():
    """Called on application startup to clean up stale locks."""
    
    debug_dir = Path.home() / '.quantlab' / 'debug'
    
    for lock_file in debug_dir.glob('*.lock'):
        # Check if lock is stale (owning process dead)
        try:
            # Try to acquire lock
            with open(lock_file, 'w') as f:
                if sys.platform == 'win32':
                    import msvcrt
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            
            # If we got here, lock was stale - remove it
            lock_file.unlink()
            log.info(f"Removed stale lock file: {lock_file}")
            
        except IOError:
            # Lock is held by live process - leave it
            pass
```

### Large File Indexing

For efficient navigation in large debug files:

```python
class DebugFileIndex:
    """Index for fast random access to debug file."""
    
    def __init__(self, debug_file: DebugFileManager):
        self.debug_file = debug_file
        self.bar_offsets: List[int] = []  # Byte offset for each bar
        self.trade_bars: List[int] = []    # Bar indices with trades
    
    def build_index(self):
        """Build index from debug file. Called once on file open."""
        # Scan file to find bar boundaries
        # Store offsets for O(1) random access
        pass
    
    def jump_to_bar(self, bar_index: int) -> BarState:
        """Jump directly to bar using index. O(1) time."""
        offset = self.bar_offsets[bar_index]
        self.debug_file._mmap.seek(offset)
        return self._read_bar_state()
    
    def next_trade_bar(self, current_bar: int) -> Optional[int]:
        """Find next bar with a trade. O(log n) via binary search."""
        import bisect
        idx = bisect.bisect_right(self.trade_bars, current_bar)
        return self.trade_bars[idx] if idx < len(self.trade_bars) else None
```

---

# §20. AI Panel Data Flow

## 20.1 Data Sent to AI

| Category | Sent | Consent |
|----------|------|---------|
| Strategy code | ✓ If user asks | Implicit |
| Error messages | ✓ If user asks | Implicit |
| Data samples | ⚠ Opt-in | Explicit prompt |
| Broker credentials | ✗ Never | — |
| Trading history | ✗ Never | — |
| Personal data | ✗ Never | — |

## 20.2 Consent Surface

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AI Assistant wants to analyze your strategy code to help debug.             │
│                                                                              │
│ This will send:                                                             │
│ • strategy.py (120 lines)                                                   │
│ • Error message from backtest                                               │
│                                                                              │
│ ☐ Don't ask again for this session                                          │
│                                                                              │
│                                              [Cancel] [Send to AI]           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 20.3 Retention

- Conversations: Stored locally only
- Sent context: Not retained by AI provider
- Audit log: `~/.quantlab/ai_audit.log`

## 20.4 Offline Mode

When offline:
- AI Panel shows "Offline - AI assistance unavailable"
- No queuing of requests
- Local help/docs still accessible

## 20.5 AI Panel Input Sanitization [NEW]

### Client-Side Protection

Before sending any user input to AI, apply sanitization:

```typescript
const SENSITIVE_PATTERNS = [
  // Account identifiers
  /\b[A-Z0-9]{8,12}\b/g,  // Account numbers
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,  // Card numbers
  
  // API keys (various providers)
  /\b(APCA|pk_live|sk_live|api[_-]?key)[A-Za-z0-9_-]{10,}\b/gi,
  
  // Financial data tables (P&L, balances)
  /\$[\d,]+\.\d{2}\s*(profit|loss|p&l|balance)/gi,
];

function sanitizeInput(text: string): SanitizeResult {
  let sanitized = text;
  const warnings: string[] = [];
  
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
      warnings.push(`Potentially sensitive data detected and redacted`);
    }
  }
  
  return { sanitized, warnings, hadSensitiveData: warnings.length > 0 };
}
```

### User Warning

If sensitive data detected:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ SENSITIVE DATA DETECTED                                                    │
│                                                                              │
│ Your message appears to contain sensitive information:                      │
│ • Account numbers                                                           │
│ • Financial data                                                            │
│                                                                              │
│ This data has been automatically redacted before sending.                   │
│                                                                              │
│ Your original message:                                                      │
│ "Why is my account 12345678 showing $50,000 loss?"                         │
│                                                                              │
│ Will be sent as:                                                            │
│ "Why is my account [REDACTED] showing [REDACTED] loss?"                    │
│                                                                              │
│                                              [Cancel] [Send Anyway]          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 20.6 AI Panel Security Model [NEW]

### Threat Categories

| Threat | Risk Level | Mitigation |
|--------|------------|------------|
| **Data Exfiltration** | Medium | Client-side sanitization (§20.5) |
| **Prompt Injection** | Low | Sandbox code execution, no AI tool use |
| **Credential Theft** | High | Secrets never in context window |
| **Social Engineering** | Low | Fixed system prompts, no user overrides |
| **Model Extraction** | Low | Rate limiting, anomaly detection |

### Data Flow Security

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INPUT                                │
│  "Why is my strategy losing money?"                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT-SIDE SANITIZER                         │
│  • Regex patterns for account numbers, API keys                 │
│  • Financial data pattern detection                             │
│  • Warning dialog if sensitive data detected                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CONTEXT BUILDER                               │
│  ✓ Strategy code (if user consents)                             │
│  ✓ Error messages                                               │
│  ✓ Sanitized metrics (no absolute dollar values)                │
│  ✗ Broker credentials (NEVER)                                   │
│  ✗ Account numbers (NEVER)                                      │
│  ✗ Trading history (NEVER)                                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AI PROVIDER                                   │
│  • TLS 1.3 encryption in transit                                │
│  • No data retention (per API agreement)                        │
│  • Rate limited (100 requests/hour per user)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    RESPONSE FILTER                               │
│  • No executable code blocks auto-run                           │
│  • Links open in external browser (not in app)                  │
│  • Audit log entry created                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Security Controls

| Control | Implementation |
|---------|---------------|
| Rate limiting | 100 requests/hour, exponential backoff on limit |
| Audit logging | All requests logged locally with timestamp |
| Consent tracking | Explicit consent required per data type per session |
| Offline fallback | Local help docs when AI unavailable |
| Kill switch | User can disable AI panel entirely in Settings |

### Prohibited Operations

The AI panel MUST NOT:
1. Execute code on behalf of the user without explicit confirmation
2. Access filesystem beyond strategy code in current workspace
3. Make network requests beyond the AI API endpoint
4. Modify user settings or configuration
5. Submit orders or modify positions
6. Access or display credentials from keychain
7. Persist any data sent to AI beyond current session

### Audit Log Format

```json
{
  "timestamp": "2026-01-25T14:30:00Z",
  "session_id": "abc123",
  "request_id": "req_456",
  "action": "ai_query",
  "data_sent": {
    "strategy_code": true,
    "error_message": true,
    "metrics": false,
    "trades": false
  },
  "sanitization_applied": ["account_number_redacted", "api_key_redacted"],
  "user_consent": "explicit",
  "response_length": 1234,
  "latency_ms": 850
}
```

---

# §21. Non-Goals & Deferred (V2)

## 21.1 Explicitly Not in V1

| Feature | Reason |
|---------|--------|
| Tick-level backtesting | Bar-based focus |
| Team collaboration | Single-user first |
| DockerRunner | LocalRunner only |
| Options/Futures | Different asset class |
| Leverage > 1x | 100% collateral only |
| Mobile app | Desktop-first |

## 21.2 Known Limitations

| Limitation | Workaround |
|------------|------------|
| No intrabar simulation | Conservative fill + slippage |
| 100% collateral | Design market-neutral at 1x |
| Single broker per session | Use multiple sessions |

---

# Appendix A: Glossary

| Term | Definition |
|------|------------|
| Signal Bar | Bar whose data generates signals (bar t) |
| Execution Bar | Bar during which orders fill (bar t+1) |
| DataRev | Immutable data revision snapshot |
| UniverseRev | Immutable universe membership snapshot |
| MTM | Mark-to-market |
| TIF | Time-in-force |
| WFA | Walk-forward analysis |
| CST | Concrete Syntax Tree |
| NFC | Unicode Normalization Form Composed |

---

*End of Quantlab Technical Specification V2.5*
