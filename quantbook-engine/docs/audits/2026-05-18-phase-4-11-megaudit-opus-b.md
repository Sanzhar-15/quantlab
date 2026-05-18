# Phase 4.11 Opus-B Findings — Defensive / Adversarial / Corruption Resilience

**Auditor:** Opus-B (parallel auditor in 4-way Phase 4.11 megaudit)
**Scope:** Malformed input, panics, OOM, silent corruption, path traversal,
integer overflow, encoding edge cases, concurrent-access races.
**Branch / HEAD:** `feat/quantbook-engine` @ `f941195608b`
**Repo path:** `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`

All findings below were empirically reproduced with programmatically-built
adversarial zip fixtures driven through `import_xlsx_bytes` /
`export_xlsx_path`. The probes were temporarily placed in
`crates/ql-io-xlsx/tests/opus_b_*.rs` and removed after capture; the
outputs are reproduced under each finding under "Repro evidence".

The empirical baseline (`phase_4_11_corpus_probe.rs` 177/177 fixtures
passing) covers WELL-FORMED files. None of the issues below trip on
that corpus. They trip on hostile or near-pathological inputs that a
real-world workflow will absolutely see (LLM-generated xlsx, fuzz
input, decade-old Office files, attacker-controlled uploads).

Severity rationale: HIGH = panic, silent data corruption in either
direction, or a DoS vector reachable from xlsx bytes alone. MEDIUM =
defensive-validation gap that won't crash but will produce incorrect
state without surfacing. LOW = quality-of-error or hygiene.

---

## HIGH

### H-1. `numFmtId="4294967295"` (u32::MAX) panics the importer with arithmetic overflow

**Where:** `crates/ql-storage/src/format.rs:153`
**Reached via:** `crates/ql-io-xlsx/src/read/styles_import.rs:59` calling
`workbook.formats_mut().register_at(FormatId(entry.num_fmt_id), &entry.format_code)`
with an attacker-controlled `u32` from `xl/styles.xml`.

A malicious or buggy `xl/styles.xml` carrying
`<numFmt numFmtId="4294967295" formatCode="custom"/>` reaches
`FormatTable::register_at` with `id.0 == u32::MAX`. The function
unconditionally executes `self.next_custom_id = id.0 + 1;` →
`attempt to add with overflow` panic on debug, wrapping silent
corruption on release.

The xlsx import trust boundary explicitly takes raw attacker-supplied
u32 values from styles.xml and routes them straight into the storage
layer. There is no bounds check.

**Repro evidence:**
```
thread 'probe_numfmt_id_uint_max' (87363770) panicked at
crates/ql-storage/src/format.rs:153:35:
attempt to add with overflow
```

**Fix sketch:** at `styles_import.rs:47`, reject any `num_fmt_id` ≥
`u32::MAX - some_buffer` (or simply `>= 1 << 24` — Excel's actual
ceiling is 32767-ish for legal numFmtIds anyway). Surface as
`XlsxError::MalformedOoxml`.

The same overflow surface exists for ANY caller of `register_at`
passing untrusted ids — the right place to fix is also
`FormatTable::register_at` itself, using `checked_add`.

---

### H-2. Out-of-bounds cell refs silently stored in `Sheet::format_overlay` (M-6 from W5-D-15.2 self-audit STILL OPEN)

**Where:** `crates/ql-io-xlsx/src/lib.rs:197-212` per-cell-style application loop.

The cell-styles scanner (`parse_cell_styles_xml` at
`crates/ql-io-xlsx/src/read/cell_styles_xml.rs:80-104`) parses A1
refs into `(row, col)` tuples with NO range check against
`MAX_ROW=1_048_575` / `MAX_COLUMN=16_383`. The result is pushed to
`Vec<(RowId, ColId, u32)>` and then `lib.rs:211` calls
`sheet.format_overlay_mut().set(row, col, fmt_id)`.

`CellFormatOverlay::set`
(`crates/ql-storage/src/format_overlay.rs:47-49`) is a thin HashMap
insert with NO bounds check.

The cell-value path is bounds-checked
(`crates/ql-io-xlsx/src/read/convert.rs:61-82` — both row and col
guarded with warnings emitted). The cell-FORMAT path was missed.

Result on a fixture with `<c r="XFE1" s="1"/>` (col 16384, one past
MAX_COLUMN):

```
PROBE oob_cell_ref: import OK, overlay entries = 1
PROBE oob_cell_ref XFE1 stored: Some(FormatId(164))
```

And with `<c r="A1048577" s="1"/>` (row 1048576, one past MAX_ROW):

```
PROBE oob_row stored: Some(FormatId(164)), overlay_len = 1
```

**Why it matters:**
1. Round-trip emits these entries back (`umya_export.rs:250-263`
   walks the overlay) with `col_letter(16384)="XFE"` → Excel will
   reject the resulting file ("cell reference out of range").
2. Internal engine code that iterates the overlay (e.g. format
   compaction in Phase 4.10 GAP-F-07) walks entries the engine
   considers impossible; downstream code does NOT defensively bound
   row/col reads from the overlay.
3. It's a silent-corruption import: data ends up in storage state
   the engine's runtime path can't address (`Sheet::read(MAX_ROW+1, _)`
   panics or returns Blank, but `format_overlay().get(MAX_ROW+1, _)`
   returns `Some(fmt_id)` happily).

This is the M-6 the W5-D-15.2 self-audit explicitly called out —
verified still open at HEAD `f941195608b`.

**Fix sketch:** at `cell_styles_xml.rs:62-66` (after the `parse_a1_cell`
call), reject `(row, col)` if either dimension exceeds MAX_ROW /
MAX_COLUMN. Add the same warning the convert.rs cell-value path emits
to `report.warnings`.

---

### H-3. Path-traversal entries in zip silently accepted; `resolve_rel_target` happily walks `..` out of the package root

**Where:**
- Acceptance: `crates/ql-io-xlsx/src/read/package.rs:26` (`from_bytes` doesn't
  validate zip entry names).
- Resolver: `crates/ql-io-xlsx/src/read/rels.rs:126-157`.

A package whose zip contains `../../etc/passwd` is accepted without
error; the OOXML scanner's `list_parts_with_prefix("")` returns it,
the `feature_inventory` scan walks it, and any code path that does
`package.read_part_string("../../etc/passwd")` would actually retrieve
that bytes-by-name (the zip crate's `by_name` matches exact path
including `..`).

We don't currently call `read_part_string` with attacker-controlled
strings — but `resolve_rel_target("xl/_rels/workbook.xml.rels",
attacker_target)` IS used at:
- `crates/ql-io-xlsx/src/read/sheet_parts.rs:63` (workbook rels → sheet
  paths)
- `crates/ql-io-xlsx/src/read/tables_import.rs:65` (sheet rels → table
  xml)

And it correctly walks `..` out:

```rust
// rels.rs:148-156
let mut segments: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
for part in target.split('/') {
    if part == ".." {
        segments.pop();   // <-- happily pops past the root
    } else if part != "." && !part.is_empty() {
        segments.push(part);
    }
}
segments.join("/")
```

A rels file with `Target="../../../etc/passwd"` from a level-3-deep
rels path resolves to a literal `etc/passwd` (or empty string if more
`..` than depth) — and IS used as a zip entry name to `read_part_string`.

While the zip crate's `by_name` confines lookups to the in-memory zip
(it WILL NOT touch the filesystem `/etc/passwd`), the post-resolution
path can collide with a different in-package part. A crafted package
with one entry literally named `xl/workbook.xml` and another sheet rel
target `Target="../../../../xl/workbook.xml"` confuses the table
import to load workbook.xml AS a table XML — surfaces as a
MalformedOoxml on `read_table` parse, but the import path-walking
logic was never designed assuming an attacker controls these strings.

**Repro evidence:**
```
PROBE path_traversal: true       // /etc/passwd entry accepted
PROBE rels_path_traversal: true  // ../../../etc/passwd target accepted
```

**Why it's HIGH:** This is the OWASP CWE-22 surface for an
xlsx-receiver service. Defensive convention (used by zip-tools, OpenJDK,
.NET ZipFile.ExtractToDirectory after CVE-2018-1002105) is to reject
entry names containing `..` or absolute paths AT EXTRACT TIME. We
extract into in-memory state but the same hygiene applies because the
"sandbox" is "the well-formed OOXML part namespace" — and that is
violable by an attacker controlling these strings.

**Fix sketch:**
1. In `XlsxPackage::from_bytes`, walk the zip directory and reject any
   entry whose name contains `..`, starts with `/`, or contains a
   nul / backslash. Return `XlsxError::MalformedOoxml { part: name }`.
2. In `resolve_rel_target`, never let `segments.pop()` go past
   zero. If a target's `..` count exceeds the rels-file depth, reject
   with `XlsxError::MalformedOoxml`.

---

### H-4. Sheet names with NUL bytes / control characters accepted; round-trips into Excel which rejects them

**Where:** `crates/ql-io-xlsx/src/read/convert.rs:33-50` — calls
`Workbook::add_sheet(sheet_name)`. The storage layer's name validator
(`Workbook::try_add_sheet_with_chunk_rows` per `workbook.rs:463`)
rejects empty/duplicate/reserved-char names but does NOT reject
control characters or NUL.

Calamine extracts the OOXML `name` attribute verbatim. An xlsx with
`<sheet name="Hello&#x0;World" .../>` (NUL byte unescaped) flows
through:
1. `calamine_grid::sheet_names()` returns `"Hello\u{0000}World"`
2. `convert.rs:39` calls `wb.add_sheet("Hello\u{0000}World")` — accepts
3. `umya_export.rs:132` calls `spreadsheet.new_sheet("Hello\u{0000}World")` —
   umya accepts; emits the OOXML `<sheet name="Hello World"/>` raw
4. Excel rejects on open ("file is corrupted").

Even without exporting: a downstream engine consumer that uses sheet
names for path-component formatting, log-line emission, or HTTP header
emission gets attacker-injected NUL bytes.

**Repro evidence:**
```
PROBE sheet_name_null_byte: ok=true err=None
PROBE sheet_name_control_chars: ok=true err=None      // \u{0007} (BEL) and \u{0001} (SOH)
```

**Fix sketch:** the rejection is best done in `Workbook::add_sheet`
(storage layer), but the xlsx import is the trust boundary that
notices first. At `convert.rs:36`, reject any name containing
characters with `c.is_control()` (Rust's `char::is_control` covers
all Unicode control codepoints) BEFORE calling `add_sheet`.
Surface as `XlsxError::MalformedOoxml` so Strict-mode callers see it.

---

### H-5. `String::with_capacity(file.size() as usize)` is an OOM oracle controlled by attacker

**Where:** `crates/ql-io-xlsx/src/read/package.rs:46`.

```rust
let mut content = String::with_capacity(file.size() as usize);
file.read_to_string(&mut content)?;
```

`file.size()` is the UNCOMPRESSED size — straight out of the zip
local-file-header, which an attacker controls. A 52 KB zip with a
single `xl/workbook.xml` entry compressing 50 MB of `'A'` bytes
allocates the full 50 MB upfront before any read.

Empirical (a 50MB benign payload):
```
PROBE zip_bomb compressed: 52358 bytes, uncompressed payload: 50MB
PROBE zip_bomb import: ok=true, elapsed=449.585375ms
```

Scaling up: a 2 GB uncompressed-size zip header on a 200 KB zip
allocates 2 GB virtual memory (`String::with_capacity` calls
`alloc`). On 32-bit or constrained-RAM environments this is an
abort. On 64-bit it's a sustained-memory-exhaustion vector for a
service taking xlsx uploads.

Compounding: the SCANNER reads multiple parts. A package with
malicious entries for every part path our scanner enumerates
(`xl/workbook.xml`, `xl/styles.xml`, `xl/sharedStrings.xml`, each
sheet xml, table xml, customXml, etc.) multiplies the allocation.

The scanner also re-creates the zip archive on EVERY `read_part_string`
call (`crates/ql-io-xlsx/src/read/package.rs:36-37`). This means:
- Single import does multiple zip-parses (workbook.xml, then per-sheet
  xml for feature inventory, then again for tables, then sheet rels,
  then table parts...). Each open is O(N) over the central directory.
- For an N-part workbook, total cost is O(N²). 300 sheets in the
  probe took milliseconds; 30000 sheets is quadratic-explosion.

**Fix sketch:**
1. Cap `file.size()` at a configurable max (e.g. 50 MB per part) and
   return `XlsxError::MalformedOoxml { part, message: "part exceeds
   max uncompressed size" }`.
2. Either cache the `ZipArchive` (own it inside `XlsxPackage`) or do
   one zip open per import and stream all parts in a single pass.
3. Add an overall limit on total uncompressed package size.

---

### H-6. Concurrent exports to the SAME output path race; 3 of 4 fail and 1 wins with no error

**Where:** `crates/ql-io-xlsx/src/write/umya_export.rs:268-269` and
`umya_export.rs:445`.

```
// line 268
umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
// later, line 445
std::fs::write(path, out_buf)?;
```

Both `umya::write` and `std::fs::write` are non-atomic; the second
call OVERWRITES the first's bytes (post-process pattern). Two
concurrent exporters can:
- Both write umya's initial bytes (clobber each other).
- One reads what the other partially wrote during post-process via
  `std::fs::read(path)` at `umya_export.rs:363`.
- The output is a torn write.

Empirical (4 threads writing different workbook content to same path):
```
PROBE concurrent_export: 1 of 4 ok
 final sheet[0] = S0
```

3 of 4 reported error; 1 succeeded and the result was "S0" (the
content of whichever thread won the post-process re-read race; the
other 3 either failed mid-write or had their bytes blown away).

The W5-D-14.2.1 H-1 closure mentions `sibling_tmp_path` was made
process-static to handle this for the SHADOW path under
`UpdateOriginal`. But:
- `NewWorkbook` mode bypasses the shadow path entirely and writes to
  `output_path` directly, twice.
- Even `UpdateOriginal` ends with `std::fs::write(output_path, out_buf)`
  (`update_original.rs:230`) — same non-atomic write to the user's
  destination.

**Fix sketch:** atomic-write convention is "write to a sibling temp
path → rename". `std::fs::rename` on the same filesystem is atomic on
POSIX and on Windows ≥ 2018-era. Both `umya::write` and the
post-process pass should target a temp path; the final `rename` to
`output_path` is what makes it visible. Document the destination-path
single-writer assumption otherwise.

---

### H-7. Strict-mode import of a workbook with NO `<sheets>` element succeeds and silently produces a zero-sheet workbook

**Where:** `crates/ql-io-xlsx/src/read/workbook_xml.rs:94-209`
(the parser doesn't require a `<sheets>` element).

A workbook.xml with `<workbook xmlns="..."></workbook>` and no
`<sheets>` parses to `WorkbookProperties { sheets: Vec::new(), ... }`.
The downstream `build_sheet_rels_paths` returns empty Vec, the
calamine grid sees zero sheets, and `add_sheet` is never called.
Import returns Ok with a Workbook that has zero sheets — which is
unrepresentable per OOXML spec (Excel writes one empty Sheet1
minimum).

```
PROBE no_sheets: None    // means import succeeded
```

Why HIGH: downstream callers assume `sheet_count() > 0` for many
operations (the umya exporter would call `iter_formulas()` which is
empty, then succeed in writing a 0-sheet file → Excel rejects on
open). The error path that should have surfaced "package is missing
the required `<sheets>` element" never fires.

This is a CONTRACT VIOLATION at the import boundary — the OOXML spec
mandates at least one sheet. We accept zero. Permissive vs Strict
mode setting doesn't help; this is at a layer above unsupported-feature
policy.

**Fix sketch:** in `workbook_xml.rs:parse_workbook_xml`, after the
event loop, if `props.sheets.is_empty()` return
`XlsxError::MalformedOoxml { part: "xl/workbook.xml", message: "no
<sheet> elements in <sheets>; OOXML requires at least one sheet" }`.

---

### H-8. `<sheet>` with `r:id="rId99"` (no matching rel) silently dropped; sheet count diverges between OOXML view and runtime

**Where:** `crates/ql-io-xlsx/src/read/sheet_parts.rs:67-71`.

```rust
for sheet in &workbook_props.sheets {
    let part_path = rid_to_part.get(&sheet.r_id).cloned().unwrap_or_default();
    paths.push(part_path);
}
```

If `sheet.r_id` doesn't appear in `rid_to_part`, the slot gets an
EMPTY string. The downstream table-import and per-cell-style loops
treat empty-string as "no rels, skip this sheet" — but the WORKBOOK
itself was already populated by calamine (which uses its own zip-based
sheet enumeration that doesn't care about rels). End result: calamine
loaded the sheet's grid but we then drop its tables, formats, and
sheet-rels-anchored metadata.

This is a silent partial-import. The sheet appears in
`Workbook::sheet_count()`, but its tables/styles/etc. silently vanish.

```
PROBE missing_rid: false   // means import is OK but data was lost
```

**Why HIGH:** the partial-data import is invisible to the caller. No
warning is logged. `report.warnings` stays empty. A downstream test
relying on round-trip fidelity will diverge on re-export — and worse,
a downstream USER will see their tables disappear after a
Quantbook open/save with no signal.

**Fix sketch:** at `sheet_parts.rs:68`, when `rid_to_part.get(&sheet.r_id)`
is None, emit either:
- A `report.warnings` entry explaining the missing rel.
- Or under `UnsupportedPolicy::Strict`, return `XlsxError::MalformedOoxml`.

---

## MEDIUM

### M-1. `definedName localSheetId` parses to `u32` then silently casts to `SheetId` (u16) — values ≥ 65536 silently truncate

**Where:** `crates/ql-io-xlsx/src/read/workbook_xml.rs:158-162` parses
`local_sheet_id` as u32 then `crates/ql-io-xlsx/src/read/names_import.rs:60`
casts to `SheetId` via `as SheetId`.

```rust
// names_import.rs:60
if let Some(sheet) = workbook.sheet_mut(sid as SheetId) {
```

Where `SheetId = u16` per `ql-types`. A `localSheetId="65536"`
truncates to 0 — the name silently re-targets sheet 0. A
`localSheetId="4294967295"` truncates to 65535 — likely not a sheet,
so `sheet_mut` returns None and the name is silently dropped.

Empirical:
```
PROBE definedname_u32_max: true   // accepted, name silently dropped
```

**Fix:** at `names_import.rs:59`, reject if `sid >= SheetId::MAX as u32`
OR `sid >= workbook.sheet_count() as u32` with a warning.

---

### M-2. `<sheet>` with unknown attribute `state` defaults to Visible without warning

**Where:** `crates/ql-io-xlsx/src/read/workbook_xml.rs:239-244`.

```rust
state = match v.as_ref() {
    "hidden" => SheetState::Hidden,
    "veryHidden" => SheetState::VeryHidden,
    _ => SheetState::Visible,
};
```

`state="garbage"` silently maps to Visible. This is data-integrity
not security but it's the canonical "match-anything-else-as-default"
pattern that loses information from the source. Bonus: the engine
doesn't currently consume `SheetState` (it's read but discarded
during the calamine grid load) so the discrepancy isn't visible
yet — but it WILL be when sheet visibility lands.

**Fix:** return an explicit "unknown state" warning to `report.warnings`.

---

### M-3. Custom format code `formatCode=""` (empty string) is silently dropped

**Where:** `crates/ql-io-xlsx/src/read/styles_xml.rs:173-179`.

```rust
if format_code.is_empty() {
    return None;
}
```

An xlsx that registers a custom id with an EMPTY format string is
silently dropped — but downstream cells with `<c s="N">` referencing
that id still get xf-indexed by `lib.rs:199`, lookup the cellXf, and
discover its `num_fmt_id == 164` (custom). The format table
DOESN'T have an entry at 164. `format_overlay.set(row, col,
FormatId(164))` writes the format id without confirming registration.

Result: workbook has a `format_overlay` entry pointing at a
NONEXISTENT format id. Lookups return None; the runtime treats it
as General; round-trip emits `<c s="N">` referencing an absent xf.

Empirical:
```
PROBE empty_format_code: ok=true
```

**Fix:** if a cell's xf.num_fmt_id ≥ 164 but the FormatTable has no
entry, `lib.rs:199` should warn (Permissive) or error (Strict)
instead of writing the dangling reference.

---

### M-4. `<cellXfs count="999">` with fewer children leaves out-of-range references to silently fall back to General

**Where:** `crates/ql-io-xlsx/src/lib.rs:199-201`.

```rust
let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
    continue;
};
```

A cell `<c s="50">` referencing xf index 50 in a workbook whose
`<cellXfs>` only has 1 entry silently SKIPS the overlay write. The
cell renders as General — even though OOXML said it should have a
specific format. This is silent data loss.

```
PROBE cellxfs_count_mismatch: true   // accepted, format silently lost
```

**Fix:** emit a warning (Permissive) / error (Strict) on out-of-range
xf index. This is the dual of M-3 (dangling FormatId) — both forms
of "the OOXML xlsx is internally inconsistent" should surface, not
silently apply General.

---

### M-5. `<workbook>` without xmlns silently accepted; parser is namespace-tolerant in a way OOXML isn't

**Where:** `crates/ql-io-xlsx/src/read/workbook_xml.rs:128`, etc.
quick-xml's `local_name()` strips namespace prefixes blindly, so a
`<workbook>` (no xmlns) parses identically to a properly-namespaced
one. Real Excel rejects such files.

```
PROBE no_namespace: ok=true
```

**Why MEDIUM not HIGH:** the consequence is "we accept files Excel
won't open" — annoying but not corrupting. Worth a warning for
fidelity-conscious callers.

**Fix:** in `parse_workbook_xml`, after the root element is seen,
assert the spreadsheetml namespace is declared (`xmlns` or via a
prefix that resolves to it).

---

### M-6. Defined name target sheet doesn't exist → silent drop without warning

**Where:** `crates/ql-io-xlsx/src/read/names_import.rs:43-67`.

`parse_name_target` returns None for an unknown sheet; the caller
then registers `NamedTarget::Formula(raw_text)` as fallback, which
the binder will re-parse at use site. But if the raw text is
unparseable too (e.g. `Unknown!$A$1` where Unknown was deleted),
the FORMULA-mode binder will surface `#NAME!`. That's a runtime
error, not an import error. The user-visible signal is "my named
range silently became #NAME!" with no breadcrumb to the missing
sheet.

```
PROBE definedname_unknown_sheet: true    // accepted
```

**Fix:** emit a warning to `report.warnings` if `parse_name_target`
falls through to the Formula path.

---

### M-7. `XlsxPackage::list_parts_with_prefix("")` enumerates EVERY zip entry — used by feature inventory; cost is O(entries) on every call

**Where:** `crates/ql-io-xlsx/src/read/feature_inventory.rs:49`, plus
the multiple subsequent `list_parts_with_prefix("xl/worksheets/sheet")`
and per-part `read_part_string` calls.

Combined with H-5, an attacker can build a package whose central
directory enumerates 100K virtual parts (zip allows). Each one of
our enumerations is O(N) over the directory and re-opens the
archive. Total cost approaches O(N²) for a single import.

**Fix:** cap entry count + cache the archive (as in H-5 fix).

---

### M-8. Format-overlay `set` returns the prior `FormatId` but the import loop discards it; duplicate `<c r="A1" s="3"/>` and `<c r="A1" s="5"/>` silently last-write-wins

**Where:** `crates/ql-io-xlsx/src/lib.rs:211`.

```rust
sheet.format_overlay_mut().set(row, col, fmt_id);
```

If the same cell appears twice in worksheet xml (malformed but
possible — quick-xml doesn't enforce uniqueness), the second wins
silently. Excel would reject the file. We accept and silently apply
last-write.

**Fix:** check the return of `.set(row, col, fmt_id)`. If Some(_) on
the same cell, warn (duplicate cell reference).

---

### M-9. `update_original` overwrites the user's destination file when shadow export succeeds but post-process fails

**Where:** `crates/ql-io-xlsx/src/write/update_original.rs:50-230`.

The shadow export goes to `sibling_tmp_path` (good). But step 1 at
line 52 calls `export_new_workbook(workbook, &shadow_path, ...)` which
INTERNALLY writes to `shadow_path` and then post-processes by reading
+ rewriting `shadow_path`. If post_process_zip fails after the umya
write but before the rewrite, the shadow file is left in a
half-baked state.

That's contained (the shadow path is ours). But then `update_original.rs:230`
calls `std::fs::write(output_path, out_buf)` non-atomically. If the
write fails partway (disk full, signal), the user's destination is
truncated.

The W5-D-14.2.2 H-B closure moved the error check BEFORE the write —
so under `Strict` mode the destination is preserved if there are
dropped features. But under disk-write failure mid-stream, the
destination can still be truncated.

**Fix:** atomic-rename pattern (also addresses H-6).

---

### M-10. `parse_a1_cell` accepts `BCD$1` (the `$` was stripped but the function silently does that)

**Where:** `crates/ql-io-xlsx/src/read/names_import.rs:168-191`.

```rust
let stripped: String = text.chars().filter(|c| *c != '$').collect();
```

Removes ALL `$` characters from the text. A defined-name target
`A$B$1` parses successfully — but it's not a legal Excel cell ref
(absolute markers must be at specific positions). We silently
accept it. Round-trip emits a different string than the input.

**Fix:** validate `$` positions explicitly (at most one before each
of letters and digits).

---

### M-11. `XlsxPreservation` known_parts is constructed empty and never populated; `UpdateOriginal` reads raw original bytes every export

**Where:** `crates/ql-io-xlsx/src/lib.rs:276-281`.

```rust
let preservation = if options.preserve_package {
    Some(XlsxPreservation {
        original_bytes: bytes.to_vec(),
        known_parts: std::collections::HashMap::new(),  // <-- always empty
    })
} else {
    None
};
```

The `known_parts` field exists but is never populated and never
consulted by the `update_original` writer (which does its own zip
walk). Dead state shape — confusing for future maintainers, no
defensive behavior intended. Either remove the field or document its
intended purpose.

---

## LOW

### L-1. Calamine error messages are stringified into `XlsxError::Calamine(String)` losing the structured underlying error

**Where:** `crates/ql-io-xlsx/src/error.rs:27-28` and
`crates/ql-io-xlsx/src/read/calamine_grid.rs:52`.

Strict-mode callers that want to programmatically check for "is this a
recognizable malformed-ooxml subset or a complete parse failure" can
only string-match. Acceptable for v1 but worth noting.

---

### L-2. Sheet name allowed to be longer than Excel's 31-character limit

**Where:** `crates/ql-io-xlsx/src/read/convert.rs:33-50`.

Excel UI enforces a 31-character cap on sheet names. Quantbook's
`Workbook::add_sheet` doesn't (verified via the no-bound on
`name.is_empty()` path). A 4000-character sheet name imports OK.
Excel won't open the round-trip.

---

### L-3. `formula_text` in defined name is unescaped via `unescape().unwrap_or_default()` — XML escape failures silently become empty strings

**Where:** `crates/ql-io-xlsx/src/read/workbook_xml.rs:188`.

```rust
builder.formula_text.push_str(&t.unescape().unwrap_or_default());
```

A malformed entity in the formula text (e.g. `&unknown;`) silently
truncates the formula. The cell-export side will write empty string.

**Fix:** propagate the unescape error as `XlsxError::XmlParse`.

---

### L-4. `parse_totals_function` accepts `countNums` AND `countnums` but rejects `countNums` with different casing patterns

**Where:** `crates/ql-io-xlsx/src/read/tables_xml.rs:248-249`.

```rust
"countNums" | "countnums" => Some(TotalsFunction::CountNums),
```

The match is on the lowercase via `to_ascii_lowercase()` — but the
arm patterns are case-specific. The `"countNums"` arm is dead code
(it's never reached because the input is already lowercased).
Doesn't affect correctness; tidy-up only.

---

### L-5. Update-original drops `xl/calcChain.xml` silently; never tells the report it did

**Where:** `crates/ql-io-xlsx/src/write/update_original.rs:349-352`.

```rust
if name == "xl/calcChain.xml" {
    return PartAction::DropSilently;
}
```

calcChain is regenerated by Excel on first open, so dropping is the
right call. But under Strict mode, a "strict means no-loss" caller
could reasonably expect this to surface. Document or downgrade
DropSilently → DropAsUnsupported(Other("calc-chain")).

---

### L-6. `inject_*` post-process functions use `text.replace(needle, replacement)` which replaces ALL occurrences globally — could over-replace if the needle appears in a cell value

**Where:** `crates/ql-io-xlsx/src/write/umya_export.rs:474-512`
(RemoveStrType, OverrideErrorSigil, SetStyle cases).

Example: a cell value of literal text `<c r="A1" t="str"` (someone
pasted XML into a cell) gets matched by the RemoveStrType needle.
umya XML-escapes cell text content, so this is unlikely in practice —
but it's a string-replace approach to XML mutation that's
fundamentally not XML-aware. The W5-D-15.2 commit's HIGH-4 fix
moved one case to a needle-anchored replace; other cases still use
`text.replace`.

**Fix:** ideally route through a real XML rewriter (quick-xml roundtrip).
Pragmatic fix: anchor each needle on uniqueness markers (full cell
opening tag with closing `"`).

---

### L-7. `update_original.rs::merge_content_types` does substring-based `<Override>` extraction; comments containing fake `<Override` tags are mis-parsed

**Where:** `crates/ql-io-xlsx/src/write/update_original.rs:475-525`
(`iterate_simple_self_closing`).

If an original `[Content_Types].xml` has an XML comment with content
like `<!-- example: <Override PartName="..."/> -->`, the substring
scanner treats it as a real entry. Real-world Content_Types.xml don't
contain comments, but this is a quietly-fragile assumption that
deserves a note.

---

### L-8. `XlsxPackage::list_parts_with_prefix` returns directory entries (zero-byte zip entries with trailing `/`) as parts

**Where:** `crates/ql-io-xlsx/src/read/package.rs:57-69`.

A zip with explicit directory entries (some compressors emit them as
`xl/worksheets/` as a zero-byte entry) ends up in the prefix walk.
Feature inventory then tries to scan it as a file path → no-op
because there's no payload, but cycle waste and one more line in any
reported part listing.

---

### L-9. `looks_like_cell_ref` only checks ASCII alphabetics; `A١` (with Arabic-Indic digit 1) bypasses the quoting heuristic

**Where:** `crates/ql-io-xlsx/src/write/umya_export.rs:973-990`.

A sheet named `A١` (latin A + Arabic-Indic 1) isn't ASCII-numeric so
the quote check passes, but Excel still parses `A١!B2` ambiguously
in some locales. Edge case — likely irrelevant for now but worth a
TODO for full Unicode-aware quoting.

---

## Summary of severity

| Severity | Count | Notes |
| --- | --- | --- |
| HIGH | 8 | One unfixed panic (H-1), one unfixed silent corruption (H-2 = M-6 from W5-D-15.2), one unfixed path-traversal acceptance (H-3), four unfixed defensive-validation gaps (H-4, H-7, H-8 about boundary contract; H-5 about resource exhaustion), one unfixed concurrency race (H-6). |
| MEDIUM | 11 | Almost all are "silent data drop" patterns. None panic. |
| LOW | 9 | Hygiene, dead code, comment-pedantics. |

**Total: 28 findings.**

The most-impactful single fix: making H-1 (numFmtId overflow panic) into
a typed error. That removes the only deterministic-panic surface
reachable from xlsx bytes alone.

The most-load-bearing class: silent acceptance of structurally-invalid
inputs (H-3, H-4, H-7, H-8, M-3, M-4, M-6) — these all violate the
no-fallbacks rule documented in CLAUDE.md ("errors must be visible").
Each silently accepts a state the engine isn't equipped to handle and
will surface as an inscrutable downstream failure (crash on round-trip,
silently-dropped data, runtime `#NAME!`) far from the import boundary.

The fix recipe across this class: every `unwrap_or_default()` and
`.parse().ok()` in the import path is a candidate for either a
`report.warnings` push or a `XlsxError::MalformedOoxml` return,
depending on `UnsupportedPolicy`. The engine's `Permissive` default
already gives users a tolerant path; what's missing is the BREADCRUMB
trail so users running with `Strict` (or just reading `report.warnings`
afterward) can know what was lost.
