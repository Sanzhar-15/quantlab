# UDF & AI-connector trust model (v1)

> **Status:** v1, Phase 6.4B (`UDF-6-04`). This document is the *honest* trust model
> for the Python user-defined-function (UDF) subsystem as it actually ships — every
> claim below is grounded in a `file:line` citation, not an aspiration. It is
> written across 6.4A/6.4B (UDFs) and will be extended at 6.5 (SQL / data
> connectors). **AI connectors are not available in v1** — the engine reserves the
> `#AI_NOT_AVAILABLE_V1` sigil (`crates/ql-types/src/error.rs`, `ErrorValue::AINotAvailable`)
> and ships no AI execution path; the §"What is NOT defended" boundary below is the
> model any future connector will inherit.
>
> Engine paths are relative to the engine repo
> (`quantbook-engine/`). IDE paths are in the sibling `quantlab/quantlab` repo
> (branch `feat/visualise-v1`), noted inline.

## 0. TL;DR — the one thing to know

**A Python UDF runs arbitrary workspace Python code with the full privileges of the
process that hosts the engine.** There is **no hard sandbox** — no seccomp, no
namespaces, no `rlimit`, no chroot, no container. The v1 safety story is:

1. a **trust gate** (the workspace must be explicitly trusted before any worker
   spawns), plus
2. **subprocess isolation** (the UDF runs in a *separate OS process* so a crash or a
   hang cannot corrupt the engine's memory and can always be killed), plus
3. **resource bounds we can enforce from the Rust side** without cooperation from the
   Python code — a per-call deadline, a per-recalc-pass op-budget, and hard caps on
   the size of data crossing the wire.

That is the entire defensive perimeter. Inside it, a UDF can read your files, open
network sockets, read your environment, import anything installed, and allocate
memory until the OS kills it. **Only enable Python UDFs in workspaces whose code you
trust as much as you trust any other program you would run on your machine.**

---

## 1. What executing a UDF means

A registered Python UDF is dispatched by the formula evaluator
(`crates/ql-exec/src/scalar.rs`, the `None` arm that looks up
`registry.udf_handle(name)`) to an out-of-process Python **worker**. The worker is
spawned as a plain child process:

```rust
// crates/ql-udf/src/process.rs:171-176
let mut cmd = Command::new(&self.config.python);
cmd.arg("-m")
    .arg(&self.config.module)        // e.g. `quantbook.worker`
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())          // the length-prefixed Arrow-IPC protocol channel
    .stderr(Stdio::inherit());       // worker stderr → engine stderr
```

The worker imports the user's module by name with **no allow-list or validation**:

```python
# crates/quantbook-py/python/quantbook/worker.py (importlib.import_module(mod))
```

The child **inherits the engine process's full environment** — `PYTHONPATH` and every
other variable (`crates/ql-udf/src/process.rs:178-191`). It therefore runs with the
same OS user, the same filesystem view, the same network reachability, and the same
environment secrets as the engine host. This is by design for v1 (a developer tool
running the developer's own analysis code); it is also the single most important fact
in this document.

---

## 2. The trust boundary (two gates)

Spawning a worker is gated **twice** — once in the IDE (which owns the concept of a
"workspace") and once in the engine (which owns the session lifecycle). The engine
itself has **no notion of a workspace**; the `worker_untrusted_workspace` error code
is IDE-only and is never emitted by the engine
(`crates/ql-bindings-node/src/lib.rs:5131-5134`).

### 2.1 IDE gate — workspace trust (the *double* gate)

`extensions/quantlab/src/quantbook/udfWorker.ts` (in `quantlab/quantlab`) refuses to
spawn a worker unless the workspace is trusted by **both** trust authorities:

```ts
// udfWorker.ts:198-200
const isWorkspaceTrusted =
    vscode.workspace.isTrusted &&
    TrustManager.getInstance().isWorkspaceTrusted(opts.workspaceUri);
```

- `vscode.workspace.isTrusted` — VS Code Restricted Mode. In Restricted Mode,
  extensions MUST NOT execute workspace code.
- `TrustManager...isWorkspaceTrusted(...)` — QuantLab's own per-workspace trust store.

Both must be true. The gate runs **before** the interpreter is even resolved — an
untrusted workspace never stats a path or spawns a subprocess
(`udfWorker.ts:202-212`). When the gate fails, the pure planner
`planUdfWorkerConfig` returns the IDE-only `[worker_untrusted_workspace]` code and the
caller shows a non-fatal notice (`udfWorker.ts:117-124`). The interpreter is also
verified to be Python ≥ 3.9 before use (`udfWorker.ts:44`, the worker is
3.9-compatible).

This double gate exists because a workspace can be trusted in QuantLab's own store yet
opened in VS Code Restricted Mode — and a UDF worker runs arbitrary workspace Python,
so the stricter of the two authorities must win (6.4-3d Step-5 audit fix, Codex HIGH).

### 2.2 Engine gate — session lifecycle

Injecting the spawned worker into a session is lifecycle-gated:

```rust
// crates/ql-exec/src/session.rs:453-459
pub fn set_udf_worker_checked(&mut self, worker: Box<dyn UdfWorker + Send>) -> EngineResult<()> {
    self.ensure_ready()?;            // rejects Closed / Faulted / New / Busy
    self.udf_worker = Some(RefCell::new(worker));
    Ok(())
}
```

The napi binding spawns + handshakes the worker *outside* the session lock, then
injects it *under* the lock through this checked setter — so a session that closes or
faults during the spawn rejects the worker (and the caller drops it, killing the child)
(`crates/ql-bindings-node/src/lib.rs:5172-5181`).

**What the engine gate does NOT do:** it does not re-derive trust. The engine trusts
that the host (the IDE) only calls `setUdfWorker` for a trusted workspace. A different
napi host that ignores the IDE gate could spawn a worker against an untrusted
workspace — the trust decision is structurally the host's. This is acceptable for v1
(the only host is the QuantLab IDE, which double-gates) and is called out here so no
future host assumes the engine enforces workspace trust.

---

## 3. Process isolation — what it buys, what it does not

The UDF runs in a **separate OS process**, which gives us the properties we *do* rely
on:

- **Memory isolation.** A UDF cannot read or corrupt the engine's address space; the
  only channel is the length-prefixed Arrow-IPC pipe.
- **Crash isolation.** A worker segfault / `os._exit` / fatal exception takes down the
  worker, not the engine; the next call lazily respawns
  (`crates/ql-udf/src/process.rs`, respawn on dead worker).
- **Hard cancel.** Because it is a separate process, it can always be killed (§4) —
  the only honest cancel under a GIL-only CPython.

It does **not** give us any OS-level confinement. Searched
`crates/ql-udf/src/process.rs`, `crates/ql-udf/src/lib.rs`, and
`crates/ql-udf/Cargo.toml` for `seccomp`, `namespace`, `rlimit`, `setrlimit`,
`prctl`, `cgroup`, `chroot`, `libc`, `nix` — **none present.** The worker is an
ordinary subprocess with inherited privileges.

---

## 4. Cancellation and resource bounds (Rust-enforced, no Python cooperation)

Under a GIL-only CPython there is no way to cooperatively interrupt a running UDF — a
`while True: pass` cannot be unwound from outside. So **the only cancel is killing the
process**, and every bound below is ultimately backed by that kill.

### 4.1 Per-call deadline — 30 s

```rust
// crates/ql-exec/src/scalar.rs:66
const UDF_CALL_DEADLINE: Duration = Duration::from_secs(30);
```

The worker's `call()` checks the clock before each frame receive and **kills the
worker** when the deadline passes; a late `RETURN` is dropped:

```rust
// crates/ql-udf/src/process.rs:333-336 (and the recv_timeout arm at :382-385)
if Instant::now() >= deadline_at {
    self.kill_worker();
    return Err(UdfError::Timeout(deadline));
}
```

The cell becomes `#TIMEOUT!` (`ErrorValue::Timeout`) and a `udf_timeout` diagnostic is
recorded.

### 4.2 Per-recalc-pass op-budget — 120 s (the N×30s stall fix)

A single recompute can touch many UDF cells; 30 s each would let N cells stall the
pass for N×30 s. The session arms a **whole-pass budget**:

```rust
// crates/ql-exec/src/scalar.rs:80
pub(crate) const UDF_OP_BUDGET: Duration = Duration::from_secs(120);
```

Each call's effective deadline is clamped to `min(30 s, time remaining in the pass)`:

```rust
// crates/ql-exec/src/scalar.rs:93-103
fn effective_udf_deadline(op_deadline: Option<Instant>, now: Instant) -> Option<Duration> {
    match op_deadline {
        None => Some(UDF_CALL_DEADLINE),
        Some(dl) => match dl.checked_duration_since(now) {
            Some(remaining) if !remaining.is_zero() => Some(remaining.min(UDF_CALL_DEADLINE)),
            _ => None,                       // budget exhausted
        },
    }
}
```

Once the budget is exhausted, remaining UDF cells in the pass are **not dispatched at
all** — they short-circuit to `#TIMEOUT!` with a distinct diagnostic, so the recompute
pass is bounded regardless of UDF count:

```rust
// crates/ql-exec/src/scalar.rs:1194-1200
let Some(effective) = effective_udf_deadline(env.udf_op_deadline(), Instant::now()) else {
    push_udf_cell_diagnostic(env, "udf_budget_exhausted",
        "recompute UDF time budget exhausted before this cell; not dispatched".to_string());
    return FunctionReturn::Scalar(Value::Error(ErrorValue::Timeout));
};
```

Every full-pass recompute that can dispatch a UDF arms this budget — the explicit
`recalc_dirty`/`recalc_all`, the `rematerialize` pass behind undo/redo, and the `open`
load path all route through one `udf_op_deadline_for_pass()` helper
(`crates/ql-exec/src/session.rs`). The only UDF dispatch NOT under the op-budget is a
single `set_formula` that immediately evaluates one UDF cell — that is one call, bounded
by the 30 s per-call deadline (§4.1). The budget is armed only when a worker is attached;
non-UDF / no-worker recompute is byte-for-byte unchanged (deadline `None`). The budget is
**not host-configurable in v1** (filed forward — §7).

### 4.3 Wire-size caps — 5 M cells / 64 MiB

A UDF cannot force an unbounded allocation across the boundary. There are four
distinct allocation layers on the receive path, each separately bounded:

1. **Transport frame** (`frame.rs` `read_frame`) — rejects a frame over `MAX_FRAME_LEN`
   (64 MiB) **before** allocating its payload buffer.
2. **Arrow-IPC internal** — `decode_grid` pre-walks the IPC message framing and rejects
   any message whose declared metadata length or `bodyLength` exceeds `MAX_GRID_BYTES`
   **before** handing the bytes to arrow's `StreamReader` (`codec.rs`
   `precheck_ipc_message_bounds`). This closes a real gap: arrow's `StreamReader`
   otherwise allocates `from_len_zeroed(bodyLength)` from a worker-controlled flatbuffer
   field that the outer buffer-length cap does NOT bound (6.4B closure-audit HIGH).
3. **Engine cell vector** — `decode_grid` rejects a grid over `MAX_GRID_CELLS` (5 M)
   **before** the `Vec::with_capacity` for the decoded cells.
4. **Encode (outbound)** — `encode_grid` rejects argument grids over the cell cap
   **before** building the Arrow arrays; the byte cap on the encode side is checked
   **after** serialization (a transient buffer for an over-cap *outbound* grid, never a
   worker-controlled input — not an attack surface).

The cell-count and byte caps:

```rust
// crates/ql-udf/src/codec.rs:132
pub const MAX_GRID_CELLS: usize = 5_000_000;
// crates/ql-udf/src/codec.rs:137
pub const MAX_GRID_BYTES: usize = crate::frame::MAX_FRAME_LEN as usize;  // 64 MiB
```

`encode_grid` rejects argument grids over the cell cap (`CodecError::GridTooManyCells`),
`decode_grid` rejects return bytes over the byte cap before reading
(`CodecError::GridTooManyBytes`) — both surface as `#VALUE!` + a `udf_grid_too_large`
diagnostic (`crates/ql-exec/src/scalar.rs`, `map_udf_error`). The frame layer is the
exact wire gate underneath:

```rust
// crates/ql-udf/src/frame.rs:88
pub const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;   // rejected on read AND write before alloc
```

> **Coverage note (honest):** the real-worker grid-cap path is enforced and
> unit-tested in `ql-udf`, but the in-process `MockWorker` bypasses the codec, so
> there is no end-to-end real-worker grid-cap integration test yet. Filed forward
> (§7).

---

## 5. Process lifecycle and the orphan caveat

`WorkerProcess::drop` hard-stops and reaps the **direct** child, and **detaches** the
reader thread rather than joining it:

```rust
// crates/ql-udf/src/process.rs:108-127 (abridged)
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();   // reaps the direct child (no zombie)
        drop(self.reader.take());    // DETACH the reader thread — do not join
    }
}
```

The detach is deliberate: if a UDF spawned a **grandchild** that inherited the
worker's stdout write-end, the pipe stays open after the direct child dies, so the
reader's `read_frame` would block forever and joining it would deadlock the engine on
the hard-cancel path.

**The caveat:** a UDF that spawns its own subprocess creates an **orphan**. The
grandchild is reparented to `init` (not killed, not waited), and the one reader thread
+ fd it holds open leaks until the engine process exits. The proper fix —
process-group / session kill so grandchildren die with the worker — needs a `libc`/
`nix` dependency and is filed forward (§7). **In v1, a UDF can outlive its own cancel
by forking.**

---

## 6. Type-conversion safety (the codec is a trust boundary)

The Arrow-IPC decode path is treated as an untrusted input boundary, because the bytes
come from a process running user code:

- The decoder validates the exact 5-field tagged schema (`kind/num/str/bool/err`)
  **before** any positional column access (`crates/ql-udf/src/codec.rs`,
  `EXPECTED_FIELDS`) — a malformed batch is a clean `CodecError`, never an OOB panic.
- **NaN / Inf are rejected on both sides.** Rust decode rejects non-finite numbers
  (`crates/ql-udf/src/codec.rs:538`, `CodecError::NonFinite`); the Python encoder
  rejects them at source (`crates/quantbook-py/python/quantbook/_codec.py:117-120`).
  This preserves the engine invariant that `Value::Number` is always finite
  (`crates/ql-types/src/value.rs`, `Value::number()` sanitizes to `#NUM!`).
- Unknown cell `kind`, null payloads, trailing batches, and shape overflow are all
  explicit errors (`crates/ql-udf/src/codec.rs`, `CodecError` variants).
- A UDF exception never crashes the worker loop — it is caught and returned as a
  `RAISE` control frame, surfacing as `#CALC!` + a `udf_raised` diagnostic
  (`crates/quantbook-py/python/quantbook/worker.py`).

The exhaustive Rust↔Python type-conversion matrix (every `Value` variant, all 15
`ErrorValue` sigils, and the numpy/pandas dtype boundary) is pinned by
`crates/ql-exec/tests/udf_type_matrix.rs` (`UDF-6-03`). Note the honest boundary that
test documents: `numpy.float64` round-trips (it subclasses Python `float`), but
`numpy.int64`, `numpy.bool_`, and pandas `Series`/`DataFrame` do **not** — the Python
encoder only accepts `(int, float, bool, str, None, Err)` and raises a loud
`TypeError` (surfaced as `#CALC!`) for anything else. There is no silent coercion.

---

## 7. What is NOT defended (the explicit boundary)

Everything below is **out of scope for v1**. A UDF — i.e. arbitrary trusted-workspace
Python — can do all of these, and the engine neither prevents nor detects them. This
list is exhaustive as of 6.4B; searched the `ql-udf` crate, `worker.py`, and the napi
binding for any corresponding restriction and found none unless noted.

| Capability | v1 behavior | Why it's unguarded |
|---|---|---|
| **Filesystem** | Full read/write/delete as the engine's OS user | No chroot / no seccomp; subprocess inherits the host view |
| **Network** | Arbitrary outbound (and inbound) sockets | No network namespace / no egress filter |
| **Environment / secrets** | Reads & mutates all inherited env vars | Full env inherited (`process.rs:178-191`) |
| **Module imports** | Imports any installed package, no allow-list | `importlib.import_module` is called directly (`worker.py`) |
| **Memory** | Allocates until the OS OOM-kills the worker | No `rlimit`/cgroup memory cap (searched, absent) |
| **CPU** | Bounded only by the 30 s/120 s *wall-clock* deadlines, not CPU quota | No `setrlimit(RLIMIT_CPU)` / no cgroup CPU cap |
| **Subprocess spawning** | Spawns arbitrary children; they **orphan** on cancel (§5) | No process-group kill (needs `libc`/`nix`) |
| **Persistence across cancel** | A forked grandchild survives worker-kill | Reparented to `init`, not in the kill set |
| **Worker statefulness** | UDF module globals, open file descriptors, and live sockets **persist across calls and recompute passes** | The worker process is long-lived — `ProcessWorker` reuses one child and only respawns it after it dies (`process.rs`), and the session preserves `udf_worker` across edits/open. A UDF that opens a socket or accumulates state on one call still sees it on the next; nothing tears the worker down between invocations |

The defensive perimeter that **is** in place: the workspace-trust double gate (§2),
process/memory/crash isolation (§3), the kill-backed deadline + op-budget + wire caps
(§4), reaped direct child (§5), and the hardened codec boundary (§6). Nothing more.

---

## 8. Hardening roadmap (filed forward — not in v1)

These are known gaps, tracked for post-v1. None is a regression; each is an
intentional v1 scope cut recorded here so the boundary stays honest:

1. **OS-level sandbox.** seccomp-bpf syscall filter and/or namespaces + cgroup limits
   (memory, CPU, pids) around the worker — the real fix for §7. Needs `libc`/`nix`.
2. **Process-group / session kill** so a forked grandchild dies with the worker (§5),
   closing the orphan + reader-thread/fd leak.
3. **Host-configurable budgets.** Expose `UDF_OP_BUDGET` and per-function deadlines
   over napi instead of the hard-coded 120 s / 30 s (§4).
4. **End-to-end real-worker grid-cap test** (the `MockWorker` bypasses the codec, §4.3).
5. **Egress / filesystem policy** for the eventual AI/data connectors at 6.5 — same
   model, broader surface.

---

## 9. Operator guidance (v1)

- **Enable Python UDFs only in workspaces you trust as fully as any program you would
  run yourself.** The trust gate is a deliberate, informed decision — not a sandbox.
- Treat a `.qbook` / workbook that ships UDF code like a script: review the Python
  before trusting the workspace.
- Do not run untrusted workbooks on machines with ambient credentials (cloud tokens in
  env, SSH agents, writable production mounts) — a UDF inherits all of them (§1, §7).
- A hung or runaway UDF is bounded in *engine* terms (deadline + budget) but can still
  burn CPU/memory/IO on the host until killed, and a forked child can outlive the
  cancel (§5). Watch host resources for workbooks with heavy UDFs.
