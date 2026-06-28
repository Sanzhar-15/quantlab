//! Import-path denial-of-service hardening (zip-bomb / oversized-input wall).
//!
//! **W-S5 (Phase 4.11 import wall — DoD-5 / DoD-2):** the xlsx reader takes
//! fully *untrusted* bytes (a `.xlsx` is just a zip of OOXML parts). Two
//! classes of resource-exhaustion attack apply:
//!
//! 1. **Zip-bomb** — a tiny archive whose entries decompress to gigabytes.
//!    `zip 0.6.6` caps the decompressor *input* to each entry's
//!    `compressed_size` (`read.rs::find_content` → `reader.take(compressed_size)`),
//!    but leaves the *output* unbounded: a single deflate entry can expand
//!    ~1032× before the `Take` runs out of compressed input. Calling
//!    `read_to_end` / `read_to_string` on such an entry (which both our OOXML
//!    scanner and calamine do) materialises the full expansion in RAM. The
//!    zip crate does **not** defend this on its own.
//! 2. **Oversized input** — a multi-gigabyte file (or a workbook with a
//!    pathological part count) that exhausts memory simply by being read.
//!
//! The defense, per the engine-wide **No-Fallbacks** rule, is to **fail
//! loud**: every ceiling below returns a descriptive [`XlsxError`] — we never
//! silently truncate, skip, or "best-effort" past a limit.
//!
//! ## Where the guard runs
//!
//! [`validate_archive`] runs **once, up front**, before calamine or the OOXML
//! scanner touch the bytes (see `lib.rs::import_xlsx_bytes`). It is the *only*
//! place we can bound calamine's decompression — calamine owns its own zip
//! reader internally and exposes no size knob, so an up-front pass over the
//! same archive is the lever. The guard does not trust declared sizes (a bomb
//! can under-declare its uncompressed size to dodge a header check): it
//! **actually decompresses** each entry through a fixed 64 KiB buffer, counting
//! real output bytes and rejecting the instant a per-part or cumulative ceiling
//! is crossed. A cheap declared-size fast-reject short-circuits entries that
//! *openly* admit they are oversized, so the common bomb is killed without
//! spending a decompression cycle.
//!
//! **Cost:** the guard adds one bounded decompression pass over the archive at
//! import. For a ~200 MB compressed workbook this is on the order of ~2–5 s of
//! one-time decompression; it is paid once on the import path only, never on
//! any hot path (recompute, edit, render). A bomb is rejected the instant a
//! ceiling is crossed, so hostile input costs far less than a legit large file.
//!
//! The whole-file ceiling ([`check_input_size`]) is additionally enforced in
//! `import_xlsx_path` against `fs::metadata` *before* the file is read into
//! memory — early rejection, no allocation.
//!
//! ## XML entity expansion (billion-laughs) — safe by default, no code needed
//!
//! quick-xml 0.36.2 (used directly by our OOXML readers and internally by
//! calamine) does **not** expand DTD-declared general entities. `<!DOCTYPE …>`
//! is surfaced as an inert [`quick_xml::events::Event::DocType`] that our
//! readers ignore; `<!ENTITY …>` declarations are never registered; and
//! `unescape()` resolves only the five predefined entities plus numeric
//! character references, returning [`quick_xml::escape::EscapeError::UnrecognizedEntity`]
//! for anything else. Custom-entity resolution requires explicitly wiring an
//! `EntityResolver` (a doc-only example in quick-xml) — we never do. A
//! billion-laughs payload therefore cannot expand: our readers reject the
//! unknown `&lolN;` reference loudly at `unescape_value()` (→
//! [`XlsxError::MalformedOoxml`]). This is verified by the entity tests below;
//! no defensive code is added because none is needed (a dead defense would
//! only obscure the real guarantee).
//!
//! ## Cap rationale (generous headroom for real workbooks)
//!
//! Real `.xlsx` files are small: typical workbooks are well under 50 MB on
//! disk; even large financial models rarely exceed ~200 MB. Uncompressed, the
//! heaviest parts (`xl/sharedStrings.xml`, `xl/worksheets/sheetN.xml`) for a
//! million-row sheet reach the low hundreds of MB. The ceilings below sit
//! comfortably (several ×) above any legitimate workbook while bounding the
//! worst case to a few GiB — far below the tens-to-hundreds of GiB a zip bomb
//! targets.

use crate::error::XlsxError;
use std::io::{Cursor, Read};

/// Maximum size of the whole `.xlsx` input (the zip file itself).
///
/// `import_xlsx_path` reads the entire file into memory before parsing, so
/// this bounds that single allocation. 512 MiB is ~2.5–5× the largest
/// realistic legitimate workbook on disk; a bomb is usually tiny on disk (its
/// danger is the expansion ratio, caught by the per-part / total ceilings).
pub(crate) const MAX_INPUT_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Maximum decompressed size of a **single** OOXML part.
///
/// The biggest legitimate part is `sharedStrings.xml` or a worksheet's
/// `sheetN.xml`; even a million-row sheet's XML stays well under 1 GiB. A
/// bomb part declares/produces terabytes.
pub(crate) const MAX_PART_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;

/// Maximum **cumulative** decompressed size across all parts in the archive.
///
/// Bounds total memory/CPU spent decompressing the workbook. 2 GiB is above
/// any realistic workbook's total uncompressed footprint; classic bombs target
/// 100s of GiB–TiB.
pub(crate) const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Maximum number of entries (parts) in the zip.
///
/// xlsx part count scales with `#sheets × ~3–5` plus shared parts and media;
/// even a 1000-sheet workbook stays in the low thousands. 65 536 is generous
/// headroom; a part-count-overload archive runs to hundreds of thousands.
pub(crate) const MAX_ENTRY_COUNT: usize = 65_536;

/// Buffer size for the streaming decompression measurement. Keeps the guard's
/// own memory O(1) regardless of (bounded) part size.
const SCRATCH_BYTES: usize = 64 * 1024;

/// Build the typed rejection for a tripped resource ceiling.
///
/// **Reuses [`XlsxError::MalformedOoxml`]** rather than introducing a new
/// variant: `ql-exec` depends on this crate and the W-S5 brief mandates an
/// internal-only change (no public error-type surface change). A
/// resource-exhausting / hostile package is a species of malformed input, and
/// `MalformedOoxml { part, message }` carries the dynamic detail (observed
/// value vs. ceiling) needed for a *descriptive* failure. The `[W-S5 DoS guard]`
/// prefix makes these rejections unambiguous in logs.
fn limit_exceeded(part: &str, message: String) -> XlsxError {
    XlsxError::MalformedOoxml {
        part: part.to_string(),
        message: format!("[W-S5 DoS guard] {message}"),
    }
}

/// Enforce the whole-file ceiling ([`MAX_INPUT_FILE_BYTES`]).
///
/// `origin` describes where the size came from (e.g. `"input file"` for the
/// `fs::metadata` pre-check, `"in-memory buffer"` for the bytes entry point)
/// so the error localises the rejection.
pub(crate) fn check_input_size(len: u64, origin: &str) -> Result<(), XlsxError> {
    if len > MAX_INPUT_FILE_BYTES {
        return Err(limit_exceeded(
            origin,
            format!(
                "xlsx {origin} is {len} bytes, exceeding the import limit of \
                 {MAX_INPUT_FILE_BYTES} bytes ({} MiB)",
                MAX_INPUT_FILE_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(())
}

/// Up-front zip-bomb / oversized-archive guard over the raw xlsx bytes.
///
/// Runs before calamine and the OOXML scanner. Enforces: entry-count bound,
/// per-part declared-size fast-reject, and — authoritatively — per-part and
/// cumulative *actual* decompressed-size bounds via streaming measurement.
///
/// Returns `Ok(())` if the archive is within all ceilings, an
/// [`XlsxError::Zip`] if the bytes are not a readable zip, or an
/// [`XlsxError::MalformedOoxml`] (via [`limit_exceeded`]) describing the first
/// tripped ceiling.
pub(crate) fn validate_archive(bytes: &[u8]) -> Result<(), XlsxError> {
    validate_archive_with_limits(
        bytes,
        MAX_ENTRY_COUNT,
        MAX_PART_UNCOMPRESSED_BYTES,
        MAX_TOTAL_UNCOMPRESSED_BYTES,
    )
}

/// Parameterised core of [`validate_archive`] (limits injected so unit tests
/// can exercise rejection with small, fast ceilings instead of allocating
/// gigabytes).
fn validate_archive_with_limits(
    bytes: &[u8],
    max_entries: usize,
    max_part: u64,
    max_total: u64,
) -> Result<(), XlsxError> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(XlsxError::Zip)?;

    // (3) Part-count sanity bound — cheap, read straight from the central
    // directory.
    let entry_count = archive.len();
    if entry_count > max_entries {
        return Err(limit_exceeded(
            "archive",
            format!(
                "zip declares {entry_count} parts, exceeding the import limit of {max_entries}"
            ),
        ));
    }

    let mut total_uncompressed: u64 = 0;
    let mut scratch = [0u8; SCRATCH_BYTES];

    for i in 0..entry_count {
        let mut entry = archive.by_index(i).map_err(XlsxError::Zip)?;
        let name = entry.name().to_string();

        // (1a) Cheap fast-reject on the DECLARED uncompressed size: an entry
        // that openly admits it expands past the per-part ceiling is rejected
        // before we spend a single decompression cycle. (A bomb can lie low
        // here to dodge the check — the streaming measurement below is the
        // authoritative defense; this is purely an optimisation.)
        let declared = entry.size();
        if declared > max_part {
            return Err(limit_exceeded(
                &name,
                format!(
                    "part declares uncompressed size {declared} bytes, exceeding the \
                     per-part limit of {max_part} bytes"
                ),
            ));
        }

        // (1)+(2) Authoritative bound: actually decompress through a fixed
        // buffer, counting real output bytes, and reject the moment the
        // per-part OR running-total ceiling is crossed. `zip` caps the
        // decompressor *input* to compressed_size but leaves the *output*
        // unbounded, so measuring the true output is the real zip-bomb wall.
        //
        // Invariant: total_uncompressed <= max_total on entry, so this
        // subtraction never underflows.
        let total_budget = max_total - total_uncompressed;
        // Read up to (smaller ceiling) + 1 byte so crossing it is observable.
        let cap = max_part.min(total_budget);
        let mut limited = (&mut entry).take(cap + 1);
        let mut produced: u64 = 0;
        loop {
            // A decompression error (corrupt deflate stream) surfaces here as
            // an io::Error → XlsxError::Io (loud, not swallowed).
            let n = limited.read(&mut scratch)?;
            if n == 0 {
                break;
            }
            produced += n as u64;
        }
        if produced > cap {
            // Crossed a ceiling. Report the ACTUAL binding ceiling: the
            // cumulative-total message only when the remaining total budget is
            // the *strictly smaller* ceiling (so it, not the per-part cap, ran
            // out first); otherwise — including the equality case where both
            // are saturated — report the per-part violation. This only selects
            // the message string; it never changes which inputs are rejected.
            if produced > total_budget && total_budget < max_part {
                return Err(limit_exceeded(
                    "archive",
                    format!(
                        "cumulative decompressed output exceeds the total workbook limit of \
                         {max_total} bytes (zip-bomb defense); tripped at part {name:?}"
                    ),
                ));
            }
            return Err(limit_exceeded(
                &name,
                format!(
                    "part decompresses past the per-part limit of {max_part} bytes \
                     (zip-bomb defense)"
                ),
            ));
        }
        total_uncompressed += produced;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::package::XlsxPackage;
    use std::io::Write;

    /// Build an in-memory zip from `(name, bytes, deflate?)` entries.
    fn build_zip(entries: &[(&str, Vec<u8>, bool)]) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            for (name, data, deflate) in entries {
                let method = if *deflate {
                    zip::CompressionMethod::Deflated
                } else {
                    zip::CompressionMethod::Stored
                };
                let opts = zip::write::FileOptions::default().compression_method(method);
                zw.start_file(*name, opts).unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn check_input_size_accepts_small_and_rejects_oversized() {
        check_input_size(1024, "in-memory buffer").expect("1 KiB must pass");
        check_input_size(MAX_INPUT_FILE_BYTES, "in-memory buffer")
            .expect("exactly the limit must pass");
        match check_input_size(MAX_INPUT_FILE_BYTES + 1, "in-memory buffer") {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("DoS guard"), "msg: {message}");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn normal_archive_passes_real_limits() {
        // A handful of small parts — representative of a tiny real workbook.
        let bytes = build_zip(&[
            ("[Content_Types].xml", b"<Types/>".to_vec(), true),
            ("xl/workbook.xml", b"<workbook><sheets/></workbook>".to_vec(), true),
            ("xl/worksheets/sheet1.xml", vec![b'x'; 4096], true),
        ]);
        validate_archive(&bytes).expect("a normal small archive must pass the guard");
    }

    #[test]
    fn high_ratio_honestly_declared_part_is_rejected() {
        // 5 MiB of zeros deflates to a few KB — a high-ratio bomb part that
        // HONESTLY declares its uncompressed size. The cheap declared-size
        // fast-reject catches it before any decompression.
        let bomb = vec![0u8; 5 * 1024 * 1024];
        let bytes = build_zip(&[("xl/worksheets/sheet1.xml", bomb, true)]);
        match validate_archive_with_limits(&bytes, 100, 1024 * 1024, 100 * 1024 * 1024) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("declares uncompressed size"), "msg: {message}");
            }
            other => panic!("expected declared-size rejection, got {other:?}"),
        }
    }

    /// Build a deflated zip of `actual_uncompressed` zero-bytes, then patch the
    /// declared uncompressed-size fields (local header offset 22 + central
    /// directory header offset +24) down to `fake_declared`. This forges the
    /// "lying" zip bomb: it under-declares its size to dodge the declared-size
    /// fast-reject, while the (truthful) `compressed_size` still drives the
    /// decompressor to emit the full `actual_uncompressed` output.
    fn forge_under_declared_zip(actual_uncompressed: usize, fake_declared: u32) -> Vec<u8> {
        let mut bytes = build_zip(&[("xl/sheet.bin", vec![0u8; actual_uncompressed], true)]);
        let fake = fake_declared.to_le_bytes();
        // Zip32 (non-zip64) layout assumption: the uncompressed-size field is a
        // 4-byte LE value at local-header offset 22 and central-directory-header
        // offset +24. Valid only while sizes fit in u32 (no zip64 extra field);
        // a future test using > 4 GiB sizes must patch the zip64 extra field
        // instead, or it would silently clobber the wrong bytes.
        assert_eq!(
            &bytes[0..4],
            b"PK\x03\x04",
            "expected local file header (PK\\x03\\x04) at offset 0"
        );
        // Local file header: uncompressed_size at +22.
        bytes[22..26].copy_from_slice(&fake);
        // Central directory header (PK\x01\x02): uncompressed_size at +24.
        let cd = bytes
            .windows(4)
            .position(|w| w == b"PK\x01\x02")
            .expect("central directory header (PK\\x01\\x02) not found — zip layout changed");
        bytes[cd + 24..cd + 28].copy_from_slice(&fake);
        bytes
    }

    #[test]
    fn under_declared_bomb_is_caught_by_streaming_measurement() {
        // Declares 100 bytes uncompressed but actually decompresses to 2 MiB.
        // The fast-reject (declared 100 <= 1 MiB cap) does NOT fire; the
        // streaming measurement of the REAL output (2 MiB > 1 MiB) does. This
        // is the authoritative zip-bomb wall that does not trust declared sizes.
        let bytes = forge_under_declared_zip(2 * 1024 * 1024, 100);
        match validate_archive_with_limits(&bytes, 100, 1024 * 1024, 100 * 1024 * 1024) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("per-part"), "msg: {message}");
                assert!(message.contains("zip-bomb"), "msg: {message}");
            }
            other => panic!("expected streaming per-part rejection, got {other:?}"),
        }
    }

    #[test]
    fn equal_budgets_report_per_part_message() {
        // Construct max_part == total_budget (single entry → total_budget =
        // max_total) with a part one byte over. Both ceilings saturate at the
        // same value; the message selection must report the per-part violation
        // (not the cumulative-total one) since neither is the strictly-smaller
        // binding ceiling. Forged under-declared so the streaming branch (not
        // the declared-size fast-reject) is exercised.
        let limit = 1024 * 1024;
        let bytes = forge_under_declared_zip(limit + 1, 100);
        match validate_archive_with_limits(&bytes, 100, limit as u64, limit as u64) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("per-part"), "msg: {message}");
                assert!(
                    !message.contains("total workbook limit"),
                    "equal budgets must not report the total-limit message: {message}"
                );
            }
            other => panic!("expected per-part rejection on equal budgets, got {other:?}"),
        }
    }

    /// Build a valid deflated zip, then corrupt 4 bytes in the middle of the
    /// (truthful) compressed deflate stream — leaving all zip headers intact so
    /// the archive still opens and reaches decompression.
    fn corrupt_deflate_stream(name: &str) -> Vec<u8> {
        let mut bytes = build_zip(&[(name, vec![0u8; 256 * 1024], true)]);
        // Zip32 local file header at offset 0: comp_size@18, name_len@26,
        // extra_len@28; compressed data begins at 30 + name_len + extra_len.
        assert_eq!(&bytes[0..4], b"PK\x03\x04", "expected local file header at offset 0");
        let comp_size = u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]) as usize;
        let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[28], bytes[29]]) as usize;
        assert!(comp_size >= 8, "compressed stream too small to corrupt safely");
        let data_start = 30 + name_len + extra_len;
        // Flip a 4-byte window mid-stream → invalid deflate (or, if the decoder
        // tolerates it, a CRC mismatch at EOF). Either way decompression errors.
        for off in 0..4 {
            bytes[data_start + comp_size / 2 + off] ^= 0xFF;
        }
        bytes
    }

    #[test]
    fn corrupt_deflate_stream_surfaces_as_io_error() {
        // A truncated/garbled deflate stream must propagate loudly as an
        // XlsxError::Io (via the `limited.read()?` in the guard) — never panic
        // and never be silently swallowed.
        let bytes = corrupt_deflate_stream("xl/sheet.bin");
        match validate_archive(&bytes) {
            Err(XlsxError::Io(_)) => {}
            other => panic!("expected Io error from corrupt deflate, got {other:?}"),
        }
    }

    #[test]
    fn excessive_total_uncompressed_is_rejected() {
        // Two 2 MiB parts: each is under a 5 MiB per-part ceiling, but their
        // sum (4 MiB) exceeds a 3 MiB total ceiling.
        let part = vec![0u8; 2 * 1024 * 1024];
        let bytes = build_zip(&[
            ("a.bin", part.clone(), true),
            ("b.bin", part, true),
        ]);
        match validate_archive_with_limits(&bytes, 100, 5 * 1024 * 1024, 3 * 1024 * 1024) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("total workbook limit"), "msg: {message}");
            }
            other => panic!("expected total-size rejection, got {other:?}"),
        }
    }

    #[test]
    fn excessive_part_count_is_rejected() {
        let bytes = build_zip(&[
            ("a", b"x".to_vec(), false),
            ("b", b"x".to_vec(), false),
            ("c", b"x".to_vec(), false),
        ]);
        match validate_archive_with_limits(&bytes, 2, 1 << 30, 1 << 30) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("parts"), "msg: {message}");
            }
            other => panic!("expected part-count rejection, got {other:?}"),
        }
    }

    #[test]
    fn declared_oversize_part_is_fast_rejected() {
        // A small stored part, but we set the per-part ceiling below its
        // (honest) declared size to exercise the declared-size fast path.
        let bytes = build_zip(&[("big.bin", vec![b'z'; 2048], false)]);
        match validate_archive_with_limits(&bytes, 100, 1024, 1 << 30) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("declares uncompressed size"), "msg: {message}");
            }
            other => panic!("expected declared-size rejection, got {other:?}"),
        }
    }

    #[test]
    fn non_zip_bytes_surface_as_zip_error() {
        match validate_archive(b"this is not a zip file") {
            Err(XlsxError::Zip(_)) => {}
            other => panic!("expected Zip error for non-zip input, got {other:?}"),
        }
    }

    // ---- XML entity-expansion (billion-laughs) is inert by default ----

    #[test]
    fn quick_xml_does_not_expand_custom_entities() {
        // The dependency-level guarantee our OOXML readers inherit:
        // predefined entities resolve, custom (DTD-declared) entities do NOT —
        // they error rather than expand.
        assert_eq!(quick_xml::escape::unescape("&amp;").unwrap(), "&");
        assert!(
            quick_xml::escape::unescape("&lol9;").is_err(),
            "quick-xml must reject (never expand) a custom entity"
        );
    }

    #[test]
    fn billion_laughs_payload_is_rejected_not_expanded() {
        // Route a billion-laughs document through our REAL styles reader. The
        // DTD <!ENTITY> declarations are never registered by quick-xml, so the
        // nested &lolN; references cannot expand; the unknown entity in the
        // formatCode attribute is rejected loudly at unescape_value(). The
        // call must return (not hang) with an error.
        let payload = concat!(
            "<?xml version=\"1.0\"?>",
            "<!DOCTYPE styleSheet [",
            "  <!ENTITY lol \"lol\">",
            "  <!ENTITY lol1 \"&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;\">",
            "  <!ENTITY lol2 \"&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;\">",
            "  <!ENTITY lol3 \"&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;\">",
            "]>",
            "<styleSheet><numFmt numFmtId=\"200\" formatCode=\"&lol3;\"/></styleSheet>",
        );
        let bytes = build_zip(&[("xl/styles.xml", payload.as_bytes().to_vec(), false)]);
        let pkg = XlsxPackage::from_bytes(bytes);
        let result = crate::read::styles_xml::parse_styles_xml(&pkg);
        assert!(
            result.is_err(),
            "billion-laughs payload must be rejected (entities are never expanded), got {result:?}"
        );
    }
}
