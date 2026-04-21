# Cross-Cutting / Systemic Gaps

These gaps affect multiple phases and don't fit neatly into a single phase category.

---

## 1. TypeScript / VS Code Extension

### GAP-CC-001: Zero TypeScript Extension Code Written
- **Severity**: CRITICAL (Systemic)
- **Description**: The implementation plan specifies ~30+ TypeScript files across all phases. None have been implemented. This is the single largest systemic gap.
- **Impact**: The application is a Python engine with no user interface. All user interaction, monitoring, configuration, and visualization is missing.
- **Full inventory**: See `08_TypeScript_Gaps.md` for complete file listing.

---

## 2. Configuration System

### GAP-CC-002: No Centralized Configuration Manager
- **Severity**: Major
- **Description**: Multiple modules independently read configuration (daemon reads from SessionConfig, risk reads from config, calendar reads from YAML). No centralized configuration manager validates and distributes settings.
- **What's needed**: `config/manager.py` that loads `~/.quantlab/config.yaml`, validates against schema, provides typed access.

### GAP-CC-003: Configuration File Schema Not Enforced
- **Severity**: Major
- **Description**: `Appendix_D_Technical_Reference.md` specifies a detailed configuration schema with sections for engine, daemon, risk, calendar, logging, etc. No schema validation exists.
- **Impact**: Invalid configuration silently accepted, may cause runtime errors.

---

## 3. Error Handling

### GAP-CC-004: Error Recovery Paths Not Tested
- **Severity**: Major
- **Description**: `errors/taxonomy.py` defines error codes with recovery types (RETRY, FALLBACK, USER_ACTION, FATAL). But no tests verify that the correct recovery action is taken for each error type.
- **What's needed**: Error scenario tests validating recovery behavior.

### GAP-CC-005: Error Reporting to UI Not Implemented
- **Severity**: Major
- **Description**: When errors occur in the daemon/engine, they are logged but not forwarded to the UI via IPC. Plan specifies `error.state` IPC message type.
- **What's needed**: Error notification pipeline from engine → daemon → IPC → UI.

---

## 4. Annualization

### GAP-CC-006: Annualization Factor Not Calendar-Aware
- **Severity**: Major
- **Description**: Plan specifies annualization should use the correct factor based on trading calendar:
  - Equities: sqrt(252)
  - Crypto: sqrt(365)
  - Custom: Based on calendar definition
- `metrics/annualize.py` exists but need to verify it properly uses calendar-specific factors rather than hardcoding 252.
- **Impact**: Crypto and non-standard calendar metrics would be incorrectly annualized.

---

## 5. Unicode Normalization

### GAP-CC-007: Unicode Normalization Applied Inconsistently
- **Severity**: Minor
- **Description**: Golden tests UNI001-UNI003 test Unicode normalization. `utils/normalize.py` exists, but need to verify it's applied at all data entry points (file paths, symbol names, user input).
- **What's needed**: Verification that normalization is applied at boundaries.

---

## 6. Platform Compatibility

### GAP-CC-008: Windows Named Pipe Support Not Tested
- **Severity**: Major
- **Description**: Plan specifies Named Pipes on Windows instead of Unix sockets. `protocol/transport.py` and `daemon/ipc.py` reference `UnixSocketServer` but Windows Named Pipe support is unclear.
- **What's needed**: Verify Windows transport layer, or implement `NamedPipeServer` class.

### GAP-CC-009: Windows Daemonization Not Implemented
- **Severity**: Major
- **Description**: `lifecycle.py` `daemonize()` function uses Unix `fork()` which is not available on Windows. The function has a warning log but no actual Windows equivalent.
- **What's needed**: Windows service or background process mechanism (e.g., `subprocess.CREATE_NO_WINDOW`).

### GAP-CC-010: Windows PID File Locking Uses fcntl
- **Severity**: Major
- **Description**: `lifecycle.py` uses `fcntl.flock()` which is Unix-only. Windows requires `msvcrt.locking()` or similar.
- **Impact**: Daemon cannot start on Windows.

---

## 7. Dependency Management

### GAP-CC-011: psutil Not in Required Dependencies
- **Severity**: Minor (may be fixed)
- **Description**: `psutil` is used by `daemon/lifecycle.py`, `daemon/watchdog.py`, `daemon/power.py` but need to verify it's in `pyproject.toml` dependencies.
- **Resolution**: Check `pyproject.toml` - it IS listed as a dependency. Confirmed no gap.

### GAP-CC-012: argon2-cffi Not in Dependencies
- **Severity**: Major
- **Description**: Plan specifies `argon2-cffi` for key derivation in secrets module. Need to verify it's in `pyproject.toml`.
- **Impact**: Encrypted secrets fallback may not work if dependency is missing.
- **Resolution**: Check if `secrets/encrypted.py` uses argon2 or alternative KDF.

---

## 8. Logging

### GAP-CC-013: Log Correlation ID Not Implemented
- **Severity**: Minor
- **Description**: Plan specifies log correlation IDs for tracing requests across daemon/engine/UI boundaries. No correlation ID exists in the logging config.
- **What's needed**: `request_id` field in log context, propagated through IPC.

---

## 9. Monitoring

### GAP-CC-014: No Prometheus/Metrics Endpoint
- **Severity**: Minor
- **Description**: Plan mentions monitoring but no metrics export endpoint exists (e.g., Prometheus, StatsD).
- **What's needed**: Optional metrics endpoint for external monitoring.

---

## 10. Backup & Migration

### GAP-CC-015: Backup/Export for User Data Not Implemented
- **Severity**: Major
- **Description**: Plan mentions backup and migration for:
  - Strategy files
  - Configuration
  - Secrets (encrypted)
  - Historical data
  - Backtest results
  - Audit logs
- No backup or migration utility exists.
- **What's needed**: `quantlab backup create` / `quantlab backup restore` CLI commands.

---

## Summary

Cross-cutting gaps: **15 total** (1 CRITICAL, 8 Major, 6 Minor). The zero TypeScript work is the most impactful systemic gap. Platform compatibility issues (Windows support) and centralized configuration are the next most important.
