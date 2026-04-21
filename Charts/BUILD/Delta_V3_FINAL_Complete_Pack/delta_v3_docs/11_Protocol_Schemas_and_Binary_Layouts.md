# Protocol Schemas and Binary Layouts (V3 Add‑On)
**Purpose:** This document defines the **wire format** between threads/runtimes for Delta V3:
- JSON schemas (for control & small messages)
- Binary packet formats (for large/high‑frequency payloads)
- SharedArrayBuffer (SAB) ring layouts (Turbo mode)
- Versioning, alignment, and correctness invariants

> Design goal: **deterministic, debuggable, backward‑compatible protocols** with low overhead.

---

## 0) Normative rules (apply to everything)

### 0.1 Endianness and numeric representation
- All binary fields are **little‑endian**.
- `f32`/`f64` are IEEE‑754.
- Integers are two’s complement.
- Timestamps use `u64` milliseconds where possible; otherwise `f64` ms.

### 0.2 Alignment rules
- All record headers are aligned to **16 bytes**.
- Payload alignment:
  - numeric arrays aligned to their element size (4 or 8 bytes)
  - the start of each array is aligned to 16 bytes whenever possible (faster views)

### 0.3 Versioning rule
- Every message has:
  - `protocolVersion` (u16)
  - `msgType` (u16)
  - `seq` (u32 monotonically increasing per channel)
- Unknown `msgType` must be **ignored** (forward compatibility).
- Unknown fields in JSON must be **ignored** (tolerate future expansion).

### 0.4 Security rule (no dynamic code)
- Never transmit executable code.
- Indicator definitions (future) must be data-only (AST/IR), validated, and sandboxed.

---

## 1) Message Type Registry

### 1.1 Type codes (u16)
Reserve ranges so we can extend safely.

| Range | Category |
|---:|---|
| 0x0001–0x00FF | Lifecycle / Control |
| 0x0100–0x01FF | Input |
| 0x0200–0x02FF | Viewport / Theme |
| 0x0300–0x03FF | Data (series, LOD, envelopes) |
| 0x0400–0x04FF | Overlays / Drawings |
| 0x0500–0x05FF | Diagnostics / Telemetry |

### 1.2 Canonical set (initial)
**Lifecycle/Control**
- `0x0001 INIT_RENDERER`
- `0x0002 INIT_OK`
- `0x0003 INIT_FAIL`
- `0x0004 DESTROY`
- `0x0005 SET_TIER`
- `0x0006 SET_CONFIG`

**Input**
- `0x0100 INPUT_STATE` (message mode only; SAB uses shared struct)

**Viewport/Theme**
- `0x0200 SET_VIEWPORT`
- `0x0201 SET_THEME`

**Data**
- `0x0300 SET_SERIES_SCHEMA`
- `0x0301 SET_SERIES_CHUNK`
- `0x0302 APPEND_TICKS`
- `0x0303 SET_LOD_CHUNK`
- `0x0304 SET_ENVELOPE_CHUNK`
- `0x0305 SET_INDICATOR_RESULT_CHUNK`

**Overlays/Drawings**
- `0x0400 OVERLAY_BULK_SET`
- `0x0401 OVERLAY_ADD`
- `0x0402 OVERLAY_UPDATE`
- `0x0403 OVERLAY_REMOVE`

**Diagnostics**
- `0x0500 STATS_FRAME`
- `0x0501 ERROR_EVENT`
- `0x0502 DEBUG_SNAPSHOT`

---

## 2) JSON Schemas (control plane)

JSON is acceptable for:
- small control messages
- configuration and theming
- debug and diagnostics
- low frequency changes

### 2.1 Common envelope schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://delta.example/schema/msg-envelope.json",
  "type": "object",
  "required": ["protocolVersion", "msgType", "seq", "tMs", "payload"],
  "properties": {
    "protocolVersion": { "type": "integer", "minimum": 1, "maximum": 65535 },
    "msgType": { "type": "integer", "minimum": 1, "maximum": 65535 },
    "seq": { "type": "integer", "minimum": 0, "maximum": 4294967295 },
    "tMs": { "type": "number" },
    "payload": { "type": "object" }
  },
  "additionalProperties": false
}
```

### 2.2 `SET_TIER` payload schema
```json
{
  "$id": "https://delta.example/schema/set-tier.json",
  "type": "object",
  "required": ["tier", "reason"],
  "properties": {
    "tier": { "type": "string", "enum": ["A", "B", "C", "D"] },
    "reason": { "type": "string" },
    "qualityProfile": {
      "type": "object",
      "properties": {
        "tileSizePx": { "type": "integer", "enum": [256, 512] },
        "maxEffectiveDpr": { "type": "number", "minimum": 1.0, "maximum": 3.0 },
        "enableMsaa": { "type": "boolean" },
        "tileBudgetMB": { "type": "number", "minimum": 16, "maximum": 1024 },
        "atlasBudgetMB": { "type": "number", "minimum": 8, "maximum": 256 },
        "dynamicBufferBudgetMB": { "type": "number", "minimum": 8, "maximum": 512 }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": false
}
```

### 2.3 `SET_THEME` payload schema (tokenized)
```json
{
  "$id": "https://delta.example/schema/set-theme.json",
  "type": "object",
  "required": ["themeRev", "tokens"],
  "properties": {
    "themeRev": { "type": "integer", "minimum": 0 },
    "tokens": {
      "type": "object",
      "properties": {
        "bg": { "type": "string" },
        "gridMajor": { "type": "string" },
        "gridMinor": { "type": "string" },
        "text": { "type": "string" },
        "upCandle": { "type": "string" },
        "downCandle": { "type": "string" },
        "crosshair": { "type": "string" }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": false
}
```

### 2.4 `SET_VIEWPORT` payload schema
```json
{
  "$id": "https://delta.example/schema/set-viewport.json",
  "type": "object",
  "required": ["cssW", "cssH", "pxW", "pxH", "dpr", "scrollX", "scrollY"],
  "properties": {
    "cssW": { "type": "number" },
    "cssH": { "type": "number" },
    "pxW": { "type": "integer" },
    "pxH": { "type": "integer" },
    "dpr": { "type": "number" },
    "scrollX": { "type": "number" },
    "scrollY": { "type": "number" }
  },
  "additionalProperties": false
}
```

> Note: data messages are binary by default (next sections). JSON is still allowed for tiny debug payloads.

---

## 3) Binary Packet Format (Compat message mode)

### 3.1 Why binary?
- reduces overhead for large series chunks and frequent updates
- avoids JSON parse cost
- enables zero-copy views into payload regions

### 3.2 Packet framing
We transmit an `ArrayBuffer` with a fixed header and variable payload.

#### Header layout (32 bytes)
| Offset | Size | Type | Name | Notes |
|---:|---:|---|---|---|
| 0 | 4 | u32 | magic | `0x444C5441` ("DLTA") |
| 4 | 2 | u16 | protocolVersion | start at 1 |
| 6 | 2 | u16 | msgType | registry |
| 8 | 4 | u32 | seq | monotonic per channel |
| 12 | 4 | u32 | flags | bitmask |
| 16 | 8 | f64 | tMs | sender timestamp |
| 24 | 4 | u32 | payloadBytes | bytes after header |
| 28 | 4 | u32 | headerCrc32 | optional; 0 if unused |

Payload begins at offset 32 and must be aligned to 16 bytes (pad if needed).

#### Flags (u32)
- bit 0: `PAYLOAD_IS_JSON` (payload bytes = UTF-8)
- bit 1: `PAYLOAD_IS_BINARY_STRUCT`
- bit 2: `COMPRESSED_LZ4` (optional future)
- bit 3: `HAS_OFFSETS_TABLE`

### 3.3 Offsets table (optional)
For complex payloads, include a small offsets table at the start of payload:

| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 2 | u16 | nSections |
| 2 | 2 | u16 | reserved |
| 4 | 8*n | u32,u32 | sectionOffset, sectionLength | repeated |

This makes payload self-describing and allows O(1) access to arrays.

---

## 4) Series chunk binary payloads

### 4.1 Canonical OHLCV chunk payload (columnar)
We pack arrays back-to-back with an offsets table.

#### Section IDs (u16)
- 1: `time_f64`  (or time_u32_hi/lo)
- 2: `open_f32`
- 3: `high_f32`
- 4: `low_f32`
- 5: `close_f32`
- 6: `volume_f32` (optional)

#### Payload header (fixed 48 bytes)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 8 | u64 | seriesId |
| 8 | 8 | u64 | chunkId |
| 16 | 8 | u64 | timeStartMs |
| 24 | 8 | u64 | timeEndMs |
| 32 | 4 | u32 | n |
| 36 | 4 | u32 | schemaRev |
| 40 | 4 | u32 | dataRev |
| 44 | 4 | u32 | reserved |

Then offsets table, then array bytes.

**Array lengths**
- `time_f64`: `n*8`
- `open/high/low/close`: `n*4` each
- `volume`: `n*4` if present

**Alignment**
- start each array at 16-byte boundary (pad between arrays as needed)

### 4.2 Append ticks payload
Ticks are usually small but frequent; keep them binary too.

Payload header (32 bytes):
- `seriesId u64`
- `n u32`
- `flags u32` (e.g., “already aggregated into bars”)
- `reserved u64`

Then `n` tick records (16 bytes each):
- `timeMs u64`
- `price f32`
- `size f32`

---

## 5) Envelope chunk payloads (Stage 0 silhouette)

Stage 0 requires min/max per pixel column, not per bar.

Payload:
- `paneId u32`
- `lodLevel u32`
- `x0Px u32` (start pixel column, in physical pixels)
- `nCols u32`
- then arrays:
  - `min_f32[nCols]`
  - `max_f32[nCols]`

Optional:
- `open/close` envelope for better silhouette (future)

---

## 6) Overlay/drawing payloads

Two encodings are supported:

### 6.1 JSON overlay encoding (simple, low volume)
Good for:
- small numbers of drawings
- initial MVP

Example overlay object:
```json
{
  "id": "uuid",
  "type": "trend_line",
  "paneId": 0,
  "points": [{"t": 1700000000000, "p": 123.45}, {"t": 1700003600000, "p": 130.10}],
  "style": {"color": "#ff0", "width": 1, "dash": "solid"},
  "rev": 12
}
```

### 6.2 Binary overlay encoding (high volume)
Recommended once drawings scale.

Binary overlay record:
- `u64 idHi`
- `u64 idLo` (UUID split)
- `u16 type`
- `u16 flags`
- `u32 paneId`
- `u32 nPoints`
- `u32 styleRef` (index into style table)
- followed by points array:
  - point = `{ timeMs u64, price f32, pad u32 }` (16 bytes)

Style table can be a separate message (`OVERLAY_STYLE_TABLE`) or embedded.

---

## 7) SharedArrayBuffer (Turbo) layout

Turbo mode uses SAB for:
- high-frequency input state
- optional ring buffer for large messages

### 7.1 Shared InputState struct (fast lane)
We use a dedicated shared struct for latest input (not a ring).

Layout (example, 64 bytes):
| Offset | Type | Name |
|---:|---|---|
| 0 | i32 | seq |
| 4 | f32 | xCss |
| 8 | f32 | yCss |
| 12 | i32 | buttons |
| 16 | i32 | mods |
| 20 | f32 | wheelDx |
| 24 | f32 | wheelDy |
| 28 | f32 | pinchScale |
| 32 | f32 | pinchCxCss |
| 36 | f32 | pinchCyCss |
| 40 | i32 | pointerId |
| 44 | i32 | inBounds |
| 48 | f64 | tMs |
| 56 | i32 | kind |
| 60 | i32 | reserved |

**Write protocol (main thread):**
1. write all fields except `seq`
2. `Atomics.store(seq, seq+1)` last

**Read protocol (renderer):**
1. read `seq0`
2. read fields
3. read `seq1`
4. accept only if `seq0 == seq1` (no torn read)

### 7.2 SAB ring (optional for data messages)
Use for large streams if needed, but start with message transport for data unless proven necessary.

Control block:
- `head i32`, `tail i32`, `capacity i32`, `reserved i32`

Record header (16 bytes aligned):
- `u16 msgType`
- `u16 flags`
- `u32 seq`
- `u32 payloadBytes`
- `u32 reserved`

Producer writes payload then header, updates tail atomically.
Consumer reads header, processes payload, updates head atomically.

---

## 8) Validation and testing

### 8.1 Protocol fuzzing
- random message reorder/drops in message mode
- ring wraparound stress tests in SAB mode
- invalid/unknown msg types ignored safely

### 8.2 Soak tests
- high-frequency input writes for 30+ minutes
- streaming ticks bursts
- repeated init/destroy cycles

### 8.3 Golden decode tests
- encode sample chunks → decode → verify arrays equal
- verify alignment constraints (array start offsets are correct)

---

## 9) Implementation checklist
- [ ] Define msgType constants in a single shared module
- [ ] Build binary encoder/decoder utilities with strict validation
- [ ] Add schema versioning + migration hooks (optional future)
- [ ] Add debug “wiretap” to dump last N messages for diagnosis
