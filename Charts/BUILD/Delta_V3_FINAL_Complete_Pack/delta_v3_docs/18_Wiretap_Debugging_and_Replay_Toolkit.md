# Wiretap Debugging and Replay Toolkit (V3 Add‑On)
**Purpose:** Make GPU + multi-thread chart bugs diagnosable by recording and replaying:
- binary protocol packets
- input state stream (or SAB snapshots)
- renderer decisions (tier selection, quality profile, budgets)
- key deterministic seeds (if any)

> If you want to move fast, you need “replayable bugs.”

---

## 0) Why wiretap is necessary

Chart engines fail in ways that are hard to reproduce:
- device loss events
- race conditions between data and input
- edge cases in tile invalidation
- subtle jank triggered by upload bursts

A wiretap makes these failures replayable:
- record last N seconds of messages and input
- export as a single JSON+binary blob
- replay in a local harness to reproduce the exact rendering state

---

## 1) What to record

### 1.1 Control plane (always)
- tier selection outcome + reasons
- remote config version/hash
- quality profile (tileSize, maxDpr, budgets)
- theme changes
- viewport changes

### 1.2 Data plane (bounded)
- `SET_SERIES_CHUNK` packets (bounded count)
- `APPEND_TICKS` packets (last N seconds)
- envelope chunks (optional)

### 1.3 Input plane (high frequency)
Two options:
- record InputState messages (message mode)
- record periodic snapshots of the SAB input struct (SAB mode)

### 1.4 Renderer decisions (optional but powerful)
- tile job queue decisions (top K jobs per frame)
- eviction events
- memory usage counters
- frame timing histograms

---

## 2) Bounded ring recorder design

### 2.1 In-memory ring buffer (browser)
Maintain a ring of:
- packet metadata
- packet bytes (ArrayBuffer slices)

Example:
```ts
type WireRecord = {
  tMs: number;
  dir: "in"|"out";       // direction (from worker, to worker)
  msgType: number;
  seq: number;
  bytes: Uint8Array;     // payload or full packet
};
```

Constraints:
- cap total bytes (e.g., 64MB)
- evict oldest when exceeding cap
- store critical events even under pressure (e.g., device lost)

### 2.2 Compression (optional)
If you need longer windows:
- compress older records (LZ4/zstd wasm) in idle time only

---

## 3) Export format

### 3.1 Single export blob
- `wiretap.json` (metadata index)
- `wiretap.bin` (concatenated packet bytes)
- or a single `zip` built in-memory (optional)

`wiretap.json` contains:
- protocolVersion
- app version
- tier selection log
- array of records with offsets into `wiretap.bin`

Example JSON index:
```json
{
  "protocolVersion": 1,
  "appVersion": "v3.0.0",
  "tier": "B",
  "qualityProfile": {"tileSizePx":512, "maxDpr":2.0},
  "records": [
    {"tMs": 123.4, "msgType": 768, "seq": 10, "off": 0, "len": 4096},
    {"tMs": 125.0, "msgType": 770, "seq": 11, "off": 4096, "len": 256}
  ]
}
```

---

## 4) Replay harness

### 4.1 Deterministic replay loop
- create renderer in “replay mode”
- feed recorded messages at their relative timestamps
- feed recorded inputs similarly
- render frames at fixed step (e.g., 60hz) or based on recorded frame timings

### 4.2 Assertions & diffing
Replay harness can:
- assert that no uncaptured GPU errors occur
- assert that tile cache remains bounded
- generate screenshots each second for visual diff

### 4.3 Minimal API for replay
```ts
interface ReplayDriver {
  load(indexJson: any, bin: ArrayBuffer): void;
  play(speed: number): void; // speed=1.0 realtime
  step(frames: number): void;
  exportFramePNG(): Promise<Blob>;
}
```

---

## 5) What makes replay “deterministic enough”

GPU execution is not perfectly deterministic across devices. We aim for:
- deterministic *engine decisions* (tile invalidation, job ordering, state updates)
- deterministic *inputs and data messages*
- stable *visual* output within tolerance on the same device/browser

For cross-device diffing:
- compare high-level metrics (frame pacing, error events)
- compare images with tolerance

---

## 6) UI integration (developer tool)
- “Record” toggle in dev overlay
- “Export wiretap” button (downloads zip)
- “Replay” page in internal tooling

---

## 7) Checklist
- [ ] bounded in-memory recorder (cap by bytes)
- [ ] export index + binary data
- [ ] replay harness that feeds messages deterministically
- [ ] integration into dev overlay
- [ ] CI test that replays known scenes
