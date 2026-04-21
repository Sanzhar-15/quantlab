# Debugger, Data Access, and Release Gaps

---

## 1) Debug File Random‑Access / Mmap Reader Missing

**Evidence**
- Debug format is implemented (`engine/quantlab/debug/format.py`, `engine/quantlab/debug/index.py`), but there is no mmap‑based reader or random‑access API.
- No `engine/quantlab/debug/mmap*.py` exists.

**Impact**
- Time‑travel debugging on large runs will be slow and memory‑heavy.

**Optimal Fix**
- Add a memory‑mapped debug reader that loads an index and supports O(1) random access.
- Expose a public API for the UI debugger to request state by bar index without full file loads.

---

## 2) Release Packaging Scripts for Python Engine Missing

**Evidence**
- Implementation plan calls for per‑OS packaging scripts (`build/python/*`), but `build/python/` does not exist.

**Impact**
- Engine cannot be packaged/bundled reliably for distribution.

**Optimal Fix**
- Add packaging scripts for Linux/macOS/Windows and integrate into CI/release pipeline.
- Ensure engine wheels/venv artifacts are produced consistently during release builds.

---

## 3) IPC Protocol Class Not Wired (Optional Cleanup)

**Evidence**
- `engine/quantlab/protocol/jsonrpc.py` defines `JsonRpcClient`/`JsonRpcServer` with abstract `connect`/`start` methods, but no concrete subclasses exist.

**Impact**
- Dead/unused protocol code increases maintenance burden and confuses the true IPC path.

**Optimal Fix**
- Either implement concrete subclasses or remove unused scaffolding in favor of the active IPCServer in `engine/quantlab/daemon/ipc.py`.
