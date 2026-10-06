# Creates the engine bundling environment on a Windows x64 build machine (PORTS, target win32-x64).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build\python\setup-engine-venv.ps1 -Python <python.exe> -Venv <dir>
#
# <python.exe> must be a CPython 3.12 whose platform.machine() is AMD64 (an x64 interpreter; on an ARM64 host it runs
# under emulation). The venv gets build\python\requirements-engine-win32-x64.txt with --require-hashes and binary
# wheels only: a package without a matching hashed win_amd64 wheel fails the install, nothing is compiled.
# The last line printed is `QUANTLAB_ENGINE_PYTHON=<venv python.exe>`; the caller sets that variable for
# `gulp bundle-quantlab-engine`. Any failure stops the script with a non-zero exit.

param(
	[Parameter(Mandatory = $true)][string]$Python,
	[Parameter(Mandatory = $true)][string]$Venv
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
	& $Exe @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "$Exe $($Arguments -join ' ') exited with $LASTEXITCODE"
	}
}

$lock = Join-Path $PSScriptRoot 'requirements-engine-win32-x64.txt'
if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) { throw "lock file not found: $lock" }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "interpreter not found: $Python" }
if (Test-Path -LiteralPath $Venv) { throw "venv directory already exists: $Venv (choose a new one)" }

$probe = & $Python -c 'import platform, sys; print(platform.machine(), sys.version_info[0], sys.version_info[1])'
if ($LASTEXITCODE -ne 0) { throw "$Python could not report its platform" }
$machine, $major, $minor = "$probe".Trim().Split(' ')
if ($machine -ne 'AMD64') { throw "$Python reports machine '$machine'; the win32-x64 bundle needs an AMD64 interpreter" }
if ("$major.$minor" -ne '3.12') { throw "$Python is Python $major.$minor; the lock is resolved for 3.12" }

Invoke-Checked $Python @('-m', 'venv', $Venv)
$venvPython = Join-Path $Venv 'Scripts\python.exe'
Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--require-hashes', '--only-binary', ':all:', '--no-deps', '-r', $lock)
Invoke-Checked $venvPython @('-m', 'pip', 'check')
Invoke-Checked $venvPython @('-c', 'import PyInstaller, numpy, pandas, pyarrow, libcst, cryptography, argon2, psutil, yaml, alpaca, httpx, jsonrpclib; print("imports ok")')
Write-Output "QUANTLAB_ENGINE_PYTHON=$venvPython"
