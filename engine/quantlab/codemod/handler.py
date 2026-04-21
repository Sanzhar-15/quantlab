"""
CodeMod IPC Handler.

Handles STDIN/STDOUT communication for code modification subprocess.

Spec Reference: Technical Spec §20.5, Phase 6 Code Modification Contract
"""

import json
import sys
import traceback
from typing import Any
from typing import TextIO

from .engine import CodeModEngine
from .protocol import (
    CodeModParser,
    CodeModWriter,
    EditRequest,
    EditResponse,
    EditStatus,
    ParseRequest,
    ParseResponse,
    SourceLocation,
)


class CodeModHandler:
    """
    Handles code modification requests via NDJSON IPC.

    Reads requests from stdin, processes them, and writes responses to stdout.
    """

    def __init__(
        self,
        input_stream: TextIO | None = None,
        output_stream: TextIO | None = None,
    ) -> None:
        """
        Initialize handler.

        Args:
            input_stream: Input stream (default: stdin)
            output_stream: Output stream (default: stdout)
        """
        self._input = input_stream or sys.stdin
        self._output = output_stream or sys.stdout
        self._parser = CodeModParser()
        self._writer = CodeModWriter(output_func=self._write_output)
        self._engine = CodeModEngine()
        self._running = False

    def _write_output(self, message: str) -> None:
        """Write message to output stream."""
        self._output.write(message + "\n")
        self._output.flush()

    def run(self) -> None:
        """
        Run the handler loop.

        Reads from input until EOF or shutdown.
        """
        self._running = True

        while self._running:
            try:
                line = self._input.readline()
                if not line:
                    # EOF
                    break

                self._process_line(line)

            except KeyboardInterrupt:
                break
            except Exception as e:
                # Log unexpected errors but continue
                self._write_error(
                    request_id="unknown",
                    error=f"Unexpected error: {str(e)}",
                )

    def stop(self) -> None:
        """Stop the handler loop."""
        self._running = False

    def _process_line(self, line: str) -> None:
        """Process a single input line."""
        messages = self._parser.feed(line)

        for msg in messages:
            self._handle_message(msg)

    def _handle_message(self, msg: dict[str, Any]) -> None:
        """Handle a parsed message."""
        msg_type = msg.get("type")
        request_id = msg.get("requestId", "unknown")

        try:
            if msg_type == "edit":
                self._handle_edit(msg)
            elif msg_type == "parse":
                self._handle_parse(msg)
            elif msg_type == "ping":
                self._handle_ping(msg)
            elif msg_type == "shutdown":
                self._handle_shutdown(msg)
            else:
                self._write_error(
                    request_id=request_id,
                    error=f"Unknown message type: {msg_type}",
                )
        except Exception as e:
            self._write_error(
                request_id=request_id,
                error=f"Error handling message: {str(e)}",
                stack=traceback.format_exc(),
            )

    def _handle_edit(self, msg: dict[str, Any]) -> None:
        """Handle an edit request."""
        try:
            request = EditRequest.from_dict(msg)
        except Exception as e:
            self._write_error(
                request_id=msg.get("requestId", "unknown"),
                error=f"Invalid edit request: {str(e)}",
            )
            return

        response = self._engine.edit(request)
        self._write_output(response.to_ndjson().rstrip("\n"))

    def _handle_parse(self, msg: dict[str, Any]) -> None:
        """Handle a parse request."""
        try:
            request = ParseRequest.from_dict(msg)
        except Exception as e:
            self._write_error(
                request_id=msg.get("requestId", "unknown"),
                error=f"Invalid parse request: {str(e)}",
            )
            return

        response = self._engine.parse(request)
        self._write_output(response.to_ndjson().rstrip("\n"))

    def _handle_ping(self, msg: dict[str, Any]) -> None:
        """Handle a ping request."""
        request_id = msg.get("requestId", "unknown")
        response = {
            "type": "pong",
            "requestId": request_id,
            "status": "ok",
        }
        self._write_output(json.dumps(response))

    def _handle_shutdown(self, msg: dict[str, Any]) -> None:
        """Handle a shutdown request."""
        request_id = msg.get("requestId", "unknown")
        response = {
            "type": "shutdownAck",
            "requestId": request_id,
        }
        self._write_output(json.dumps(response))
        self._running = False

    def _write_error(
        self,
        request_id: str,
        error: str,
        stack: str | None = None,
    ) -> None:
        """Write an error response."""
        response = {
            "type": "error",
            "requestId": request_id,
            "error": error,
        }
        if stack:
            response["stack"] = stack
        self._write_output(json.dumps(response))


def handle_single_request(
    request_json: str,
) -> str:
    """
    Handle a single request and return the response.

    Convenience function for testing and one-shot operations.

    Args:
        request_json: JSON request string

    Returns:
        JSON response string
    """
    try:
        msg = json.loads(request_json)
    except json.JSONDecodeError as e:
        return json.dumps({
            "type": "error",
            "requestId": "unknown",
            "error": f"Invalid JSON: {str(e)}",
        })

    engine = CodeModEngine()
    request_id = msg.get("requestId", "unknown")
    msg_type = msg.get("type")

    try:
        if msg_type == "edit":
            request = EditRequest.from_dict(msg)
            response = engine.edit(request)
            return response.to_ndjson().rstrip("\n")
        elif msg_type == "parse":
            request = ParseRequest.from_dict(msg)
            response = engine.parse(request)
            return response.to_ndjson().rstrip("\n")
        elif msg_type == "ping":
            return json.dumps({
                "type": "pong",
                "requestId": request_id,
                "status": "ok",
            })
        else:
            return json.dumps({
                "type": "error",
                "requestId": request_id,
                "error": f"Unknown message type: {msg_type}",
            })
    except Exception as e:
        return json.dumps({
            "type": "error",
            "requestId": request_id,
            "error": str(e),
            "stack": traceback.format_exc(),
        })


def main() -> int:
    """
    Main entry point for codemod subprocess.

    Returns:
        Exit code (0 for success)
    """
    handler = CodeModHandler()

    try:
        handler.run()
        return 0
    except Exception as e:
        sys.stderr.write(f"Fatal error: {str(e)}\n")
        sys.stderr.write(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
