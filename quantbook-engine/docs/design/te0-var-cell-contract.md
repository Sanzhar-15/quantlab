# TE0 — The var↔cell Contract: Design for the Python-Fusion Moat

**Status:** DESIGN (read-only). No code changed. Blocks TE1/TE2/TE3.
**Author window:** TE0
**Engine HEAD audited:** `628a354daed4` on `feat/quantbook-engine` (note: the prompt cited `0a985d69426`; the live worktree has advanced past it — design is grounded in the live HEAD).
**Save as:** `docs/design/te0-var-cell-contract.md`

> Crate-layout correction (verify before implementing): the prompt said `quantbook-py` and `crates/ql-bindings-node`. In the live worktree the Python crate is at **`crates/quantbook-py`** and the owning session lives in **`crates/ql-exec/src/session.rs`** (the `WorkbookSession` impl; the trait is in `crates/ql-session/src/session.rs`). The napi surface is `crates/ql-bindings-node/src/lib.rs`; DTOs are `crates/ql-session/src/dto.rs`.

---

## 0. Executive summary

The moat is the reactive fusion of a Python variable and a grid range. The discovery lanes (WIR-01, W5, W6) are correct: today the moat is **one-way and the two engine primitives that should define identity are disconnected.**

What I verified in code:

1. **The forward plane already works end-to-end — but it does not use `bind_range` at all.** The live path is: notebook cell runs in a real ipykernel → kernel-side `Quantbook._reg` registry + `post_run_cell` hook detect a changed published var → emit a `republish` frame over fd3 → `ReactiveKernelClient.applyRepublish` calls `session.publishDataset(...)` + `recalcDirty()` → `CellGridPanel` repaints. The var→range identity lives in **three** places, none of them the engine's `bindings` map: the kernel's `_reg` dict (`reactive_kernel_child.py`), the host's `PublishedCellsStore` (`publishedCellsStore.ts`), and the engine's `provenance` index keyed by `name`.

2. **`bind_range` is dead.** `WorkbookSession::bind_range` (session.rs:3828) inserts into `self.bindings: HashMap<String, CellRange>` and that map is read **only** by `WorkbookSession::binding()` (session.rs:4206), which is **not exposed over napi or pyo3** and has **zero non-test callers** anywhere in the IDE. The `eng_fusion_smoke.py` test is its only live exercise.

3. **`BoundFrame` and `qb.show` do not exist.** `__init__.py` explicitly says the `qb.show`/`publish`/`bind` PyO3 surface is "a SEPARATE, later concern." `_frame.py` is the UDF wire codec, not a frame DTO. The kernel-side `qb` object (`reactive_kernel_child.Quantbook`) has `publish`/`unpublish`/`on_epoch_change`/`on_post_run_cell` — **no `show`, no `bind`.**

4. **There is no reverse plane.** No code path takes a grid edit and pushes it back to the kernel. The host→kernel stdin protocol carries only `{execute, epoch_change, unpublish, close}`.

The design below makes one **central decision** that everything else follows from:

> **DECISION D-IDENTITY: The binding is the identity. `publish` is one operation that establishes-or-reuses a binding and pushes data through it.** We collapse the three shadow registries onto **one engine-owned binding record** that ties `var_name ↔ binding_id ↔ produced range ↔ provenance source_id ↔ live-direction`. `bind_range` stops being a dead parallel primitive and becomes the *declaration* half of `publish`; `publish_dataset` becomes the *data* half. This is the smallest change that makes the moat coherent AND unlocks the reverse plane (a binding is exactly the thing a grid edit looks up to find "which var owns this cell, and is it writable-back?").

I flag explicitly where I could **not** determine intent from code (§9) so Codex/the operator can probe.

---

## 1. Data model & identity

### 1.1 The problem with today's identity

There are three keys for "the same thing," and they can drift:

| Layer | Key | Holds | Lifetime | File |
|---|---|---|---|---|
| Kernel | `name` (str) | `target` (A1 str), `fp` (fingerprint), `cells` (envelope), `owner_cell_id`, `force_check`, `stale` | kernel process | `reactive_kernel_child.py:307` |
| Host | `name` (str) | resolved `CellRangeJson` (latest-wins) | `ReactiveKernelClient` (per session) | `publishedCellsStore.ts:49` |
| Engine | `name` (str) → `ProvenanceEntry` | `kind`, `revision`, `data` (`{"values":...}`), `target`, `cells: Vec<CellAddr>` | cleared on undo/redo | `session.rs:223,429` |
| Engine | `binding_id` (str) → `CellRange` | the range only | **kept** across undo/redo, **dead** | `session.rs:443` |

The engine `provenance` (keyed by publish `name`) and the engine `bindings` (keyed by `binding_id`) are two unrelated maps. Nothing guarantees `binding_id == name`, and nothing guarantees the binding's range tracks the range the provenance actually produced.

### 1.2 The unified binding record (engine-owned, the source of truth)

We introduce **one** engine structure that subsumes `bindings` and is cross-linked to `provenance`:

```
// crates/ql-exec/src/session.rs (new)
struct Binding {
    binding_id: String,        // == the publish `name` for a published var (see D-IDENTITY)
    target: CellRange,         // the DECLARED envelope (fixed-size, range-follows-cells is v1-cut)
    direction: BindDirection,  // Forward (Python→grid, default) | Bidirectional (edit-back enabled)
    source_id: Option<String>, // the provenance key this binding's data flows through (== binding_id today)
    generation: u64,           // bumped on every (re)bind; carried in reverse-plane frames for staleness
    alive: bool,               // false once the range is invalidated by a structural edit (see §1.4)
}

enum BindDirection { Forward, Bidirectional }
```

`self.bindings: HashMap<String, CellRange>` becomes `self.bindings: HashMap<String, Binding>`.

**Identity chain (the invariant TE1 must enforce):**

```
Python var name  ==  binding_id  ==  provenance source_id   (for a published var)
                          │
                          ├── Binding.target          (declared envelope)
                          └── provenance[source_id].cells   (cells actually written this publish)
```

`Binding.target` is the *declared* envelope (what the user selected / the kernel computed). `provenance[id].cells` is what was *actually* written last publish (≤ target if the value is smaller; the kernel already blank-fills to the envelope, so today they coincide, but the invariant must not assume it).

### 1.3 Ownership & lifetime

- **A binding is owned by the session** (single-writer; `WorkbookSession` is the sole engine writer — see the R8 single-writer note in `reactive_kernel_child.py:37`). The kernel only *signals*; it never writes the engine.
- **A binding is created/refreshed by `publish`** (the merged op, §2). Re-publishing the same `name` reuses the binding (bumps `generation` only if the target moved — which is a v1-cut error today, see G1 in the kernel).
- **A binding is destroyed by `unpublish(name)`** (already a kernel reverse message; TE1 extends it to drop the engine binding too) or when its var goes `stale` (`del x` → kernel emits `stale`; today only the host badge drops — TE1 must also drop/deactivate the engine binding).
- **Across undo/redo:** today `provenance` is **cleared** (`rematerialize` → `provenance.clear()` at session.rs:1090) but `bindings` is **kept** (by design comment at session.rs:437). This is a latent inconsistency: after an undo, a binding points at a range whose provenance no longer exists. Under the unified model this becomes a real decision (see DEC-B below). The existing R7 `epoch_change`/`force_check` mechanism (kernel marks every binding for forced re-publish on the next touch) is the intended reconciliation lever and the design leans on it.

### 1.4 Range mutation: move / resize / delete / sheet-delete

This is the **single biggest correctness hole** in the current code and the prompt's most important sub-question. Today:

- `Binding.target` (the `bindings` map) is **never adjusted** when rows/cols are inserted/deleted or a sheet is deleted. `binding()` would return a stale or out-of-bounds range.
- `provenance[name].cells` (the absolute `CellAddr`s) are **also never shifted** on structural edits — but they ARE cleared on undo/redo and re-recorded on the next publish.

**DECISION D-RANGEMOVE (v1):** Bindings are **anchored, not tracked**, in v1 — with loud invalidation, never silent drift.

- On **row/col insert/delete** that intersects or precedes a binding's `target`: mark `Binding.alive = false` and surface a diagnostic ("binding `x` invalidated by a structural edit; re-run the owning cell to re-bind"). Do **not** silently shift, because the Python value's shape no longer matches what the user sees, and a silently-shifted envelope can overlap another binding. The kernel's `force_check` + re-run re-establishes a fresh binding at the new selection.
- On **sheet delete**: every binding whose `target.sheet` is the deleted sheet is marked `alive = false`. (The host already handles the "now-deleted sheet" case for badges via `allRangesWithSheet()` → `#REF!`; the engine binding mirrors that.)
- A **read of a dead binding** (`binding()`/reverse-plane lookup) returns the binding with `alive=false` rather than `None`, so the caller can distinguish "never bound" from "bound-then-invalidated" and message accordingly (No-Fallbacks: never report a dead binding as a live one).

> Range-*tracking* (auto-shifting the envelope on insert/delete so the binding follows its cells) is explicitly a **v1.5** item. It mirrors the kernel's own documented "range-follows-cells is a v1 cut" (`reactive_kernel_child.py:196`). Flagging here so the operator can decide whether anchored-with-invalidation is acceptable for v1 (I believe it is — it's loud and recoverable).

---

## 2. The forward plane (var → cells)

### 2.1 What exists and stays

The forward data flow (`publishDataset` → `recalcDirty` → delta → repaint) is **proven and fast** (the `latency_reactive_pyo3.py` harness asserts dependent formula cells recompute every publish; this is the FE-1.5 kill-gate that already passed). **Do not rebuild it.** `publish_dataset` already:
- writes one `BatchCommit` (one version bump, undoable),
- dirties dependents via `graph.on_set_value` (so recalc sees the bound range as an input to downstream formulas — this is the "recalc sees a bound range as a dependency" requirement, already satisfied: a formula `=B1*2` over a published `B1` recomputes),
- records dual-index provenance keyed by `name`,
- handles the reactive shrink case (dirties vacated cells' dependents).

### 2.2 The linkage TE1 adds (publish ↔ bind)

Today `publish_dataset` records `provenance[name]` but creates **no binding**. TE1 wires them:

**`publish_dataset(name, data, target)` additionally upserts `bindings[name]`:**
```
1. (existing) validate target, convert JSON matrix, capture old_cells.
2. (existing) write_range(block, values); record_block_provenance(name, ..., Published).
3. (NEW) bindings.entry(name).or_insert_or_update(Binding {
       binding_id: name, target, direction: <preserve existing or Forward>,
       source_id: Some(name), generation: bump_if_target_moved, alive: true,
   });
4. (existing) dirty old_cells' dependents.
```

This makes `bind_range` the *explicit declaration* form (used when you want a Bidirectional binding *before* any data exists, e.g. `qb.show` reads first — see §4), and `publish` the *implicit* form (a `qb.publish` both declares and fills). They write the **same** `bindings` map.

**The lineage invariant (the prompt's #2):** after a publish, for every produced cell `c`:
```
cell_provenance[c].source_id == name             (already true — record_block_provenance)
provenance[name].cells contains c                (already true)
bindings[name].source_id == Some(name)           (NEW — TE1)
bindings[name].target ⊇ provenance[name].cells   (NEW invariant — declared envelope covers produced block)
```
`cell_lineage(c)` already walks `cell_provenance → provenance` and returns the produced block + `kind=Published`. TE1 adds the binding pointer so the IDE can answer "this cell is driven by Python var `name`, direction `Forward`" — which is what the W-G badge wants, sourced from the engine instead of the host-side `PublishedCellsStore`.

> **Migration note (important for TE1):** the host-side `PublishedCellsStore` and the kernel `_reg` do not have to be deleted day one. TE1 should make the engine binding the *authoritative* source and have `PublishedCellsStore` become a *cache/mirror* fed by the new napi `binding()`/`bindings()` reader, so the badge and the engine never disagree. Deleting the shadow stores is a later cleanup, not a TE1 blocker. (No-Fallbacks caution: while both exist, one must be derived from the other — never two independent writers, or they drift exactly the way today's three keys can.)

---

## 3. The reverse plane (edit-back, grid → kernel) — DoD-8

This is greenfield. It is the hardest and riskiest part. **Design it conservatively and make every seam fail loud.**

### 3.1 Semantics: what does editing a bound cell mean?

A user edits cell `C` that falls inside `bindings[name].target` where `direction == Bidirectional`.

**DECISION D-EDITBACK: edit-back writes the Python object element, then lets the normal forward republish re-assert the grid.** Concretely:

1. The grid edit goes through the **normal** W1 path first: `setValue(C, v)` → `recalcDirty` → repaint. The cell shows the user's value immediately (sub-frame; no kernel round-trip on the critical path for the *visual*). This keeps the grid responsive even if the kernel is slow/dead.
2. **In parallel**, the host emits a new host→kernel control frame `{type:"poke", name, row, col, value}` (relative coords within the binding envelope). The kernel mutates the Python object in place (`var[row][col] = value`, or `df.iat[r,c] = value`, or `ndarray[r,c] = value`), updates `_reg[name].fp`, and runs any reactive dependents in the notebook (the `post_run_cell` machinery — a poke is modeled as an implicit micro-cell).
3. Mutating the Python object **may** trigger a `republish` of *other* bindings (a derived var changes), which flows back through the existing forward plane. The poked cell itself does **not** need to be re-published (the grid already shows `v`); but the kernel re-publishes the whole envelope so the engine's value and the Python object stay byte-identical (defends against type coercion drift, e.g. user typed `"3"` but the column is numeric).

This gives **the grid as a first-class input device to the Python kernel** — the actual moat differentiator — while keeping the <100ms budget realistic (the *visual* is local; the *kernel sync* is async and can be measured separately).

### 3.2 Conflict / authority rules (No-Fallbacks)

- **Authority:** the **Python object is the authority for a Bidirectional binding's shape; the grid is the authority for a cell's scalar value** between republishes. On a `poke`, the kernel must accept the scalar and write it; if it cannot (e.g. the var is a read-only computed expression, not a settable container), it emits an `error` frame and the host **reverts** the grid edit and surfaces it loudly. Never silently drop the user's edit.
- **Formula cells:** the existing **G3 rule already covers the forward direction** (`applyRepublish` refuses to overwrite a cell that holds a user *formula*). For the reverse direction, a user *typing a formula* into a bound cell must **break the binding for that cell** (the cell is now user-owned, like `drop_cell_lineage` does for direct writes). The binding's other cells stay live. This is symmetric with the existing `drop_cell_lineage` behavior (session.rs:4294) and must be wired identically.
- **Type safety:** a `poke` value whose JSON type does not match the column's published dtype (e.g. poking a string into a `numpy` float column) is a **loud kernel error**, not a coercion. The kernel already raises on `object`-dtype fingerprints; reuse that discipline.
- **Stale generation:** a `poke` carries the binding's `generation`. If the kernel's `_reg[name]` generation ≠ the poke's, the binding was rebound out from under the edit → reject loud, revert grid edit.
- **Dead kernel:** if no kernel is attached, a Bidirectional binding behaves as Forward-only for editing — but the binding's `direction` must still be `Bidirectional` so the badge can show "editable when kernel runs" vs a plain Forward badge. (Decision DEC-C: do we *allow* editing a Bidirectional cell with no kernel? I recommend **yes, with a warning** — the edit lands in the grid, and the next kernel start re-publishes from Python, overwriting it. This must be messaged so the user isn't surprised when their edit vanishes on kernel restart. Flagged for operator.)

### 3.3 Transport additions

The host→kernel stdin protocol gains `poke`; the kernel→host fd3 protocol is unchanged (a poke's side effects come back as ordinary `republish` frames). This is a **small, additive** protocol change — it does not disturb the proven forward NDJSON contract.

```
host → kernel (stdin):  {"type":"poke","name":<str>,"row":<int>,"col":<int>,"value":<scalar>,"generation":<int>}
kernel → host (fd3):    (existing) republish / stale / error / a new terminal {"type":"poked"}
```

The `ReactiveKernelClient` gains an `editBack(name, row, col, value)` method that `sendOp('poked', {...})`, mirroring `unpublish`'s shape exactly. **One op in flight at a time** is already enforced (`sendOp` rejects concurrent ops) — edit-back must queue behind any in-flight execute, which is correct (a poke during a running cell would race the var).

### 3.4 The <100ms proof (DoD-8)

Model it on the **existing** `latency_reactive_pyo3.py` harness, but measure the reverse direction:

```
t0: user edit (setValue local)            → t1: grid repaint   [VISUAL latency — must be <16ms, local]
t1: emit poke                              → t2: kernel mutates + republishes dependents
t2: apply republish + recalc + delta       → t3: dependents repaint   [REACTIVE latency — DoD-8 <100ms]
```

DoD-8's "<100ms round-trip" is the `t0→t3` *reactive* path (edit a bound cell → a *dependent* Python-derived cell updates). The visual `t0→t1` is separately and trivially under budget because it's local. TE2 ships a `latency_reactive_editback_pyo3.py` that asserts both. This separation is important — it lets us *ship* the responsive visual even if the kernel round-trip occasionally exceeds 100ms under load, and measure the two honestly.

---

## 4. `BoundFrame` + `qb.show` — the Python API surface

### 4.1 `qb.show(value, *, name=None, at=None, editable=False) -> BoundFrame`

`qb.show` is the **ergonomic, auto-placing** sibling of `qb.publish`. Where `qb.publish(name, value, target)` makes the author specify everything, `qb.show(df)`:
- infers a `name` (from the assignment target if available, else a generated `_show_1`),
- infers a `target` (auto-allocates a free rectangle on the active sheet sized to `value`'s shape — the kernel computes the envelope; the host resolves placement, since only the host knows the live grid extent),
- registers a **Bidirectional** binding if `editable=True` (default `Forward`),
- returns a **`BoundFrame`** handle.

Because auto-placement needs the live grid (which the kernel does not own — single-writer is host-side), `qb.show` is a **two-step** op: the kernel emits a `republish` with `target=None` (meaning "host, allocate"), the host allocates and calls `bind_range`+`publishDataset`, then the host returns the resolved range to the kernel via a new `{type:"placed", name, target}` reverse frame so the kernel can record it in `_reg`. This is the one genuinely new round-trip `qb.show` needs that `qb.publish` does not. (Alternative DEC-D: require `qb.show(df, at="Sheet!A1")` in v1 and defer auto-allocation to v1.5 — simpler, no new placement round-trip. I lean toward deferring auto-allocation; flagged for operator.)

### 4.2 `class BoundFrame` — staying live/reactive

`BoundFrame` is a thin Python proxy around the bound value. It is **not** a data copy — it holds `(name, _reg ref)` and forwards reads/writes:

```python
class BoundFrame:
    def __init__(self, qb, name): self._qb, self._name = qb, name
    @property
    def value(self):            # current Python object (from user_ns)
        return self._qb._shell.user_ns[self._reg_owner_var]
    def __setitem__(self, key, v):   # bf[r,c] = v  → mutate underlying + republish
        ...mutate the real object..., self._qb._touch(self._name)
    def unbind(self): self._qb.unpublish(self._name)
```

**Liveness is automatic and already built:** `BoundFrame` does not need its own reactivity engine — the existing `post_run_cell` hook + fingerprint diff (`reactive_kernel_child.py:342`) already detects when the underlying var changes in *any* later cell and re-publishes. `BoundFrame` just needs the underlying object to be the *same* object the user's var references (so mutations are observed). For a DataFrame, `qb.show(df)` binds to `df` itself, not a copy; the hook re-fingerprints `df` after each cell.

**The reverse direction:** an edit-back `poke` (§3) mutates the same underlying object, so `BoundFrame.value` and the grid stay in sync without any extra `BoundFrame` machinery — the existing fingerprint/republish loop closes the cycle.

> This is the elegant payoff of D-IDENTITY + reusing the existing hook: `BoundFrame` is ~30 lines of proxy, not a new reactive runtime. The reactivity it needs already exists in `Quantbook.on_post_run_cell`.

---

## 5. napi / pyo3 surface needed

The engine already has the reader (`binding()`); it just isn't exposed, and we need a few additions. All DTOs in `crates/ql-session/src/dto.rs`, napi in `ql-bindings-node/src/lib.rs`, pyo3 in `crates/quantbook-py/src/lib.rs`.

### 5.1 New DTO

```rust
// dto.rs
pub struct BindingInfo {
    pub binding_id: String,
    pub target: CellRange,
    pub direction: BindDirection,    // serde "forward" | "bidirectional"
    pub source_id: Option<String>,
    pub generation: u64,
    pub alive: bool,
}
pub enum BindDirection { Forward, Bidirectional }   // #[serde(rename_all="snake_case")]
```

### 5.2 New engine methods (session.rs / trait in ql-session/session.rs)

| Method | Signature | Notes |
|---|---|---|
| `binding` (extend existing) | `fn binding(&self, id) -> Option<BindingInfo>` | promote the `Option<CellRange>` reader to return the full record |
| `bindings` (new) | `fn bindings(&self) -> Vec<BindingInfo>` | enumerate all — replaces host `PublishedCellsStore` as truth |
| `bind_range` (extend) | add `direction` param | `Forward` default keeps existing tests green |
| `unbind` (new) | `fn unbind(&mut self, id) -> EngineResult<bool>` | drops the binding (the engine half of kernel `unpublish`) |
| `invalidate_bindings_for_sheet` / structural hooks | internal | wire into row/col insert-delete + delete_sheet to set `alive=false` (§1.4) |

### 5.3 New napi methods (`#[napi]`)

| napi `js_name` | Maps to | Used by |
|---|---|---|
| `binding(bindingId) -> BindingInfoJson \| null` | `binding()` | IDE badge/lineage, reverse-plane lookup on cell edit |
| `bindings() -> BindingInfoJson[]` | `bindings()` | IDE sidebar / badge source-of-truth |
| `bindRange(bindingId, target, direction)` | extend existing `bind_range` | `qb.show(editable=True)` path |
| `unbind(bindingId) -> boolean` | `unbind()` | kernel `unpublish` reverse frame; binding teardown |

(`publishDataset`/`cellLineage` already exist and are correct; `cellLineage` should additionally surface `binding_id`/`direction` once the binding link is in — extend `CellLineageJson`.)

### 5.4 New pyo3 methods (`#[pymethods] impl Session`)

Mirror the napi additions: `binding`, `bindings`, `bind_range(direction=...)`, `unbind`. These are what a *future in-process* `qb` would call; the **shipped reactive kernel does not call pyo3 directly** (it's out-of-process and talks fd3), so the pyo3 additions are for the latency harnesses and any in-process embedding — lower priority than napi.

### 5.5 IDE TS surface

- `types.ts`: add `BindingInfoJson`, extend `SessionInstance` with `binding`/`bindings`/`unbind`/`bindRange(direction)`.
- `ReactiveKernelClient`: add `editBack()` + handle the `poke`/`placed` frames; switch `PublishedCellsStore` to *mirror* `session.bindings()` rather than be the primary.
- `CellGridPanel`: on a cell edit, look up `session.binding()` for the edited cell; if `Bidirectional` and a kernel is attached, call `editBack`.

---

## 6. Invariants & failure modes (No-Fallbacks per seam)

| Seam | Failure | Behavior (must be LOUD) |
|---|---|---|
| publish with no binding yet | n/a | publish creates the binding; never silent |
| re-publish moves target | range-follows-cells v1 cut | **loud `bad_argument`** (kernel G1 already does this; engine binding must agree) |
| publish envelope overlaps another binding | collision | **loud** (kernel G2 already; engine `bind_range` should reject overlap too, or document that overlap-rejection stays kernel-side — DEC-E, see §9) |
| structural edit invalidates a binding | row/col/sheet delete | `alive=false` + diagnostic; reads return dead binding, never a stale live one |
| edit-back, var is not settable | `poke` on a computed expr | kernel `error` frame → host **reverts grid edit** + surfaces |
| edit-back, type mismatch | string into numeric column | kernel **raises**, no coercion |
| edit-back, stale generation | rebound mid-edit | reject + revert |
| edit-back, no kernel | Bidirectional cell, kernel dead | DEC-C: allow with warning, or refuse (operator decides) |
| `cell_lineage` cell owned by source with no provenance | structural inconsistency | already `Internal` error `lineage_inconsistent` (session.rs:4327) — keep |
| undo/redo clears provenance but keeps binding | the latent inconsistency | DEC-B: on undo, mark affected bindings `force_check` via the existing epoch mechanism so the next kernel touch re-publishes; never leave a binding pointing at vanished provenance silently |
| napi `binding()` on a dead/missing id | n/a | return `null` for missing, `{alive:false}` for dead — caller distinguishes |
| kernel `_reg` ↔ engine `bindings` drift | two writers | **forbidden**: engine binding is truth; `_reg` is kernel's local mirror; `PublishedCellsStore` derives from `session.bindings()`. Any divergence is a bug, not a fallback. |

**The cardinal rule (from the global No-Fallbacks instruction):** an edit-back that cannot be honored must **revert and surface**, never swallow. A binding that cannot be tracked across a structural edit must **invalidate loudly**, never silently shift. The existing forward-plane code is already No-Fallbacks-clean (loader rethrows, `recalcChecked` throws, G3 surfaces+rolls back) — the reverse plane must hold the same bar.

---

## 7. Phased implementation plan

### TE1 — Forward-plane coherence (publish ↔ bind ↔ recalc ↔ lineage). **No new behavior; close the seam.**

**Scope (engine-mostly, parallel-safe once this design lands):**
1. Replace `bindings: HashMap<String, CellRange>` with `HashMap<String, Binding>` (struct in §1.2); keep `bind_range` back-compat (`Forward`, default).
2. `publish_dataset` upserts the binding (§2.2); enforce the lineage invariant (`bindings[name].source_id == name`, target ⊇ produced cells).
3. Promote `binding()` to return `BindingInfo`; add `bindings()`, `unbind()`.
4. **napi:** expose `binding`, `bindings`, `unbind`; extend `bindRange` with `direction`; extend `CellLineageJson` with `binding_id`/`direction`.
5. Structural-edit invalidation (§1.4): hook row/col insert-delete + `delete_sheet` to set `alive=false`; tests for each.
6. Undo/redo reconciliation (DEC-B): decide keep-binding-but-force_check vs drop; wire the chosen path; test the post-undo state explicitly.
7. **IDE:** make `PublishedCellsStore` mirror `session.bindings()` (badge source-of-truth moves to engine); no UX change.

**Riskiest unknown for the operator:** the undo/redo reconciliation (DEC-B) and structural-edit invalidation interact with the *already-shipping* forward moat and the W-G badge. Getting this wrong regresses a passed kill-gate. **This phase must re-run the FE-1.5 reactive acid test + the latency harness as its gate.**

**Gate:** `cargo test -p ql-exec --lib` (publish/bind/lineage suites all green + new binding tests); the existing reactive host-test (un-skipped, with ipykernel) still passes; napi compiles + `quantbook*` mocha green.

### TE2 — `BoundFrame` + `qb.show` + edit-back + <100ms proof. **The new behavior; the moat's reverse half.**

**Scope (kernel + host + Python, design pole — NOT parallel with TE1's binding-struct change):**
1. Kernel: add `qb.show` + `class BoundFrame` (§4); add `poke` handler (mutate underlying object, update `_reg` fp, re-publish dependents) + `{type:"poked"}` terminal; (if auto-allocate chosen) the `placed` round-trip.
2. Host: `ReactiveKernelClient.editBack()`; `CellGridPanel` cell-edit → `binding()` lookup → `editBack` when `Bidirectional`; revert-on-error.
3. pyo3: `binding`/`bindings`/`unbind`/`bindRange(direction)` (for harnesses).
4. **`latency_reactive_editback_pyo3.py`**: assert `t0→t3` reactive edit-back < 100ms (DoD-8) and `t0→t1` visual < 16ms.

**Riskiest unknowns:** (a) DataFrame/ndarray in-place element write semantics across pandas/numpy versions (does `df.iat[r,c]=v` preserve dtype? what about a multi-index?); (b) the auto-placement round-trip (DEC-D) — defer it if it threatens the timeline; (c) whether the <100ms budget holds for a 1000-cell envelope edit-back under a real ipykernel (the forward 1000-cell publish is already measured; the reverse adds a stdin→kernel→fd3 hop). **Measure (b)/(c) early — they decide scope.**

**Gate:** the new edit-back latency harness passes the budget; round-trip acid test (edit a bound cell, a dependent Python-derived cell updates) green under a live ipykernel.

### TE3 — UDF-worker last-mile interplay.

**Context (from W7/W8):** the UDF worker (`ql-udf` ProcessWorker + napi `registerFunction`/`setUdfWorker`) is engine-complete but IDE-disconnected; `=BACKTEST` rides on it. The relationship to var↔cell: a **UDF is the *function* plane; a binding is the *data* plane.** They are mostly orthogonal but touch in two places:
1. A `=BACKTEST(...)` formula may reference a **bound range** as an argument — so the binding's produced cells must be ordinary cells the dep-graph tracks (they already are — `publish_dataset` writes real values, and recalc dirties dependents). **No special-casing needed; verify with a test.**
2. The UDF worker and the reactive kernel are **two separate Python processes** today (`ql-udf` ProcessWorker vs the reactive supervisor's ipykernel). TE3 decides whether they should share one interpreter/namespace (so a UDF can see a `BoundFrame`) or stay isolated. **Recommendation: keep them isolated for v1** (the isolation hardening in WIR-03 is a v1 risk; merging them widens the blast radius). A UDF reads cell *values* via the engine, not Python objects — so it does not need the kernel namespace.

**Scope:** wire the IDE call sites for `setUdfWorker`/`registerFunction` (gated user action, async so it doesn't block ext-host — W7 flagged the sync-blocking issue), add `=BACKTEST`, and add a test proving a UDF can consume a bound range's cells.

**Riskiest unknown:** the `setUdfWorker` sync-blocking ext-host issue (W7) and UDF process isolation (WIR-03) are pre-existing engine-debt items that TE3 inherits; they are arguably separable from the var↔cell contract and could be sequenced independently. **Flag to operator: TE3 may be better split** into "UDF IDE wiring" (independent) and "UDF×binding interplay test" (the only part that truly depends on TE0/TE1).

---

## 8. Open questions / decisions for the operator or a follow-up

- **DEC-B (undo/redo × bindings):** today provenance clears but bindings persist. Choose: (i) keep binding + mark `force_check` so the next kernel touch re-publishes (my lean — preserves the badge, self-heals), or (ii) drop bindings on undo (simpler, but the badge flickers and the user must re-run). **Needs a decision before TE1.**
- **DEC-C (edit-back with no live kernel):** allow the grid edit (overwritten on next kernel start, with a warning) or refuse it? My lean: allow + warn.
- **DEC-D (`qb.show` auto-placement):** build the host-allocates round-trip in v1, or require explicit `at="Sheet!A1"` and defer auto-placement to v1.5? My lean: defer auto-placement (smaller TE2).
- **DEC-E (overlap rejection home):** the kernel already rejects overlapping publish envelopes (G2). Should the **engine** `bind_range`/`publish_dataset` also reject overlap, or do we trust the kernel? My lean: engine should reject too (defense in depth; an MCP tool or a future second kernel could bypass the kernel-side guard). Needs confirming that no legitimate flow publishes overlapping ranges.
- **DEC-F (TE3 split):** split UDF IDE wiring (independent) from UDF×binding interplay (TE0-dependent)?
- **Binding persistence:** are bindings saved to `.qbook`? Today they are session-local (and provenance is too). For v1, a reopened workbook would show published *values* (they're real cells) but lose the *live* binding until the kernel re-runs. I believe **session-local is correct for v1** (a binding without a live kernel is meaningless), but the operator should confirm — it mirrors the freeze/split/SQL-query persistence gap (lane-2 W12/risk-3).

### What I could NOT determine from code (probe these)

1. **Whether `bind_range` was ever *intended* to be the data-plane declaration or purely a read-overlay marker.** Its doc comment (session.rs:3820) says "round-trip reads of the bound range use the existing `query_range`/snapshot path; this call only records the region." That suggests `bind_range` was envisioned as a **read window** (BoundFrame-as-view), *not* the publish identity. My D-IDENTITY decision *repurposes* it as the unified binding. **A reviewer should confirm this repurpose doesn't violate an intended `bind_range`-as-read-view design** that I can't see in the code. If the operator wants `bind_range` to stay a pure read-overlay, the unified `Binding` should instead be a *new* third structure, and `bind_range`/`publish` both write it — functionally identical, just naming.
2. **The exact pandas/numpy in-place element-set semantics** the kernel should use for edit-back — not determinable without running; TE2 must spike it.
3. **Whether `=BACKTEST` consumes a bound range or a published *name*** — no `=BACKTEST` code exists, so its argument contract is unspecified. Needs a product decision in TE3.
4. **The real-world <100ms edit-back budget under a live ipykernel** — the forward path is measured; the reverse adds a host→kernel→host hop that no harness exercises yet. TE2 must measure it before committing to DoD-8.
5. **Whether the kernel `_reg`, host `PublishedCellsStore`, and engine `provenance`/`bindings` can be collapsed to one *without* breaking the MCP `get_published_variables` tool** (which reads `allRangesWithSheet()`). The MCP tool is a fourth reader — TE1's "engine is truth" migration must keep it fed.

---

## 9. One-paragraph orientation for TE1/TE2/TE3

The forward moat is real and fast; do not rebuild it. The fix is to give the var↔cell relationship **one engine-owned identity** (the `Binding` record) that `publish_dataset` and `bind_range` both write and `binding()`/`bindings()`/`cell_lineage()` all read, then add a **reverse `poke` plane** that lets a grid edit mutate the Python object through that same binding. TE1 closes the forward seam (pure wiring + a binding struct + napi readers + structural-edit invalidation); TE2 builds the genuinely-new reverse half (`qb.show`/`BoundFrame`/edit-back/<100ms proof) on top of the existing `post_run_cell` reactivity; TE3 wires the orthogonal UDF plane and proves a UDF can consume bound cells. The riskiest things are not the happy path — they are undo/redo reconciliation (DEC-B), structural-edit invalidation (§1.4), and the unmeasured reverse-plane latency (§3.4). Every seam fails loud: a binding that can't track invalidates, an edit-back that can't apply reverts and surfaces, and the engine binding is the single source of truth that the kernel `_reg` and host `PublishedCellsStore` mirror — never a fourth independent writer.
