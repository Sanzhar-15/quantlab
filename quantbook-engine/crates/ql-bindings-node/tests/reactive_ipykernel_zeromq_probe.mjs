// FE-1.5-1c-0.5 — Node `zeromq.js` feasibility probe (cost the native-dep alternative).
//
// The shipped quantlab extension is Node and has NO `zeromq` dependency (verified
// extensions/quantlab/package.json, plan §11.2). To drive a REAL ipykernel directly from Node
// (the 2-process topology: Node host <-ZMQ-> kernel) the extension would need the `zeromq` npm
// module — a NATIVE addon (prebuilt binaries / node-gyp), with build + packaging + notarization
// implications on macOS.
//
// reactive_ipykernel_smoke.py proves the ALTERNATIVE (a Python jupyter_client supervisor) works
// with NO Node native dep. This probe just reports whether `zeromq` is even loadable in this
// Node, so the DECISION (plan §11.2/§11.3) is grounded, not guessed. It is NOT a driver — it
// does not speak the Jupyter wire protocol. Always exits 0 (it's an informational probe, not a
// gate): the absence of zeromq is the EXPECTED finding, and is itself the argument for the
// jupyter_client path.

let status, detail;
try {
  const z = await import("zeromq");
  const v = z?.default?.version || z?.version || "(version unknown)";
  status = "PRESENT";
  detail = `zeromq is importable in this Node (version ${v}). The Node-native 2-process path is ` +
           `technically available, but adopting it still adds a native addon to the extension's ` +
           `dependency + packaging surface.`;
} catch (e) {
  status = "ABSENT";
  detail = `zeromq is NOT installed/loadable in this Node (${e && e.code ? e.code : ""} ${e && e.message ? e.message : e}). ` +
           `Adopting the Node-native path would require adding the \`zeromq\` native npm module to ` +
           `the extension — build/prebuild + packaging + notarization cost. The jupyter_client ` +
           `supervisor path (proven by reactive_ipykernel_smoke.py) needs NONE of that.`;
}

console.log(`[zeromq-probe 1c-0.5] ${status}`);
console.log(`  ${detail}`);
console.log("  DECISION input: prefer the Python jupyter_client supervisor (no Node native dep) " +
            "unless the team explicitly wants the 2-process Node-native topology. See plan §11.2/§11.3.");
