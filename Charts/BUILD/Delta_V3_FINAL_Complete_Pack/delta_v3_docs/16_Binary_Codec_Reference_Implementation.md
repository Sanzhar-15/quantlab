# Binary Codec Reference Implementation (V3 Add‑On)
**Purpose:** A concrete reference for implementing Delta V3’s binary protocol encoder/decoder in TypeScript.

This doc provides:
- exact `DataView` offsets for the **packet header**
- helper utilities (alignment, u64)
- reference encode/decode for:
  - `SET_SERIES_CHUNK`
  - `APPEND_TICKS`
  - `SET_ENVELOPE_CHUNK`
- how to create **zero‑copy typed-array views** into the payload

> Goal: make the codec **deterministic, fast, and testable**.

---

## 0) Design rules (normative)

1. **Little-endian** for all integer/float fields.
2. **Header is fixed 32 bytes**.
3. Payload begins immediately after header (offset 32) and should be **16‑byte aligned**.
4. Arrays in payload must start at **16‑byte aligned offsets** (pad as needed).
5. Decode should avoid copying: return typed array *views* into the received `ArrayBuffer`.
6. For u64 fields, use `bigint` via `DataView.getBigUint64` / `setBigUint64` where supported.
   - If you must support environments without these APIs, use `{hi:u32, lo:u32}` helpers.

---

## 1) Packet header layout (32 bytes)

### 1.1 Header fields (fixed)
| Offset | Size | Type | Name | Notes |
|---:|---:|---|---|---|
| 0  | 4 | u32 | `magic` | `0x444C5441` (“DLTA”) |
| 4  | 2 | u16 | `protocolVersion` | start at `1` |
| 6  | 2 | u16 | `msgType` | registry code |
| 8  | 4 | u32 | `seq` | monotonic per channel |
| 12 | 4 | u32 | `flags` | bitmask |
| 16 | 8 | f64 | `tMs` | sender time `performance.now()` |
| 24 | 4 | u32 | `payloadBytes` | length after header |
| 28 | 4 | u32 | `headerCrc32` | optional; `0` if unused |

### 1.2 Constants
```ts
export const MAGIC_DLTA = 0x444C5441; // "DLTA"
export const HEADER_SIZE = 32;
export const PROTOCOL_VERSION = 1;
```

### 1.3 Header flags (u32)
```ts
export const FLAG_PAYLOAD_IS_JSON        = 1 << 0;
export const FLAG_PAYLOAD_IS_BINARY      = 1 << 1;
export const FLAG_HAS_OFFSETS_TABLE      = 1 << 2;
export const FLAG_COMPRESSED_LZ4         = 1 << 3; // reserved future
export const FLAG_APPENDTICKS_SOA        = 1 << 8; // APPEND_TICKS encoding choice
```

---

## 2) DataView helpers

### 2.1 Alignment
```ts
export function align16(n: number): number {
  return (n + 15) & ~15;
}
```

### 2.2 u64 helpers
```ts
export function getU64(view: DataView, byteOffset: number): bigint {
  // Requires BigInt support; modern browsers support this.
  return view.getBigUint64(byteOffset, true);
}

export function setU64(view: DataView, byteOffset: number, v: bigint): void {
  view.setBigUint64(byteOffset, v, true);
}
```

Fallback (if needed):
```ts
export function getU64hiLo(view: DataView, off: number): {hi: number; lo: number} {
  const lo = view.getUint32(off, true);
  const hi = view.getUint32(off + 4, true);
  return {hi, lo};
}
export function setU64hiLo(view: DataView, off: number, hi: number, lo: number): void {
  view.setUint32(off, lo >>> 0, true);
  view.setUint32(off + 4, hi >>> 0, true);
}
```

### 2.3 Header encode/decode
```ts
export type PacketHeader = {
  magic: number;
  protocolVersion: number;
  msgType: number;
  seq: number;
  flags: number;
  tMs: number;
  payloadBytes: number;
  headerCrc32: number;
};

export function writeHeader(view: DataView, h: PacketHeader): void {
  view.setUint32(0, h.magic >>> 0, true);
  view.setUint16(4, h.protocolVersion & 0xffff, true);
  view.setUint16(6, h.msgType & 0xffff, true);
  view.setUint32(8, h.seq >>> 0, true);
  view.setUint32(12, h.flags >>> 0, true);
  view.setFloat64(16, h.tMs, true);
  view.setUint32(24, h.payloadBytes >>> 0, true);
  view.setUint32(28, h.headerCrc32 >>> 0, true);
}

export function readHeader(view: DataView): PacketHeader {
  return {
    magic: view.getUint32(0, true),
    protocolVersion: view.getUint16(4, true),
    msgType: view.getUint16(6, true),
    seq: view.getUint32(8, true),
    flags: view.getUint32(12, true),
    tMs: view.getFloat64(16, true),
    payloadBytes: view.getUint32(24, true),
    headerCrc32: view.getUint32(28, true),
  };
}
```

### 2.4 Packet wrapper helpers
```ts
export function makePacketBuffer(payloadBytes: number): ArrayBuffer {
  const total = HEADER_SIZE + payloadBytes;
  return new ArrayBuffer(total);
}

export function packetPayloadView(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf, HEADER_SIZE);
}
```

---

## 3) Offsets table layout (recommended)

We recommend a small table so payload can contain multiple arrays without hardcoding offsets.

### 3.1 Offsets table header (16 bytes)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 2 | u16 | `nSections` |
| 2 | 2 | u16 | reserved |
| 4 | 4 | u32 | `tableBytes` |
| 8 | 8 | u64 | reserved |

### 3.2 Section entry (16 bytes each)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 2 | u16 | `sectionId` |
| 2 | 2 | u16 | reserved |
| 4 | 4 | u32 | `byteOffset` | from *payload start* (not whole packet) |
| 8 | 4 | u32 | `byteLength` |
| 12 | 4 | u32 | reserved |

### 3.3 Code helpers
```ts
export type SectionDesc = { sectionId: number; byteOffset: number; byteLength: number };

export function writeOffsetsTable(
  view: DataView,
  tableOffset: number,
  sections: SectionDesc[]
): number /*tableBytes*/ {
  const n = sections.length;
  const tableBytes = 16 + n * 16;
  view.setUint16(tableOffset + 0, n, true);
  view.setUint16(tableOffset + 2, 0, true);
  view.setUint32(tableOffset + 4, tableBytes, true);
  // reserved u64 at +8 left as 0

  let off = tableOffset + 16;
  for (const s of sections) {
    view.setUint16(off + 0, s.sectionId & 0xffff, true);
    view.setUint16(off + 2, 0, true);
    view.setUint32(off + 4, s.byteOffset >>> 0, true);
    view.setUint32(off + 8, s.byteLength >>> 0, true);
    view.setUint32(off + 12, 0, true);
    off += 16;
  }
  return tableBytes;
}

export function readOffsetsTable(view: DataView, tableOffset: number): SectionDesc[] {
  const n = view.getUint16(tableOffset + 0, true);
  const tableBytes = view.getUint32(tableOffset + 4, true);
  const out: SectionDesc[] = [];
  let off = tableOffset + 16;
  for (let i = 0; i < n; i++) {
    out.push({
      sectionId: view.getUint16(off + 0, true),
      byteOffset: view.getUint32(off + 4, true),
      byteLength: view.getUint32(off + 8, true),
    });
    off += 16;
  }
  // tableBytes can be used to locate the array region if needed
  return out;
}
```

---

## 4) `SET_SERIES_CHUNK` payload codec

### 4.1 `SET_SERIES_CHUNK` payload header (48 bytes)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0  | 8 | u64 | `seriesId` |
| 8  | 8 | u64 | `chunkId` |
| 16 | 8 | u64 | `timeStartMs` |
| 24 | 8 | u64 | `timeEndMs` |
| 32 | 4 | u32 | `n` |
| 36 | 4 | u32 | `schemaRev` |
| 40 | 4 | u32 | `dataRev` |
| 44 | 4 | u32 | reserved |

Payload layout:
- 48 bytes header
- 16-byte aligned offsets table
- 16-byte aligned arrays

### 4.2 Section IDs (canonical)
```ts
export const SEC_TIME_F64  = 1;
export const SEC_OPEN_F32  = 2;
export const SEC_HIGH_F32  = 3;
export const SEC_LOW_F32   = 4;
export const SEC_CLOSE_F32 = 5;
export const SEC_VOL_F32   = 6; // optional
```

### 4.3 Encoder (zero-copy friendly: copies arrays once into packet)
```ts
export type SeriesChunk = {
  seriesId: bigint;
  chunkId: bigint;
  timeStartMs: bigint;
  timeEndMs: bigint;
  schemaRev: number;
  dataRev: number;
  time: Float64Array;
  open: Float32Array;
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  volume?: Float32Array;
};

export function encodeSeriesChunk(msgType: number, seq: number, chunk: SeriesChunk): ArrayBuffer {
  const n = chunk.time.length;
  if (chunk.open.length !== n || chunk.high.length !== n || chunk.low.length !== n || chunk.close.length !== n) {
    throw new Error("SeriesChunk arrays must have same length");
  }
  if (chunk.volume && chunk.volume.length !== n) throw new Error("volume length mismatch");

  const payloadHeaderBytes = 48;
  const nSections = chunk.volume ? 6 : 5;
  const offsetsTableBytes = 16 + nSections * 16;

  // Compute array region start (payload-relative)
  let cursor = align16(payloadHeaderBytes + offsetsTableBytes);

  const sections: SectionDesc[] = [];
  const pushSection = (sectionId: number, byteLength: number) => {
    const off = cursor;
    sections.push({ sectionId, byteOffset: off, byteLength });
    cursor = align16(cursor + byteLength);
  };

  pushSection(SEC_TIME_F64,  n * 8);
  pushSection(SEC_OPEN_F32,  n * 4);
  pushSection(SEC_HIGH_F32,  n * 4);
  pushSection(SEC_LOW_F32,   n * 4);
  pushSection(SEC_CLOSE_F32, n * 4);
  if (chunk.volume) pushSection(SEC_VOL_F32, n * 4);

  const payloadBytes = cursor; // cursor is already payload-relative end (aligned)
  const buf = makePacketBuffer(payloadBytes);
  const view = new DataView(buf);

  // Header
  writeHeader(view, {
    magic: MAGIC_DLTA,
    protocolVersion: PROTOCOL_VERSION,
    msgType,
    seq,
    flags: FLAG_PAYLOAD_IS_BINARY | FLAG_HAS_OFFSETS_TABLE,
    tMs: performance.now(),
    payloadBytes,
    headerCrc32: 0,
  });

  const payloadBase = HEADER_SIZE;

  // Payload header
  setU64(view, payloadBase + 0,  chunk.seriesId);
  setU64(view, payloadBase + 8,  chunk.chunkId);
  setU64(view, payloadBase + 16, chunk.timeStartMs);
  setU64(view, payloadBase + 24, chunk.timeEndMs);
  view.setUint32(payloadBase + 32, n >>> 0, true);
  view.setUint32(payloadBase + 36, chunk.schemaRev >>> 0, true);
  view.setUint32(payloadBase + 40, chunk.dataRev >>> 0, true);
  view.setUint32(payloadBase + 44, 0, true);

  // Offsets table
  const tableOffset = payloadBase + payloadHeaderBytes;
  writeOffsetsTable(view, tableOffset, sections);

  // Copy arrays into packet (payload-relative offsets)
  const u8 = new Uint8Array(buf);

  const copyArray = (src: ArrayBufferView, dstByteOffset: number) => {
    const srcU8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    u8.set(srcU8, HEADER_SIZE + dstByteOffset);
  };

  for (const s of sections) {
    switch (s.sectionId) {
      case SEC_TIME_F64:  copyArray(chunk.time,  s.byteOffset); break;
      case SEC_OPEN_F32:  copyArray(chunk.open,  s.byteOffset); break;
      case SEC_HIGH_F32:  copyArray(chunk.high,  s.byteOffset); break;
      case SEC_LOW_F32:   copyArray(chunk.low,   s.byteOffset); break;
      case SEC_CLOSE_F32: copyArray(chunk.close, s.byteOffset); break;
      case SEC_VOL_F32:
        if (!chunk.volume) throw new Error("SEC_VOL_F32 present without volume");
        copyArray(chunk.volume, s.byteOffset);
        break;
      default:
        throw new Error("Unknown section id");
    }
  }

  return buf;
}
```

### 4.4 Decoder (returns views; no copies)
```ts
export type DecodedSeriesChunk = {
  header: PacketHeader;
  seriesId: bigint;
  chunkId: bigint;
  timeStartMs: bigint;
  timeEndMs: bigint;
  n: number;
  schemaRev: number;
  dataRev: number;
  time: Float64Array;
  open: Float32Array;
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  volume?: Float32Array;
};

export function decodeSeriesChunk(buf: ArrayBuffer): DecodedSeriesChunk {
  const view = new DataView(buf);
  const header = readHeader(view);
  if (header.magic !== MAGIC_DLTA) throw new Error("Bad magic");
  if ((header.flags & FLAG_PAYLOAD_IS_BINARY) === 0) throw new Error("Not binary payload");

  const payloadBase = HEADER_SIZE;

  const seriesId    = getU64(view, payloadBase + 0);
  const chunkId     = getU64(view, payloadBase + 8);
  const timeStartMs = getU64(view, payloadBase + 16);
  const timeEndMs   = getU64(view, payloadBase + 24);
  const n           = view.getUint32(payloadBase + 32, true);
  const schemaRev   = view.getUint32(payloadBase + 36, true);
  const dataRev     = view.getUint32(payloadBase + 40, true);

  const tableOffset = payloadBase + 48;
  const sections = readOffsetsTable(view, tableOffset);

  const find = (id: number) => sections.find(s => s.sectionId === id);

  const timeSec  = find(SEC_TIME_F64)!;
  const openSec  = find(SEC_OPEN_F32)!;
  const highSec  = find(SEC_HIGH_F32)!;
  const lowSec   = find(SEC_LOW_F32)!;
  const closeSec = find(SEC_CLOSE_F32)!;
  const volSec   = find(SEC_VOL_F32);

  const time  = new Float64Array(buf, HEADER_SIZE + timeSec.byteOffset, n);
  const open  = new Float32Array(buf, HEADER_SIZE + openSec.byteOffset, n);
  const high  = new Float32Array(buf, HEADER_SIZE + highSec.byteOffset, n);
  const low   = new Float32Array(buf, HEADER_SIZE + lowSec.byteOffset, n);
  const close = new Float32Array(buf, HEADER_SIZE + closeSec.byteOffset, n);
  const volume = volSec ? new Float32Array(buf, HEADER_SIZE + volSec.byteOffset, n) : undefined;

  return { header, seriesId, chunkId, timeStartMs, timeEndMs, n, schemaRev, dataRev, time, open, high, low, close, volume };
}
```

---

## 5) `APPEND_TICKS` payload codec (two encodings)

We support two encodings:
- **AoS (array-of-structs)**: simple, good for small bursts
- **SoA (struct-of-arrays)**: better for GPU upload (no per-record loop)

### 5.1 Payload header (32 bytes)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0  | 8 | u64 | `seriesId` |
| 8  | 4 | u32 | `n` |
| 12 | 4 | u32 | `flags` |
| 16 | 8 | u64 | `tMin` (optional; 0 if unknown) |
| 24 | 8 | u64 | `tMax` (optional; 0 if unknown) |

### 5.2 AoS tick record (16 bytes each)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 8 | u64 | `timeMs` |
| 8 | 4 | f32 | `price` |
| 12 | 4 | f32 | `size` |

### 5.3 SoA sections (recommended for heavy streaming)
Section IDs:
- 1: time_u64 (stored as u64; or u32 hi/lo in future)
- 2: price_f32
- 3: size_f32

SoA payload contains offsets table + arrays.

### 5.4 Encoder skeleton
```ts
export type TickBatch = {
  seriesId: bigint;
  timeMs: BigUint64Array; // or bigint[]; choose representation you prefer
  price: Float32Array;
  size: Float32Array;
};

// Note: BigUint64Array exists in modern JS; if unavailable, use two u32 arrays.
```

**Recommendation:** adopt SoA for performance once streaming is a core workload; keep AoS for simplest MVP.

---

## 6) `SET_ENVELOPE_CHUNK` payload codec (Stage 0 silhouette)

### 6.1 Payload header (16 bytes)
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 4 | u32 | `paneId` |
| 4 | 4 | u32 | `lodLevel` |
| 8 | 4 | u32 | `x0Px` |
| 12 | 4 | u32 | `nCols` |

Then arrays:
- `min_f32[nCols]`
- `max_f32[nCols]`

### 6.2 Encoder (simple)
```ts
export function encodeEnvelopeChunk(msgType: number, seq: number, paneId: number, lodLevel: number, x0Px: number, min: Float32Array, max: Float32Array): ArrayBuffer {
  if (min.length !== max.length) throw new Error("min/max length mismatch");
  const nCols = min.length;

  const payloadHeaderBytes = 16;
  let cursor = align16(payloadHeaderBytes);
  const minOff = cursor; cursor = align16(cursor + nCols * 4);
  const maxOff = cursor; cursor = align16(cursor + nCols * 4);

  const payloadBytes = cursor;
  const buf = makePacketBuffer(payloadBytes);
  const view = new DataView(buf);

  writeHeader(view, {
    magic: MAGIC_DLTA,
    protocolVersion: PROTOCOL_VERSION,
    msgType,
    seq,
    flags: FLAG_PAYLOAD_IS_BINARY,
    tMs: performance.now(),
    payloadBytes,
    headerCrc32: 0,
  });

  const payloadBase = HEADER_SIZE;
  view.setUint32(payloadBase + 0, paneId >>> 0, true);
  view.setUint32(payloadBase + 4, lodLevel >>> 0, true);
  view.setUint32(payloadBase + 8, x0Px >>> 0, true);
  view.setUint32(payloadBase + 12, nCols >>> 0, true);

  const u8 = new Uint8Array(buf);
  u8.set(new Uint8Array(min.buffer, min.byteOffset, min.byteLength), HEADER_SIZE + minOff);
  u8.set(new Uint8Array(max.buffer, max.byteOffset, max.byteLength), HEADER_SIZE + maxOff);

  return buf;
}
```

---

## 7) Codec tests (must-have)

### 7.1 Golden encode/decode tests
- build sample series chunk
- encode → decode → assert arrays equal (`Object.is` per element or checksum)
- verify array offsets are 16‑byte aligned
- verify `payloadBytes` matches actual buffer length - header size

### 7.2 Fuzz tests
- random payload sizes and section counts
- random reordering of section entries (decoder must handle)
- invalid offsets table should fail safely (bounds checks)

### 7.3 Soak tests
- encode/decode thousands of messages
- ensure no allocations explode (reuse scratch buffers in encoder if needed)

---

## 8) Practical implementation tips

- Use a small scratch allocator for encoding to avoid repeated intermediate allocations.
- In message mode, always send `ArrayBuffer` as transferable (zero-copy).
- In SAB mode, consider reusing the same packet buffers and writing into ring segments (advanced; optional).
- Add a “wiretap” debug mode that records last N packets for replay (see next add-on doc).
