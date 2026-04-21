# NEW-BUILD-001: Windows build script (NSIS installer)
#
# Builds the Quantlab application for Windows including:
# - VS Code fork (TypeScript compilation)
# - Quantlab extension
# - Python engine (PyInstaller bundle)
# - NSIS installer packaging

$ErrorActionPreference = "Stop"
$RootDir = (Get-Item "$PSScriptRoot\..\..").FullName
$BuildDir = "$RootDir\.build\windows"
$EngineDir = "$RootDir\engine"
$ExtDir = "$RootDir\extensions\quantlab"

Write-Host "=== Building Quantlab for Windows ==="

# Step 1: Build VS Code fork
Write-Host "[1/5] Building VS Code fork..."
Set-Location $RootDir
if (Test-Path "package.json") {
    npm run compile
    if ($LASTEXITCODE -ne 0) { throw "VS Code compilation failed" }
}

# Step 2: Build extension
Write-Host "[2/5] Building Quantlab extension..."
Set-Location $ExtDir
if (Test-Path "package.json") {
    npm run compile
    if ($LASTEXITCODE -ne 0) { throw "Extension compilation failed" }
}

# Step 3: Bundle Python engine
Write-Host "[3/5] Bundling Python engine..."
Set-Location $EngineDir
if (Test-Path "pyproject.toml") {
    python -m pip install --quiet pyinstaller
    python -m PyInstaller `
        --name quantlab-engine `
        --onedir `
        --noconfirm `
        --distpath "$BuildDir\dist" `
        --hidden-import quantlab `
        --hidden-import quantlab.daemon `
        --hidden-import quantlab.daemon.main `
        --hidden-import quantlab.backtest `
        --hidden-import quantlab.backtest.core `
        --hidden-import quantlab.providers `
        --hidden-import quantlab.risk `
        --hidden-import quantlab.trading `
        --hidden-import quantlab.metrics `
        --hidden-import quantlab.data `
        quantlab\daemon\__main__.py
}

# Step 4: Stage installer files
Write-Host "[4/5] Staging installer files..."
New-Item -ItemType Directory -Force -Path "$BuildDir\installer" | Out-Null
if (Test-Path "$BuildDir\dist\quantlab-engine") {
    Copy-Item -Recurse -Force "$BuildDir\dist\quantlab-engine\*" "$BuildDir\installer\"
}

# Step 5: Build NSIS installer (if makensis available)
Write-Host "[5/5] Building installer..."
$nsisPath = Get-Command makensis -ErrorAction SilentlyContinue
if ($nsisPath) {
    # NSIS script would be at build/win32/quantlab.nsi
    $nsiScript = "$RootDir\build\win32\quantlab.nsi"
    if (Test-Path $nsiScript) {
        makensis /DBUILD_DIR="$BuildDir" $nsiScript
        Write-Host "Installer created in $BuildDir"
    } else {
        Write-Host "NSIS script not found at $nsiScript"
        Write-Host "Build artifacts staged in: $BuildDir\installer"
    }
} else {
    Write-Host "makensis not found. Install NSIS from: https://nsis.sourceforge.io/"
    Write-Host "Build artifacts staged in: $BuildDir\installer"
}

Write-Host "=== Windows build complete ==="
