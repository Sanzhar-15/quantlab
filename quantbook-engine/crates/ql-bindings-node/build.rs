//! Phase 5.7 V1 (2026-05-22) — napi-build setup.
//!
//! `napi_build::setup()` emits the `cargo:rustc-link-arg` directives
//! that tell rustc how to link against Node.js's symbols at runtime
//! (Node.js provides them when the .node file is `require()`d).
//! No additional logic needed — the default setup handles macOS dlopen,
//! Linux dlopen, and Windows LoadLibrary.

fn main() {
    napi_build::setup();
}
