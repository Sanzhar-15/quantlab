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
        let mut content = String::with_capacity(file.size() as usize);
        file.read_to_string(&mut content)?;
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
