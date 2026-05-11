//! Build script — capture the actual rustc version + verbose info into compile-time
//! environment variables for the machine-introspection report.
//!
//! Codex r11 MAJOR #6: prior `machine.rs` used `env!("CARGO_PKG_RUST_VERSION")` which returns
//! the package MSRV ("1.85"), not the actual rustc that built the binary ("1.95.0"). Phase 0
//! bench reports must carry the real rustc so the exit packet is reproducible.

use std::process::Command;

fn main() {
    // Re-run only if rustc itself changes (rare). Don't touch this script otherwise.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RUSTC");

    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());

    // `rustc -vV` returns `rustc 1.95.0 (59807616e 2026-04-14)` + host/release lines.
    let output = Command::new(&rustc)
        .arg("-vV")
        .output()
        .expect("failed to run `rustc -vV`; ensure rustc is on PATH at build time");

    if !output.status.success() {
        panic!(
            "`rustc -vV` exited {:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let verbose = String::from_utf8_lossy(&output.stdout);
    // First line: `rustc 1.95.0 (59807616e 2026-04-14)`. Capture the whole verbose output too.
    let first_line = verbose.lines().next().unwrap_or("").trim().to_string();

    // Strip "rustc " prefix → "1.95.0 (59807616e 2026-04-14)".
    let version = first_line
        .strip_prefix("rustc ")
        .unwrap_or(&first_line)
        .to_string();

    println!("cargo:rustc-env=QL_RUSTC_VERSION={version}");
    println!(
        "cargo:rustc-env=QL_RUSTC_VERBOSE={}",
        verbose.replace('\n', " | ")
    );
}
