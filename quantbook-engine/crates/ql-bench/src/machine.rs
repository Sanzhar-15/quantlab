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
    pub rust_version: &'static str,
    pub build_profile: &'static str,
    pub rustflags_env: Option<String>,
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
            rust_version: env!("CARGO_PKG_RUST_VERSION"),
            build_profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            rustflags_env: env::var("RUSTFLAGS").ok(),
            chunk_rows: env::var("QBOOK_CHUNK_ROWS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(16_384),
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
            "| Rust toolchain | {} ({}) |",
            self.rust_version, self.build_profile
        )?;
        writeln!(
            out,
            "| RUSTFLAGS | `{}` |",
            self.rustflags_env.as_deref().unwrap_or("_(unset)_")
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
