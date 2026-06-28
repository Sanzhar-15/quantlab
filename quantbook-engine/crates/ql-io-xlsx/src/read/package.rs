//! OOXML package index — zip access + part enumeration.
//!
//! The xlsx file IS a zip archive containing OOXML parts at well-known
//! paths (`xl/workbook.xml`, `xl/styles.xml`, `xl/worksheets/sheet1.xml`,
//! etc.). Calamine uses this archive internally but doesn't expose the
//! raw part contents; this module is the engine's direct access.

use crate::error::XlsxError;
use std::io::{Cursor, Read};

/// In-memory handle over an xlsx zip package.
///
/// The zip is reconstructed from a `Vec<u8>` on each access. Cheap for
/// the workbook-load path (the zip is read end-to-end during the
/// import); not optimized for repeated random access.
pub(crate) struct XlsxPackage {
    bytes: Vec<u8>,
}

impl XlsxPackage {
    /// Build a package handle from the raw xlsx bytes.
    ///
    /// Doesn't validate the zip structure — that happens on the first
    /// `read_part` call. We don't want to pay the validation cost twice
    /// (calamine already opens the zip; this is the parallel path).
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Read a part's full content as a UTF-8 string.
    ///
    /// Returns `Ok(None)` if the part doesn't exist (not all xlsx
    /// packages have a `xl/styles.xml`, for instance). Returns
    /// `Err(XlsxError::Zip)` for genuinely broken zips.
    pub(crate) fn read_part_string(&self, path: &str) -> Result<Option<String>, XlsxError> {
        // The public read passes the production per-part ceiling; the limit is
        // threaded through `read_part_string_with_limit` so unit tests can
        // exercise the backstop with a small, fast ceiling (mirrors the
        // `validate_archive` / `validate_archive_with_limits` split).
        self.read_part_string_with_limit(path, crate::read::limits::MAX_PART_UNCOMPRESSED_BYTES)
    }

    /// Inner read with an injectable per-part decompressed-size `limit`.
    fn read_part_string_with_limit(
        &self,
        path: &str,
        limit: u64,
    ) -> Result<Option<String>, XlsxError> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(self.bytes.as_slice())).map_err(XlsxError::Zip)?;
        // ZipArchive::by_name returns Err for missing parts. We want
        // None for that case (so callers can branch on optional parts)
        // and only propagate genuine IO failures.
        let mut file = match archive.by_name(path) {
            Ok(f) => f,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(XlsxError::Zip(e)),
        };
        // **W5-D-PM-2 (megaudit Opus-B HIGH-5 closure — DoS):**
        // cap the pre-allocation. A hostile zip can declare a 4 GiB
        // entry size; the prior `String::with_capacity(file.size()
        // as usize)` would pre-allocate that much before reading a
        // single byte. Cap at 64 MiB; for legitimate larger files
        // (rare in xlsx — sharedStrings or huge sheetData) the
        // String grows dynamically.
        const MAX_PREALLOC: u64 = 64 * 1024 * 1024;
        let prealloc = file.size().min(MAX_PREALLOC) as usize;
        let mut content = String::with_capacity(prealloc);
        // **W-S5 (DoS hardening):** runtime backstop on the actual decompressed
        // output. `zip` caps the decompressor *input* to compressed_size but
        // leaves the *output* unbounded, so without a `take` a high-ratio entry
        // expands to GiB here regardless of the prealloc cap. We bound the read
        // to `limit` + 1 (the +1 makes overflow observable) and reject loudly —
        // never silently truncate. The up-front `read::limits::validate_archive`
        // guard already vetted the whole package, but this keeps the part reader
        // safe in isolation (defense-in-depth, and it does NOT trust the
        // declared size).
        let mut limited = (&mut file).take(limit + 1);
        limited.read_to_string(&mut content)?;
        if content.len() as u64 > limit {
            return Err(XlsxError::MalformedOoxml {
                part: path.to_string(),
                message: format!(
                    "[W-S5 DoS guard] OOXML part decompresses past the per-part limit of \
                     {limit} bytes (zip-bomb defense)"
                ),
            });
        }
        Ok(Some(content))
    }

    /// List part paths matching a prefix.
    ///
    /// Used to enumerate variable-count parts like `xl/tables/table*.xml`
    /// or `xl/worksheets/sheet*.xml`. Returns paths in zip-iteration
    /// order; the caller may need to sort if a deterministic order
    /// matters.
    pub(crate) fn list_parts_with_prefix(&self, prefix: &str) -> Result<Vec<String>, XlsxError> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(self.bytes.as_slice())).map_err(XlsxError::Zip)?;
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name.starts_with(prefix) {
                out.push(name);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build an in-memory zip with one deflated part.
    fn zip_with_part(name: &str, data: &[u8]) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zw.start_file(name, opts).unwrap();
            zw.write_all(data).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn read_part_string_backstop_rejects_part_over_limit() {
        // Part decompresses to 2048 bytes; with a 1024-byte limit the runtime
        // backstop must reject. Proves the `content.len() as u64 > limit` guard
        // in isolation — a `>`→`>=` flip or a wrong-constant regression would
        // otherwise slip past the up-front validate_archive guard unnoticed.
        let bytes = zip_with_part("xl/styles.xml", &vec![b'x'; 2048]);
        let pkg = XlsxPackage::from_bytes(bytes);
        match pkg.read_part_string_with_limit("xl/styles.xml", 1024) {
            Err(XlsxError::MalformedOoxml { message, .. }) => {
                assert!(message.contains("per-part limit"), "msg: {message}");
                assert!(message.contains("zip-bomb"), "msg: {message}");
            }
            other => panic!("expected per-part backstop rejection, got {other:?}"),
        }
    }

    #[test]
    fn read_part_string_returns_full_content_at_or_under_limit() {
        // A normal part well under the limit reads back verbatim (the backstop
        // must not truncate or corrupt legitimate content).
        let bytes = zip_with_part("xl/styles.xml", b"<styleSheet/>");
        let pkg = XlsxPackage::from_bytes(bytes);
        let got = pkg.read_part_string_with_limit("xl/styles.xml", 1024).unwrap();
        assert_eq!(got.as_deref(), Some("<styleSheet/>"));
    }

    #[test]
    fn read_part_string_missing_part_is_none() {
        let bytes = zip_with_part("xl/styles.xml", b"<styleSheet/>");
        let pkg = XlsxPackage::from_bytes(bytes);
        assert_eq!(
            pkg.read_part_string_with_limit("xl/does-not-exist.xml", 1024)
                .unwrap(),
            None
        );
    }
}
