//! Lexical local-binding environment for LET / LAMBDA (Wave P, 2026-06-20).
//!
//! `LET` introduces named locals (`LET(rate, 0.08, price, 125, price*(1+rate))`)
//! and `LAMBDA` (Phase 2) introduces parameter names captured in a closure. Both
//! need a **lexical scope** that is:
//!
//! - **eval-time-only** — a local binding NEVER lands in a stored cell `Value`
//!   (the 24-byte grid value type is untouched). A callable that reaches a cell
//!   result surfaces as `#CALC!`, matching Excel (and the formualizer donor).
//! - **persistent / immutable** — `with_binding` returns a NEW env that shares
//!   the existing chain structurally (an `Arc` bump). This makes closure capture
//!   a cheap snapshot: a `LAMBDA` clones the env at creation and a later
//!   re-binding of the same name does NOT mutate the captured copy.
//! - **case-insensitive for free** — the parser canonicalizes every identifier
//!   to ASCII-uppercase (`canonicalize_function_name`), so names stored here and
//!   names looked up here are both uppercase; `x` and `X` are the same binding.
//!
//! `Arc` (not `Rc`) is used so the env / closure are `Send + Sync`: evaluation is
//! single-threaded per recalc today, but keeping these `Send` avoids constraining
//! the eval path and matches the rest of the engine's `Arc`-everywhere posture.

use std::sync::Arc;

use ql_types::{ArrayValue, Value};

use crate::plan::ExprPlan;

/// **Wave P (2026-06-20):** a LAMBDA closure value. Created by `LAMBDA(p…, body)`,
/// it captures its DEFINING lexical environment (a SNAPSHOT) so a later rebinding
/// of an outer name does not change what the closure sees (donor
/// `lambda_closure_snapshot_semantics`). Invoked via `ExprPlan::CallLambda`
/// (immediate `LAMBDA(..)(args)`, a LET-bound `f(args)`, or a chained call).
/// Never stored in a cell `Value` — a callable that reaches a cell/result
/// position surfaces `#CALC!`.
#[derive(Clone, Debug)]
pub struct LambdaClosure {
    /// Parameter names, canonical uppercase, in declaration order. Unique — the
    /// binder rejects duplicate params with `#VALUE!`.
    pub params: Vec<Arc<str>>,
    /// The body plan, evaluated at each invocation with the params bound.
    pub body: Arc<ExprPlan>,
    /// The lexical environment captured at LAMBDA-creation time (snapshot).
    pub captured_env: LocalEnv,
}

/// A value bound to a local name inside a LET / LAMBDA scope.
#[derive(Clone, Debug)]
pub enum LocalBinding {
    /// A scalar value — the common case (`LET(x, 2, ...)`).
    Value(Value),
    /// An array value (`LET(s, SEQUENCE(3), ...)`). Used in scalar arithmetic
    /// context it surfaces `#CALC!` (no implicit intersection in v1, per the
    /// array-formula design § 6.3); as a cell-root result it spills. Constructed
    /// by the array-aware binding path in `eval_at_cell_boundary`.
    Array(ArrayValue),
    /// A LAMBDA closure (`LET(f, LAMBDA(n, n+1), f(5))`). A callable used as a
    /// value rather than invoked surfaces `#CALC!`.
    Callable(Arc<LambdaClosure>),
}

/// One link in the persistent (immutable) lexical-scope chain. Private; the
/// chain is only reachable through [`LocalEnv`].
#[derive(Debug)]
struct Node {
    /// Canonical (ASCII-uppercase) local name.
    name: Arc<str>,
    binding: LocalBinding,
    parent: Option<Arc<Node>>,
}

/// An immutable lexical environment of local name bindings.
///
/// Cheap to clone (one `Arc` bump) and to capture. `with_binding` returns a new
/// env; the inner-most (most-recently-bound) name shadows any outer binding of
/// the same name on lookup. An empty env (the cell root) is the zero value.
#[derive(Clone, Debug, Default)]
pub struct LocalEnv {
    head: Option<Arc<Node>>,
}

impl LocalEnv {
    /// The empty environment — the lexical scope at a cell root (no locals).
    /// `const` so a `&'static` empty env can back `CellEnv::local_env`'s default.
    pub(crate) const fn empty() -> Self {
        LocalEnv { head: None }
    }

    /// Return a NEW env with `name` bound to `binding`, shadowing any outer
    /// binding of the same name. `name` MUST already be canonical uppercase
    /// (the binder extracts it from a parser-canonicalized `Expr::NameRef`).
    pub(crate) fn with_binding(&self, name: Arc<str>, binding: LocalBinding) -> Self {
        LocalEnv {
            head: Some(Arc::new(Node {
                name,
                binding,
                parent: self.head.clone(),
            })),
        }
    }

    /// Look up `name` (canonical uppercase). The inner-most binding wins.
    /// Returns `None` when the name is not bound locally — the caller then
    /// falls back to the workbook `NameTable` (or `#NAME?`).
    pub(crate) fn lookup(&self, name: &str) -> Option<&LocalBinding> {
        let mut cur = self.head.as_deref();
        while let Some(node) = cur {
            if node.name.as_ref() == name {
                return Some(&node.binding);
            }
            cur = node.parent.as_deref();
        }
        None
    }
}

/// **Wave P (2026-06-20) — Codex/Opus megaudit LOW:** compile-time pin of the
/// `Send + Sync` invariant the module header documents. Using `Arc` (not `Rc`)
/// keeps the lexical env / closures thread-safe; if a future field silently
/// makes any of these `!Send`/`!Sync`, this fails to compile rather than
/// constraining the eval path by accident.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LocalEnv>();
    assert_send_sync::<LocalBinding>();
    assert_send_sync::<LambdaClosure>();
};

#[cfg(test)]
mod tests {
    use super::*;

    fn v(n: f64) -> LocalBinding {
        LocalBinding::Value(Value::number(n))
    }

    #[test]
    fn empty_env_has_no_bindings() {
        let env = LocalEnv::empty();
        assert!(env.lookup("X").is_none());
    }

    #[test]
    fn with_binding_is_non_mutating_snapshot() {
        let e0 = LocalEnv::empty();
        let e1 = e0.with_binding(Arc::from("X"), v(1.0));
        let e2 = e1.with_binding(Arc::from("X"), v(2.0)); // shadow

        // e1 still sees the ORIGINAL binding (snapshot semantics — this is
        // exactly what makes LAMBDA capture a stable scope).
        assert!(matches!(e1.lookup("X"), Some(LocalBinding::Value(Value::Number(n))) if *n == 1.0));
        // e2 sees the shadowing binding.
        assert!(matches!(e2.lookup("X"), Some(LocalBinding::Value(Value::Number(n))) if *n == 2.0));
        // e0 is untouched.
        assert!(e0.lookup("X").is_none());
    }

    #[test]
    fn inner_binding_shadows_outer() {
        let env = LocalEnv::empty()
            .with_binding(Arc::from("A"), v(10.0))
            .with_binding(Arc::from("B"), v(20.0))
            .with_binding(Arc::from("A"), v(30.0));
        assert!(
            matches!(env.lookup("A"), Some(LocalBinding::Value(Value::Number(n))) if *n == 30.0)
        );
        assert!(
            matches!(env.lookup("B"), Some(LocalBinding::Value(Value::Number(n))) if *n == 20.0)
        );
        assert!(env.lookup("C").is_none());
    }
}
