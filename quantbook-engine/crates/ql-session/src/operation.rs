//! Operation lifecycle + session lifecycle types (contract §2.3 + §6;
//! acceptance API6-02).

use serde::{Deserialize, Serialize};

use crate::error::EngineError;

/// Opaque identifier for a long-running operation (recalc, UDF, SQL, AI).
///
/// Returned by long commands; the caller polls/waits/cancels by this id. It is
/// opaque — the caller round-trips it without interpreting (contract §6.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct OperationId(pub u64);

/// Terminal-or-running state of an operation (contract §6.1). Terminal states
/// (`Completed`/`Canceled`/`Failed`) are immutable once reached.
// NOTE: not `Eq` — `Failed` holds an `EngineError`, which is not `Eq`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum OperationState {
    /// In progress; the session is [`LifecycleState::Busy`] while this op owns
    /// mutable engine state.
    Running,
    /// Finished successfully.
    Completed,
    /// Canceled cooperatively or pre-start (contract §6.4) — for in-engine
    /// recalc, v1 honors cancel only *before* execution begins.
    Canceled,
    /// Failed with a structured error.
    Failed {
        /// The failure.
        error: EngineError,
    },
}

impl OperationState {
    /// True once the operation can no longer change state.
    pub fn is_terminal(&self) -> bool {
        !matches!(self, OperationState::Running)
    }
}

/// The session's lifecycle state (contract §2.3). Commands are gated on it;
/// an illegal-state call returns [`EngineError::invalid_state`] (never a panic).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    /// Constructed, not yet opened/imported.
    New,
    /// Open and accepting edit/recalc/query commands.
    Ready,
    /// Executing a long operation that owns mutable engine state. Mutating /
    /// recalc commands are rejected with `session_busy`; read-only snapshot of
    /// the last committed state + `cancel`/`operation_status` remain legal.
    /// This is what makes the cancellation/lock story implementable over the
    /// synchronous compute core (contract §2.3 / HIGH-1).
    Busy,
    /// Closed; the handle is freed. Terminal.
    Closed,
    /// An error before/at `Ready`, or a panic during a mutating command, left
    /// the session possibly inconsistent. Terminal; only diagnostics + close.
    Faulted,
}
