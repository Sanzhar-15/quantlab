//! Build script for the `quantbook-py` pyo3 extension (Phase 6.3-4).
//!
//! **macOS linkage for an `extension-module` cdylib (the non-maturin recipe).**
//! With pyo3's `extension-module` feature the cdylib deliberately does NOT link
//! libpython — the Python symbols (`PyExc_*`, `PyModule_*`, …) are expected to be
//! resolved from the embedding interpreter at load time. On macOS that requires
//! the `-undefined dynamic_lookup` linker flag; without it `dlopen`/`import`
//! fails with "symbol not found in flat namespace '_PyExc_...'". maturin sets
//! this automatically, but this crate is built with a plain `cargo build` (the
//! raw-cdylib pattern, mirroring how the napi binding's `.node` is loaded by
//! path), so we emit the flag ourselves. `cargo:rustc-cdylib-link-arg` scopes it
//! to THIS crate's cdylib only — it does not affect the rlib or any other crate.
//!
//! Linux resolves the Python symbols at load time without this flag, so it is
//! macOS-only.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
    }
}
