//! [`ProcessWorker`] — a managed Python worker process implementing [`UdfWorker`].
//!
//! **6.4-3b.** This is the real, process-backed worker the 6.4-3a `MockWorker`
//! stood in for. It spawns `python -m quantbook.worker`, performs the
//! `HELLO`/`HELLO_ACK` handshake, sends one `CALL` per UDF invocation, and reads
//! the `RETURN`/`RAISE`/`LOG` response — subject to a deadline. On a deadline
//! breach (or any transport break) it KILLS the worker (hard cancel, design §5)
//! and marks itself dead; the next [`UdfWorker::call`] lazily re-spawns +
//! re-handshakes. A late `RETURN` arriving after a kill is dropped because the
//! reader thread dies with the process (contract §10.4 exit test 6).
//!
//! **Threading model (single-in-flight, matching the SYNC recalc):** a per-worker
//! reader thread reads frames off the child's stdout and forwards them on an
//! `mpsc` channel; `call()` writes the `CALL`, then `recv_timeout`s for the
//! correlated `RETURN`/`RAISE` (skipping `LOG` and stale `call_id`s). The engine's
//! recalc evaluates one UDF cell at a time, so there is at most one outstanding
//! call; `call_id` correlation is still enforced defensively.
//!
//! **No new dependencies** — only `std::process` / `std::thread` / `std::sync::mpsc`.
//! Every failure is a deterministic [`UdfError`] (No-Fallbacks): a missing
//! interpreter, a failed handshake, a dead worker, a protocol violation, or a codec
//! error never panics the caller.
//!
//! Production interpreter discovery + trusted-workspace gating + debugpy attach are
//! 6.4-3d; [`PythonWorkerConfig`] takes the interpreter + module path explicitly.

use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ql_types::ArrayValue;

use crate::control::{decode_hello_ack, decode_log, decode_raise, encode_hello, PROTOCOL_VERSION};
use crate::frame::{read_frame, write_frame, Frame, FrameError, FrameType};
use crate::payload::{decode_return, encode_call, CallPayload};
use crate::worker::{UdfError, UdfWorker};

/// How the engine launches + talks to a Python worker. Interpreter + module path
/// are explicit (production trusted-workspace discovery is 6.4-3d).
#[derive(Debug, Clone)]
pub struct PythonWorkerConfig {
    /// The Python interpreter to launch (e.g. a workspace venv's `python3`).
    pub python: PathBuf,
    /// The `-m` module that runs the worker loop. Default `"quantbook.worker"`.
    pub module: String,
    /// Directories prepended to `PYTHONPATH` (so the worker module + the
    /// `quantbook` package resolve). The inherited `PYTHONPATH` is appended.
    pub pythonpath: Vec<PathBuf>,
    /// The trusted user module the worker imports to register UDFs by handle
    /// (passed as `QUANTBOOK_UDF_MODULE`). `None` = the worker registers nothing
    /// (every `CALL` then surfaces a `[function_not_found]`-style raise).
    pub udf_module: Option<String>,
    /// The wire protocol version the engine speaks (checked at handshake).
    pub protocol_version: u32,
    /// How long to wait for `HELLO_ACK` after spawning before declaring the
    /// worker dead.
    pub handshake_timeout: Duration,
}

impl PythonWorkerConfig {
    /// Config with defaults: module `quantbook.worker`, current [`PROTOCOL_VERSION`],
    /// a 5s handshake timeout, no extra `PYTHONPATH` / udf module.
    pub fn new(python: impl Into<PathBuf>) -> Self {
        Self {
            python: python.into(),
            module: "quantbook.worker".to_string(),
            pythonpath: Vec::new(),
            udf_module: None,
            protocol_version: PROTOCOL_VERSION,
            handshake_timeout: Duration::from_secs(5),
        }
    }

    /// Builder: prepend a directory to `PYTHONPATH`.
    pub fn with_pythonpath(mut self, dir: impl Into<PathBuf>) -> Self {
        self.pythonpath.push(dir.into());
        self
    }

    /// Builder: set the trusted user module the worker imports.
    pub fn with_udf_module(mut self, module: impl Into<String>) -> Self {
        self.udf_module = Some(module.into());
        self
    }
}

/// A message from the reader thread to `call()`. A clean stdout EOF disconnects the
/// channel (no message); a frame-decode failure is forwarded as `Error` so the
/// caller can distinguish a torn stream from a clean shutdown.
enum ReaderMsg {
    Frame(Frame),
    Error(String),
}

/// A live worker process + its stdin writer + the reader-thread channel.
struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<ReaderMsg>,
    reader: Option<JoinHandle<()>>,
    /// The OS pid (also surfaced to the IDE for debugpy attach at 6.4-3d).
    pid: u32,
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        // Hard-stop the child and REAP it (no zombies), then let the reader thread
        // wind down on the resulting stdout EOF. Errors are ignored — the process
        // may already be dead.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(h) = self.reader.take() {
            // The child is reaped, so its stdout is closed → the reader's
            // `read_frame` returns EOF and the thread exits promptly; this join
            // does not block.
            let _ = h.join();
        }
    }
}

/// A managed Python worker process implementing [`UdfWorker`].
pub struct ProcessWorker {
    config: PythonWorkerConfig,
    proc: Option<WorkerProcess>,
    next_call_id: u64,
}

impl ProcessWorker {
    /// Create a worker handle. The process is spawned lazily on the first
    /// [`UdfWorker::call`] (or via [`ProcessWorker::ensure_started`]).
    pub fn new(config: PythonWorkerConfig) -> Self {
        Self {
            config,
            proc: None,
            next_call_id: 1,
        }
    }

    /// The live worker's OS pid, if spawned.
    pub fn pid(&self) -> Option<u32> {
        self.proc.as_ref().map(|p| p.pid)
    }

    /// Eagerly spawn + handshake (otherwise the first `call()` does it lazily).
    pub fn ensure_started(&mut self) -> Result<(), UdfError> {
        if self.proc.is_none() {
            self.proc = Some(self.spawn()?);
        }
        Ok(())
    }

    /// Kill + reap the worker and mark dead so the next call re-spawns.
    pub fn shutdown(&mut self) {
        self.proc = None; // `WorkerProcess::drop` kills + reaps.
    }

    fn spawn(&self) -> Result<WorkerProcess, UdfError> {
        let mut cmd = Command::new(&self.config.python);
        cmd.arg("-m")
            .arg(&self.config.module)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()); // worker stderr (stray prints / tracebacks) → our stderr

        // PYTHONPATH = configured dirs ++ inherited (so site-packages stays reachable
        // via the normal interpreter config; pyarrow lives there).
        let mut paths = self.config.pythonpath.clone();
        if let Some(existing) = std::env::var_os("PYTHONPATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if !paths.is_empty() {
            let joined = std::env::join_paths(paths)
                .map_err(|e| UdfError::WorkerDied(format!("invalid PYTHONPATH: {e}")))?;
            cmd.env("PYTHONPATH", joined);
        }
        if let Some(m) = &self.config.udf_module {
            cmd.env("QUANTBOOK_UDF_MODULE", m);
        }

        let mut child = cmd.spawn().map_err(|e| {
            UdfError::WorkerDied(format!(
                "spawn {} -m {}: {e}",
                self.config.python.display(),
                self.config.module
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| UdfError::WorkerDied("worker stdin pipe missing".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| UdfError::WorkerDied("worker stdout pipe missing".to_string()))?;
        let pid = child.id();

        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                match read_frame(&mut r) {
                    Ok(Some(f)) => {
                        if tx.send(ReaderMsg::Frame(f)).is_err() {
                            break; // receiver dropped (worker being torn down)
                        }
                    }
                    Ok(None) => break, // clean EOF — worker closed stdout
                    Err(e) => {
                        let _ = tx.send(ReaderMsg::Error(e.to_string()));
                        break;
                    }
                }
            }
        });

        let mut wp = WorkerProcess {
            child,
            stdin,
            rx,
            reader: Some(reader),
            pid,
        };
        self.handshake(&mut wp)?;
        Ok(wp)
    }

    fn handshake(&self, wp: &mut WorkerProcess) -> Result<(), UdfError> {
        let hello = Frame::new(FrameType::Hello, encode_hello(self.config.protocol_version));
        write_frame(&mut wp.stdin, &hello)
            .map_err(|e| UdfError::WorkerDied(format!("write HELLO: {e}")))?;
        // (write_frame writes the whole frame; ChildStdin is unbuffered, no flush needed,
        // but flushing is harmless and explicit.)
        use std::io::Write;
        wp.stdin
            .flush()
            .map_err(|e| UdfError::WorkerDied(format!("flush HELLO: {e}")))?;

        match wp.rx.recv_timeout(self.config.handshake_timeout) {
            Ok(ReaderMsg::Frame(f)) => {
                if f.frame_type != FrameType::HelloAck {
                    return Err(UdfError::Protocol(format!(
                        "expected HELLO_ACK, got {:?}",
                        f.frame_type
                    )));
                }
                let ack = decode_hello_ack(&f.payload)?;
                if ack.protocol_version != self.config.protocol_version {
                    return Err(UdfError::Handshake {
                        expected: self.config.protocol_version,
                        got: ack.protocol_version,
                    });
                }
                Ok(())
            }
            Ok(ReaderMsg::Error(e)) => {
                Err(UdfError::WorkerDied(format!("reader during handshake: {e}")))
            }
            Err(RecvTimeoutError::Timeout) => {
                Err(UdfError::WorkerDied("handshake timed out (no HELLO_ACK)".to_string()))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(UdfError::WorkerDied("worker exited before handshake".to_string()))
            }
        }
    }

    fn kill_worker(&mut self) {
        // Dropping the `WorkerProcess` kills + reaps the child and winds down the
        // reader thread; setting `None` marks dead so the next call re-spawns.
        self.proc = None;
    }
}

impl UdfWorker for ProcessWorker {
    fn call(
        &mut self,
        handle: u64,
        args: &ArrayValue,
        deadline: Duration,
    ) -> Result<ArrayValue, UdfError> {
        let call_id = self.next_call_id;
        self.next_call_id = self.next_call_id.wrapping_add(1);

        // (Re)spawn if dead. A spawn/handshake failure is the caller's error.
        self.ensure_started()?;

        // Encode + send the CALL.
        let payload = encode_call(&CallPayload {
            handle,
            call_id,
            args: args.clone(),
        })?;
        let frame = Frame::new(FrameType::Call, payload);
        let write_res: Result<(), FrameError> = {
            let wp = self.proc.as_mut().expect("spawned above");
            use std::io::Write;
            write_frame(&mut wp.stdin, &frame).and_then(|()| wp.stdin.flush().map_err(FrameError::from))
        };
        if let Err(e) = write_res {
            self.kill_worker();
            return Err(UdfError::WorkerDied(format!("write CALL: {e}")));
        }

        // Await the correlated RETURN/RAISE, honoring the deadline.
        let deadline_at = Instant::now() + deadline;
        loop {
            let remaining = deadline_at.saturating_duration_since(Instant::now());
            let msg = {
                let wp = self.proc.as_mut().expect("spawned above");
                wp.rx.recv_timeout(remaining)
            };
            match msg {
                Ok(ReaderMsg::Frame(f)) => match f.frame_type {
                    FrameType::Return => {
                        let ret = decode_return(&f.payload)?;
                        if ret.call_id != call_id {
                            continue; // stale response from a prior call — skip
                        }
                        return Ok(ret.result);
                    }
                    FrameType::Raise => {
                        let r = decode_raise(&f.payload)?;
                        if r.call_id != call_id {
                            continue;
                        }
                        return Err(UdfError::Raised {
                            exc_type: r.exc_type,
                            message: r.message,
                        });
                    }
                    FrameType::Log => {
                        let log = decode_log(&f.payload)?;
                        // Surfaced visibly (NOT silently dropped). 6.4-3c routes worker
                        // logs to `CellDiagnostic`s; until then they go to stderr.
                        eprintln!(
                            "[quantbook-udf worker log lvl={}] {}",
                            log.level, log.message
                        );
                        continue;
                    }
                    other => {
                        self.kill_worker();
                        return Err(UdfError::Protocol(format!(
                            "unexpected {other:?} frame while awaiting RETURN/RAISE for call_id {call_id}"
                        )));
                    }
                },
                Ok(ReaderMsg::Error(e)) => {
                    self.kill_worker();
                    return Err(UdfError::WorkerDied(format!("reader: {e}")));
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Hard cancel: kill the worker so a late RETURN is dropped (exit test 6).
                    self.kill_worker();
                    return Err(UdfError::Timeout(deadline));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.kill_worker();
                    return Err(UdfError::WorkerDied("worker exited mid-call".to_string()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::Value;

    #[test]
    fn config_defaults_and_builders() {
        let c = PythonWorkerConfig::new("/usr/bin/python3")
            .with_pythonpath("/some/dir")
            .with_udf_module("my.udfs");
        assert_eq!(c.module, "quantbook.worker");
        assert_eq!(c.protocol_version, PROTOCOL_VERSION);
        assert_eq!(c.pythonpath, vec![PathBuf::from("/some/dir")]);
        assert_eq!(c.udf_module.as_deref(), Some("my.udfs"));
    }

    /// A non-existent interpreter must surface a loud `WorkerDied` (No-Fallbacks),
    /// NOT a panic — and the worker stays usable as a handle (next call retries).
    #[test]
    fn missing_interpreter_is_worker_died_not_panic() {
        let cfg = PythonWorkerConfig::new("/definitely/not/a/real/python-xyzzy");
        let mut w = ProcessWorker::new(cfg);
        let err = w
            .call(1, &ArrayValue::singleton(Value::Number(1.0)), Duration::from_secs(1))
            .unwrap_err();
        assert!(
            matches!(err, UdfError::WorkerDied(_)),
            "missing interpreter must be WorkerDied, got {err:?}"
        );
        // No live process was created.
        assert_eq!(w.pid(), None);
    }
}
