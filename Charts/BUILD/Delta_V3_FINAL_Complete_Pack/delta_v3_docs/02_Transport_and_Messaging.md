# Transport and Messaging (V3)
**Goal:** define deterministic, low-overhead communication between threads for both:
- Turbo mode (SharedArrayBuffer rings)
- Compat mode (postMessage + Transferables)

---

## 1) Message taxonomy (common)

Define a small set of message types used everywhere:

### 1.1 Control / lifecycle
- `INIT_RENDERER`
- `INIT_OK` / `INIT_FAIL`
- `SET_TIER`
- `SET_THEME`
- `SET_VIEWPORT`
- `DESTROY`

### 1.2 Input
- `INPUT_STATE` (message mode)
- `INPUT_STATE_SAB` (SAB mode: implicit; no message)

### 1.3 Data
- `SET_SERIES_DATA_CHUNK`
- `APPEND_TICKS`
- `SET_LOD_LEVEL`
- `SET_ENVELOPE_CHUNK`

### 1.4 Overlay/drawings
- `OVERLAY_ADD`
- `OVERLAY_UPDATE`
- `OVERLAY_REMOVE`
- `OVERLAY_BULK_SET`

### 1.5 Telemetry/diagnostics
- `STATS_FRAME`
- `ERROR_EVENT`

---

## 2) InputState schema (canonical)

InputState must be small and stable. Suggested structure (JS/TS shape):

```ts
type InputState = {
  tMs: number;
  pointer: {
    x: number; y: number;           // in CSS pixels; renderer converts to physical
    buttons: number;
    mods: number;                   // bitmask: shift/alt/ctrl/meta
    kind: "mouse"|"touch"|"pen";
    id: number;
    inBounds: boolean;
  };
  wheel: { dx: number; dy: number; dz: number; mode: number; };
  pinch?: { centerX: number; centerY: number; scale: number; };
  keys?: { code: number; down: boolean; };
};
```

Renderer normalizes into:
- physical pixels
- camera delta
- gesture state machine events

---

## 3) Message transport (Compat)

### 3.1 Packet format
Use a binary header + payload (Transferable ArrayBuffer) to reduce overhead.

Header (fixed 32 bytes, little-endian):
- `u32 magic` (0x444C5441 = "DLTA")
- `u16 version`
- `u16 msgType`
- `u32 seq`
- `u32 payloadBytes`
- `u32 flags`
- `u64 timestampMs`

Payload:
- either JSON (small control messages), or
- typed-array data (series chunks, overlays)

### 3.2 Chunking rules
- never post > ~4–8MB per message (tune per platform)
- chunk series data by time window and LOD level
- always include:
  - seriesId
  - time range
  - revision number

---

## 4) SharedArrayBuffer transport (Turbo)

### 4.1 Ring buffer concept
Use a fixed-size SAB as a ring of messages:

- `head` and `tail` indices in a small control SAB (Int32Array)
- data SAB contains message records (aligned to 8 or 16 bytes)

### 4.2 Record layout
Record header (aligned 16 bytes):
- `u16 msgType`
- `u16 flags`
- `u32 seq`
- `u32 payloadBytes`
- `u32 reserved`

Payload:
- raw bytes (typed array view created by receiver)

### 4.3 Atomic protocol
- producer writes payload then header last
- producer updates tail via `Atomics.store`
- consumer reads header; if incomplete, retry (spin with backoff)
- consumer updates head when done

### 4.4 InputState SAB lane
For highest frequency updates, use a dedicated shared struct rather than ring messages.

Example:
- `Float32Array` for x,y,wheel
- `Int32Array` for buttons/mods
- `Int32Array` seq counter incremented per write
Renderer reads latest seq each frame and ignores intermediate.

---

## 5) Versioning and compatibility
- Every message has a version and flags.
- Unknown message types are ignored (forward compatibility).
- Remote config can force “message mode only” if SAB is problematic.

---

## 6) Testing the transport
- fuzz tests for ring wraparound
- soak tests for high-rate input
- message loss simulation
- ordering invariants validated by seq numbers
