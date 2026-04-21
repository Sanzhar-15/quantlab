# IPC + Daemon Integration Gaps (Critical)

This section compares the **IPC Protocol spec (Appendix_B)** to the actual daemon and extension implementation. The mismatches below **block** end‑to‑end live trading.

---

## 1) Handshake/Auth Flow Missing in Client

**Evidence**
- Daemon expects `auth` / `authenticate` as the first message after optional `negotiate` in `engine/quantlab/daemon/ipc.py`.
- Client only negotiates and then sends normal requests with `_auth` params in `extensions/quantlab/src/core/trading/DaemonClient.ts`.

**Impact**
- First client request is rejected as “First message must be negotiate or auth”.
- All IPC traffic fails even if the socket connects.

**Optimal Fix**
- Add an explicit **auth handshake** in `DaemonClient.connect()`:
  - After `negotiate`, send `auth` with `{ token }` (read from token file).
  - Wait for `auth_result` before any other request.
- Alternatively, update daemon handshake logic to accept `_auth` on the first request **and** allow the first method to be any JSON‑RPC request (not only `auth`).

---

## 2) IPC Method Names Don’t Match the Spec

**Evidence**
- Spec expects `session.start`, `session.pause`, `session.resume`, `session.stop`, `flatten.request`, `health.check`, `status.get` (Appendix_B).
- Daemon handlers register `pause`, `resume`, `stop`, `flatten`, `health`, `status` in `engine/quantlab/daemon/main.py`.
- Client calls `session.*`, `flatten.all`, `health.check`, `status.get` in `extensions/quantlab/src/core/trading/DaemonClient.ts`.

**Impact**
- Requests return “Method not found”, so sessions can’t start/pause/resume/stop via daemon.

**Optimal Fix**
- Standardize on **Appendix_B** method names:
  - Implement `session.start|pause|resume|stop` and `flatten.request` in daemon **or** add alias handlers.
  - Update client to call canonical names only (no “flatten.all”).

---

## 3) IPC Payload Schema/Casing Mismatch

**Evidence**
- Daemon expects snake_case fields in `engine/quantlab/daemon/main.py`:
  - `order_type`, `limit_price`, `stop_price`, `order_id`, `risk_limits.max_exposure`, etc.
- Client types use camelCase in `extensions/quantlab/src/core/ipc/types.ts`:
  - `orderType`, `limitPrice`, `stopPrice`, `orderId`, `riskLimits.maxExposure`.

**Impact**
- Orders are rejected as missing required fields.
- Cancels fail (`order_id` not provided).
- Risk limits never apply (wrong field names).

**Optimal Fix**
- Introduce a **schema translation layer** in `DaemonClient`:
  - Map camelCase → snake_case for request params.
  - Map snake_case → camelCase for responses.
- OR update daemon handlers to accept both formats to preserve backward compatibility.

---

## 4) Missing IPC Handlers for Client Requests

**Evidence**
- Client calls `positions.get` and `orders.get` in `extensions/quantlab/src/core/trading/DaemonClient.ts`.
- Daemon has **no handlers** for those methods in `engine/quantlab/daemon/main.py`.

**Impact**
- UI can’t hydrate initial session state.

**Optimal Fix**
- Add `positions.get` and `orders.get` handlers in daemon, returning current tracked state.
- Consider adding `fills.get` for symmetry.

---

## 5) State/Status Notifications Don’t Match Client Expectations

**Evidence**
- Client listens for `positions.update`, `orders.update`, `fills.update`, `risk.alert`, `connection.status` in `extensions/quantlab/src/core/trading/DaemonClient.ts`.
- Daemon mostly emits `status.update` and `error` notifications; no `positions.update` / `orders.update` / `fills.update` in `engine/quantlab/daemon/main.py`.

**Impact**
- UI never receives live state updates, risk alerts, or broker status.

**Optimal Fix**
- Emit notifications that match Appendix_B:
  - `positions.update`, `orders.update`, `fills.update`, `risk.alert`, `connection.status`.
- Update client to also accept `status.update` during transition, then remove legacy path.

---

## 6) Daemon CLI Invocation Does Not Exist

**Evidence**
- Extension spawns `python -m quantlab.daemon start --session-id ... --symbol ... --timeframe ... --paper` in `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`.
- Python daemon CLI (`engine/quantlab/daemon/main.py`) expects `--session-id --strategy --broker --symbols` and has **no** `start` subcommand. There is no `engine/quantlab/daemon/__main__.py`.

**Impact**
- Daemon won’t start from the UI, regardless of IPC correctness.

**Optimal Fix**
- Create `engine/quantlab/daemon/__main__.py` with a CLI that matches the extension **or** update the extension to call the existing CLI:
  - Example: `python -m quantlab.daemon.main --session-id ... --strategy ... --broker ... --symbols ...`.
- Add args for `--paper`, `--timeframe`, and risk limits (or translate to broker + mode).

---

## 7) Token Ownership/Race Condition

**Evidence**
- Extension writes token file + env `QUANTLAB_AUTH_TOKEN` in `LiveDaemonManager.ts`.
- Daemon ignores env and generates its own token via `TokenManager` in `engine/quantlab/daemon/main.py`.

**Impact**
- Token file may be overwritten; client can read stale token if it connects too early.

**Optimal Fix**
- Choose one source of truth:
  - **Option A**: daemon generates token and extension waits for the daemon’s token file before authenticating.
  - **Option B**: allow daemon to accept an injected token via env or CLI and skip regeneration.

---

## 8) Protocol Meta/Sequence Not Consumed

**Evidence**
- Daemon sends `_meta.sequence` in notifications (`engine/quantlab/protocol/message.py`).
- Client ignores `_meta` entirely in `DaemonClient`.

**Impact**
- No gap detection/resync; ordering guarantees in spec are not enforced in UI.

**Optimal Fix**
- Parse `_meta.sequence` in `DaemonClient` and forward to `SessionManager` for gap detection.
- Implement resync logic on sequence gaps using daemon snapshot support.
