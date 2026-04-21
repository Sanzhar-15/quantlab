@echo off
setlocal

rem Ensure Electron runs as the app even if the env var is set elsewhere.
set "ELECTRON_RUN_AS_NODE="

rem Skip prelaunch by default for fast startup; override by pre-setting the var.
if not defined VSCODE_SKIP_PRELAUNCH set "VSCODE_SKIP_PRELAUNCH=1"

call "%~dp0code.bat" %*

endlocal
