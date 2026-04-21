param()

# Ensure Electron runs as the app even if the env var is set elsewhere.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# Skip prelaunch by default for fast startup; override by pre-setting the var.
if (-not $env:VSCODE_SKIP_PRELAUNCH) {
	$env:VSCODE_SKIP_PRELAUNCH = '1'
}

& (Join-Path $PSScriptRoot 'code.bat') @args
