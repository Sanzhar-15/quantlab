// FE-1 latency shootout — Node "engine host" for the REAL shipped topology.
//
// The owning napi WorkbookSession lives in THIS Node process (exactly the FE-2-0
// grid topology). A Python client (latency_nodehost.py) drives it over stdio with
// newline-delimited JSON requests, so we measure the actual product path:
//   Python kernel  ->  Node extension host (owns the napi Session)  ->  engine  ->  back.
// This removes the extrapolation in the shootout doc (the in-process/HTTP legs
// measured clean topologies; THIS is the engine-in-Node + Python-as-client one).
//
// The delta-version cursor is kept HERE (as the Node grid host would), never sent
// to Python. Protocol: one JSON object per line in, one per line out.
//   {op:"addSheet",name,chunkRows} -> {sheetId}
//   {op:"setFormula"|"setValue"|"recalc"|"writeRange"|"snapshotDelta"|"cell"|"close"}
//   snapshotDelta -> {changedCells:[...]}  (the real render payload the grid receives)

import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");

function resolveCdylib() {
  if (process.env.QL_NODE_CDYLIB) return process.env.QL_NODE_CDYLIB;
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const base = `libql_bindings_node.${ext}`;
  for (const sub of ["release", "debug"]) {
    const p = path.join(workspaceRoot, "target", sub, base);
    if (existsSync(p)) return p;
  }
  throw new Error("built cdylib not found — run `cargo build -p ql-bindings-node --release`");
}

const mod = { exports: {} };
process.dlopen(mod, resolveCdylib());
const { Session } = mod.exports;
const s = new Session();
let version = null; // the delta cursor lives in the host, not the Python client

function handle(req) {
  switch (req.op) {
    case "addSheet": {
      const sheetId = s.addSheet(req.name, req.chunkRows);
      version = s.snapshot().version; // seed the cursor after setup
      return { sheetId };
    }
    case "setFormula":
      s.setFormula(req.sheet, req.row, req.col, req.text);
      return { ok: true };
    case "setValue":
      s.setValue(req.sheet, req.row, req.col, req.value);
      return { ok: true };
    case "writeRange":
      return { written: Number(s.writeRange(req.range, req.values).written) };
    case "recalc":
      s.recalcDirty();
      return { ok: true };
    case "snapshotDelta": {
      const d = s.snapshotDelta(version);
      version = d.version;
      return { changedCells: d.changedCells };
    }
    case "cell":
      return { cell: s.cell(req.sheet, req.row, req.col) };
    case "close":
      s.close();
      return { ok: true };
    default:
      throw new Error(`unknown op: ${req.op}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line) return;
  let req;
  let resp;
  try {
    req = JSON.parse(line);
    resp = handle(req);
  } catch (e) {
    resp = { error: String(e && e.message ? e.message : e) };
  }
  process.stdout.write(JSON.stringify(resp) + "\n");
  // The dlopen'd native module keeps the event loop alive, so a clean rl.close()
  // isn't enough — exit explicitly once the close response is flushed.
  if (req && req.op === "close") process.exit(0);
});
