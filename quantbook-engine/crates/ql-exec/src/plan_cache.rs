//! Phase 2B.3 (2026-05-12) — bind-plan cache V0.
//!
//! Caches parsed + bound [`ExprPlan`] values keyed by the formula text, the
//! owning sheet, and the workbook's NameTable generation. Lives on
//! [`crate::WorkbookRuntime`] and is shared into spawned
//! [`crate::WorkbookTransaction`] instances through forwarding.
//!
//! ## Invalidation contract
//!
//! Cache entries are NOT explicitly removed on workbook mutation. Instead,
//! the cache key is `(formula_text, sheet_id, name_table_generation)`. When
//! the workbook mutates state that would change a bind result:
//!
//! - User edits formula text → new text, new key, automatic miss.
//! - Caller registers/removes a name → `NameTable::generation()` advances
//!   (per Phase 2B.3 workbook.rs), so plans bound against the prior
//!   generation no longer match.
//!
//! Stale entries accumulate over time; Phase 3 calcgraph integration adds
//! explicit eviction tied to dirty propagation. For Phase 2B.3 the cache
//! is small enough that drift is acceptable — typical workbook formula
//! cardinality is in the thousands, not millions.
//!
//! ## What the cache stores
//!
//! `Arc<ExprPlan>` so cache hits hand back a refcount-bump without cloning
//! the plan tree. `ExprPlan` is `Clone + Debug + PartialEq` per
//! `ql-exec::plan` but the plan tree is non-trivial; sharing via `Arc`
//! keeps the cache cheap.
//!
//! ## References
//!
//! - `.references/hyperformula/src/parser/ParserWithCaching.ts` — HF caches
//!   parsed ASTs keyed by formula text + sheet metadata for the same
//!   reason. They evict on text change; we additionally include
//!   `NameTable::generation` so the bind result (not just the parse) stays
//!   consistent.
//! - `.references/hyperformula/src/parser/Cache.ts` — the size-bounded LRU
//!   wrapper. V0 here is unbounded; a bounded eviction policy lands when
//!   workbook size makes it necessary.

use std::collections::HashMap;
use std::sync::Arc;

use ql_types::SheetId;

use crate::plan::ExprPlan;

/// Composite cache key. Reflects everything that, if changed, would change
/// the bind result for a given formula text:
///
/// - `text` — the raw formula source (without leading `=`). Different text
///   yields a different parse tree, so plans don't share.
/// - `sheet` — owning sheet for the binding. Same text in different sheets
///   binds to different cell references (relative refs resolve against the
///   owning sheet).
/// - `name_gen` — `NameTable::generation()` at the moment of bind. A
///   subsequent name registration / removal bumps this, so old plans
///   become unreachable.
#[derive(Clone, Debug, Hash, Eq, PartialEq)]
pub struct PlanCacheKey {
    pub text: Arc<str>,
    pub sheet: SheetId,
    pub name_gen: u64,
}

/// Snapshot of cache observability data — exposed via
/// `WorkbookRuntime::cache_stats()` and surfaced through `ql-profile`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
}

impl PlanCacheStats {
    /// Hit rate as a fraction in `[0.0, 1.0]`. Returns `None` when no
    /// lookups have happened yet so callers don't divide by zero or
    /// display "0.0%" for an unused cache.
    pub fn hit_rate(&self) -> Option<f64> {
        let total = self.hits + self.misses;
        if total == 0 {
            None
        } else {
            Some(self.hits as f64 / total as f64)
        }
    }
}

/// Phase 2B.3 bind-plan cache.
///
/// Stores `Arc<ExprPlan>` per `(text, sheet, name_gen)` key. Hits return
/// the cached plan (refcount-bump only); misses run the caller-supplied
/// build closure. Accumulates hit/miss counters for observability.
///
/// `Default` constructs an empty cache. The cache is opt-in via
/// `WorkbookRuntime::with_plan_cache_disabled` — not yet implemented; the
/// default runtime constructor builds an empty cache that gets populated
/// on first lookup.
#[derive(Debug, Default)]
pub struct PlanCache {
    entries: HashMap<PlanCacheKey, Arc<ExprPlan>>,
    hits: u64,
    misses: u64,
}

impl PlanCache {
    /// Empty cache. Same as `Default::default`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up the plan for `key`. On hit, returns the cached `Arc<ExprPlan>`
    /// and increments the hit counter. On miss, runs `build()` (which does
    /// the lex/parse/bind), stores the result, and returns it. Errors from
    /// `build()` are passed through without caching — failed binds aren't
    /// memoized, so a fix to the formula text gets a clean retry.
    pub fn get_or_insert<F, E>(&mut self, key: PlanCacheKey, build: F) -> Result<Arc<ExprPlan>, E>
    where
        F: FnOnce() -> Result<ExprPlan, E>,
    {
        if let Some(plan) = self.entries.get(&key) {
            self.hits += 1;
            return Ok(Arc::clone(plan));
        }
        self.misses += 1;
        let plan = Arc::new(build()?);
        self.entries.insert(key, Arc::clone(&plan));
        Ok(plan)
    }

    /// Insert a plan unconditionally (overwriting any existing entry for
    /// the same key). Available for callers that already bound the plan
    /// out-of-band and want to pre-warm the cache.
    ///
    /// Phase 2B.7 audit (correctness L1 / D4): the prior doc-comment
    /// claimed `WorkbookRuntime::set_formula` uses this method — it
    /// doesn't (set_formula uses `get_or_insert`). No production caller
    /// uses `insert` today; the method stays for tests and future pre-
    /// warming callers (Phase 3 calcgraph integration may need it).
    pub fn insert(&mut self, key: PlanCacheKey, plan: Arc<ExprPlan>) {
        self.entries.insert(key, plan);
    }

    /// Cumulative cache observability since construction.
    pub fn stats(&self) -> PlanCacheStats {
        PlanCacheStats {
            hits: self.hits,
            misses: self.misses,
            entries: self.entries.len(),
        }
    }

    /// Number of cached plans. Some are likely stale (keyed by old
    /// generations) — V0 doesn't garbage-collect.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True iff the cache holds no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop every cached plan and reset counters. Intended for tests and
    /// explicit "clean slate" callers; routine cache pressure handling
    /// belongs in Phase 3 calcgraph integration.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.hits = 0;
        self.misses = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str, sheet: SheetId, name_gen: u64) -> PlanCacheKey {
        PlanCacheKey {
            text: Arc::from(text),
            sheet,
            name_gen,
        }
    }

    fn dummy_plan() -> ExprPlan {
        // ExprPlan::Number is the simplest concrete variant.
        ExprPlan::Number(1.0)
    }

    #[test]
    fn empty_cache_stats_have_no_hit_rate() {
        let cache = PlanCache::new();
        let stats = cache.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0);
        assert_eq!(stats.entries, 0);
        assert_eq!(stats.hit_rate(), None);
    }

    #[test]
    fn miss_then_hit() {
        let mut cache = PlanCache::new();
        let k = key("A1 + 1", 0, 0);

        // First lookup misses.
        let mut build_calls = 0;
        let first: Arc<ExprPlan> = cache
            .get_or_insert::<_, ()>(k.clone(), || {
                build_calls += 1;
                Ok(dummy_plan())
            })
            .unwrap();
        assert_eq!(cache.stats().misses, 1);
        assert_eq!(cache.stats().hits, 0);
        assert_eq!(build_calls, 1);

        // Same key → hit; build is NOT called.
        let second: Arc<ExprPlan> = cache
            .get_or_insert::<_, ()>(k, || {
                build_calls += 1;
                Ok(dummy_plan())
            })
            .unwrap();
        assert_eq!(cache.stats().hits, 1);
        assert_eq!(cache.stats().misses, 1);
        assert_eq!(build_calls, 1, "hit must not invoke build");
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn different_name_generation_misses() {
        let mut cache = PlanCache::new();
        cache
            .get_or_insert::<_, ()>(key("X", 0, 1), || Ok(dummy_plan()))
            .unwrap();
        cache
            .get_or_insert::<_, ()>(key("X", 0, 2), || Ok(dummy_plan()))
            .unwrap();
        assert_eq!(cache.stats().misses, 2);
        assert_eq!(cache.stats().hits, 0);
    }

    #[test]
    fn different_sheet_misses() {
        let mut cache = PlanCache::new();
        cache
            .get_or_insert::<_, ()>(key("X", 0, 0), || Ok(dummy_plan()))
            .unwrap();
        cache
            .get_or_insert::<_, ()>(key("X", 1, 0), || Ok(dummy_plan()))
            .unwrap();
        assert_eq!(cache.stats().misses, 2);
    }

    #[test]
    fn build_failure_does_not_cache() {
        let mut cache = PlanCache::new();
        let k = key("bad", 0, 0);
        let result: Result<Arc<ExprPlan>, &'static str> =
            cache.get_or_insert(k.clone(), || Err("bind failed"));
        assert!(result.is_err());
        assert_eq!(cache.stats().misses, 1);
        assert_eq!(cache.len(), 0, "failed build must not insert");

        // Retry succeeds and inserts.
        let mut build_calls = 0;
        let _ = cache
            .get_or_insert::<_, ()>(k, || {
                build_calls += 1;
                Ok(dummy_plan())
            })
            .unwrap();
        assert_eq!(build_calls, 1);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn insert_pre_warms_then_lookup_hits() {
        let mut cache = PlanCache::new();
        let k = key("A1", 0, 0);
        cache.insert(k.clone(), Arc::new(dummy_plan()));

        let _ = cache
            .get_or_insert::<_, ()>(k, || panic!("should not build"))
            .unwrap();
        assert_eq!(cache.stats().hits, 1);
        assert_eq!(cache.stats().misses, 0);
    }

    #[test]
    fn clear_resets_state() {
        let mut cache = PlanCache::new();
        cache
            .get_or_insert::<_, ()>(key("X", 0, 0), || Ok(dummy_plan()))
            .unwrap();
        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.stats(), PlanCacheStats::default());
    }
}
