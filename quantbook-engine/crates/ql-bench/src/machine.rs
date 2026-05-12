//! Machine introspection for bench reports — captured at bench-start time, embedded in the
//! Phase 0 exit packet so a future reviewer can answer "what did this number mean?" without
//! talking to the runner.
//!
//! Phase 0 spec OG-06 requires `graph-profile.json` to be human-readable and let a senior
//! engineer attribute time-spent within 10 min. The same constraint motivates this module:
//! bench numbers without machine context are noise.

use std::env;
use std::fmt::Write as _;

/// Machine context captured for a Phase 0 bench run.
#[derive(Debug, Clone)]
pub struct MachineReport {
    pub os: &'static str,
    pub arch: &'static str,
    pub cpu_brand: Option<String>,
    pub logical_cores: usize,
    pub physical_cores: Option<usize>,
    pub ram_total_bytes: Option<u64>,
    /// Actual rustc that built this binary — captured by `build.rs` from `rustc -vV`.
    /// Example: `"1.95.0 (59807616e 2026-04-14)"`. Codex r11 MAJOR #6.
    pub rustc_version: &'static str,
    /// Declared MSRV floor from `[workspace.package].rust-version`. Different from the
    /// build-time rustc. Example: `"1.85"`.
    pub msrv_floor: &'static str,
    /// Full `rustc -vV` output with newlines replaced by ` | ` (host triple, release date, LLVM, etc.).
    pub rustc_verbose: &'static str,
    pub build_profile: &'static str,
    pub rustflags_env: Option<String>,
    pub cargo_build_rustflags_env: Option<String>,
    pub cargo_encoded_rustflags_env: Option<String>,
    pub chunk_rows: usize,
    pub rayon_num_threads: Option<String>,
    pub simd: SimdDispatch,
}

/// Runtime SIMD detection — what would the running binary actually dispatch to?
#[derive(Debug, Clone, Copy, Default)]
pub struct SimdDispatch {
    pub x86_sse4_2: bool,
    pub x86_avx2: bool,
    pub aarch64_neon: bool,
}

impl SimdDispatch {
    pub fn detect() -> Self {
        let mut out = Self::default();
        #[cfg(target_arch = "x86_64")]
        {
            out.x86_sse4_2 = std::is_x86_feature_detected!("sse4.2");
            out.x86_avx2 = std::is_x86_feature_detected!("avx2");
        }
        #[cfg(target_arch = "aarch64")]
        {
            // std::arch::is_aarch64_feature_detected requires nightly on some targets;
            // neon is mandatory in aarch64 baseline, so report true.
            out.aarch64_neon = true;
        }
        out
    }
}

impl MachineReport {
    pub fn collect() -> Self {
        Self {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            cpu_brand: detect_cpu_brand(),
            logical_cores: num_cpus::get(),
            physical_cores: Some(num_cpus::get_physical()),
            ram_total_bytes: detect_ram_total(),
            rustc_version: env!("QL_RUSTC_VERSION"),
            msrv_floor: env!("CARGO_PKG_RUST_VERSION"),
            rustc_verbose: env!("QL_RUSTC_VERBOSE"),
            build_profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            rustflags_env: env::var("RUSTFLAGS").ok(),
            cargo_build_rustflags_env: env::var("CARGO_BUILD_RUSTFLAGS").ok(),
            cargo_encoded_rustflags_env: env::var("CARGO_ENCODED_RUSTFLAGS").ok(),
            // Phase 2A.7 audit H10: route through ql-storage's loud-on-parse-failure
            // helper. The previous inline `.unwrap_or(16_384)` re-introduced the exact
            // silent-fallback bug that the storage layer was hardened against in
            // Phase 0 — a misconfigured `QBOOK_CHUNK_ROWS=abc` would have the storage
            // layer panic correctly while the bench report substituted a lie.
            chunk_rows: ql_storage::chunk_rows_from_env() as usize,
            rayon_num_threads: env::var("RAYON_NUM_THREADS").ok(),
            simd: SimdDispatch::detect(),
        }
    }

    /// Render the report as a markdown block for `bench-results/*.md`.
    pub fn render_markdown(&self, out: &mut String) -> std::fmt::Result {
        writeln!(out, "## Machine")?;
        writeln!(out, "| field | value |")?;
        writeln!(out, "|---|---|")?;
        writeln!(out, "| OS | `{}` |", self.os)?;
        writeln!(out, "| Arch | `{}` |", self.arch)?;
        writeln!(
            out,
            "| CPU | {} |",
            self.cpu_brand.as_deref().unwrap_or("_(unknown)_")
        )?;
        writeln!(out, "| Logical cores | {} |", self.logical_cores)?;
        if let Some(p) = self.physical_cores {
            writeln!(out, "| Physical cores | {p} |")?;
        }
        if let Some(r) = self.ram_total_bytes {
            writeln!(out, "| RAM | {:.1} GiB |", r as f64 / (1u64 << 30) as f64)?;
        }
        writeln!(
            out,
            "| Rust toolchain | rustc {} ({}, MSRV floor {}) |",
            self.rustc_version, self.build_profile, self.msrv_floor
        )?;
        writeln!(
            out,
            "| RUSTFLAGS | `{}` |",
            self.rustflags_env.as_deref().unwrap_or("_(unset)_")
        )?;
        writeln!(
            out,
            "| CARGO_BUILD_RUSTFLAGS | `{}` |",
            self.cargo_build_rustflags_env
                .as_deref()
                .unwrap_or("_(unset)_")
        )?;
        writeln!(
            out,
            "| CARGO_ENCODED_RUSTFLAGS | `{}` |",
            self.cargo_encoded_rustflags_env
                .as_deref()
                .unwrap_or("_(unset)_")
        )?;
        writeln!(out, "| Chunk rows | {} |", self.chunk_rows)?;
        writeln!(
            out,
            "| Rayon threads | `{}` |",
            self.rayon_num_threads.as_deref().unwrap_or("_(auto)_")
        )?;
        writeln!(
            out,
            "| SIMD detected | x86 sse4.2={} avx2={}, aarch64 neon={} |",
            self.simd.x86_sse4_2, self.simd.x86_avx2, self.simd.aarch64_neon
        )?;
        Ok(())
    }
}

fn detect_cpu_brand() -> Option<String> {
    // Each cfg block is the trailing expression of the function on its target — using `return`
    // instead would make the other cfg blocks' code unreachable on platforms where the first
    // block always exits (clippy `-D unreachable-code` flagged this on Linux).
    #[cfg(target_os = "linux")]
    {
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        cpuinfo
            .lines()
            .find_map(|l| {
                l.strip_prefix("model name")
                    .and_then(|r| r.split(':').nth(1))
            })
            .map(|s| s.trim().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()?;
        if out.status.success() {
            String::from_utf8(out.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        } else {
            None
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

fn detect_ram_total() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        meminfo.lines().find_map(|l| {
            let rest = l.strip_prefix("MemTotal:")?.trim();
            let kib: u64 = rest.split_whitespace().next()?.parse().ok()?;
            Some(kib * 1024)
        })
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        if out.status.success() {
            String::from_utf8(out.stdout)
                .ok()
                .and_then(|s| s.trim().parse().ok())
        } else {
            None
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_populates_baseline_fields() {
        let r = MachineReport::collect();
        assert!(r.logical_cores >= 1);
        assert!(!r.os.is_empty());
        assert!(!r.arch.is_empty());
        // Both rustc version (actual build-time) and MSRV floor (package metadata) must be set.
        assert!(!r.rustc_version.is_empty());
        assert!(!r.msrv_floor.is_empty());
        // The two should differ in practice: rustc_version is "X.Y.Z (hash date)", MSRV is "X.Y".
        assert!(
            r.rustc_version.starts_with(char::is_numeric),
            "rustc_version should start with a digit, got {:?}",
            r.rustc_version
        );
        assert!(
            r.msrv_floor.starts_with(char::is_numeric),
            "msrv_floor should start with a digit, got {:?}",
            r.msrv_floor
        );
    }

    #[test]
    fn rustc_version_is_actual_not_msrv() {
        // Codex r11 MAJOR #6 lock: ensure we capture the BUILD-time rustc, not the package
        // MSRV. The captured version contains a git hash + date, never plain "1.85".
        let r = MachineReport::collect();
        assert_ne!(
            r.rustc_version, r.msrv_floor,
            "rustc_version must NOT equal MSRV floor"
        );
        // build-time rustc includes a parenthesized "(hash date)" detail; MSRV does not.
        assert!(
            r.rustc_version.contains('('),
            "rustc_version should embed the (hash date) detail; got {:?}",
            r.rustc_version
        );
    }

    #[test]
    fn markdown_renders() {
        let r = MachineReport::collect();
        let mut s = String::new();
        r.render_markdown(&mut s).unwrap();
        assert!(s.contains("## Machine"));
        assert!(s.contains("| OS |"));
        assert!(s.contains("| Logical cores |"));
        assert!(s.contains("| SIMD detected |"));
        // Toolchain row carries BOTH actual rustc and MSRV floor.
        assert!(s.contains("MSRV floor"));
        // All three Cargo rustflag env channels surface in the report (codex r11 #6 follow-up).
        assert!(s.contains("RUSTFLAGS"));
        assert!(s.contains("CARGO_BUILD_RUSTFLAGS"));
        assert!(s.contains("CARGO_ENCODED_RUSTFLAGS"));
    }

    #[test]
    fn chunk_rows_default_matches_storage() {
        // Documented elsewhere in the spec as 16384; this test is the canonical reminder.
        // If this needs to change, update `ql-storage` first.
        std::env::remove_var("QBOOK_CHUNK_ROWS");
        let r = MachineReport::collect();
        assert_eq!(r.chunk_rows, 16_384);
    }

    #[test]
    fn simd_struct_is_constructible() {
        let _ = SimdDispatch::detect();
    }
}
