$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$game = 'E:\SteamLibrary\steamapps\common\Stardew Valley'

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  SMAPI + NagiBridge install (safe method)' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "Game folder: $game" -ForegroundColor DarkGray
Write-Host "Script dir : $scriptDir" -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path -LiteralPath $game)) {
    Write-Host "[X] Game folder not found: $game" -ForegroundColor Red
    throw "Game folder missing"
}

Write-Host ''
Write-Host '[1/3] Copying SMAPI runtime files (no exe replacement)...' -ForegroundColor Yellow
$smapiSrc = Join-Path $scriptDir 'downloads\smapi-files'
if (-not (Test-Path -LiteralPath $smapiSrc)) {
    throw "SMAPI files not found: $smapiSrc"
}
$copied = 0
Get-ChildItem -LiteralPath $smapiSrc | ForEach-Object {
    $dest = Join-Path $game $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
    $copied++
    Write-Host "  -> $($_.Name)"
}
Write-Host "  Done: $copied items copied" -ForegroundColor Green

$gameDeps = Join-Path $game 'Stardew Valley.deps.json'
$smapiDeps = Join-Path $game 'StardewModdingAPI.deps.json'
if (Test-Path -LiteralPath $gameDeps) {
    Copy-Item -LiteralPath $gameDeps -Destination $smapiDeps -Force
    Write-Host '  -> Generated StardewModdingAPI.deps.json (from game deps)' -ForegroundColor Green
} else {
    Write-Host '  [!] Stardew Valley.deps.json not found, SMAPI may fail to launch' -ForegroundColor Red
}
Write-Host '  (Original Stardew Valley.exe is NOT modified)' -ForegroundColor DarkGray

Write-Host ''
Write-Host '[2/3] Creating Mods folder + installing NagiBridge...' -ForegroundColor Yellow
$modsDir = Join-Path $game 'Mods'
New-Item -ItemType Directory -Force -Path $modsDir | Out-Null
Write-Host "  -> Mods folder: $modsDir" -ForegroundColor Green

$nagiSrc = Join-Path $scriptDir 'downloads\NagiBridge-extracted\NagiBridge'
if (-not (Test-Path -LiteralPath $nagiSrc)) {
    throw "NagiBridge mod folder not found: $nagiSrc"
}
$nagiDest = Join-Path $modsDir 'NagiBridge'
Copy-Item -LiteralPath $nagiSrc -Destination $nagiDest -Recurse -Force
Write-Host '  -> NagiBridge.dll + manifest.json' -ForegroundColor Green

Write-Host ''
Write-Host '[3/3] Verifying installation...' -ForegroundColor Yellow
$checks = @(
    @('SMAPI launcher (StardewModdingAPI.exe)', (Test-Path -LiteralPath (Join-Path $game 'StardewModdingAPI.exe'))),
    @('SMAPI deps.json (generated)', (Test-Path -LiteralPath (Join-Path $game 'StardewModdingAPI.deps.json'))),
    @('SMAPI internal folder (smapi-internal)', (Test-Path -LiteralPath (Join-Path $game 'smapi-internal'))),
    @('Original game exe (unchanged)', ((Get-Item -LiteralPath (Join-Path $game 'Stardew Valley.exe')).Length -lt 160000)),
    @('Mods folder', (Test-Path -LiteralPath $modsDir)),
    @('NagiBridge.dll', (Test-Path -LiteralPath (Join-Path $nagiDest 'NagiBridge.dll'))),
    @('NagiBridge manifest.json', (Test-Path -LiteralPath (Join-Path $nagiDest 'manifest.json')))
)
$allOk = $true
foreach ($c in $checks) {
    $mark = if ($c[1]) { 'OK' } else { 'MISSING' }
    $color = if ($c[1]) { 'Green' } else { 'Red' }
    if (-not $c[1]) { $allOk = $false }
    Write-Host "  [$mark] $($c[0])" -ForegroundColor $color
}

Write-Host ''
if ($allOk) {
    Write-Host '==========================================' -ForegroundColor Green
    Write-Host '  Files installed successfully!' -ForegroundColor Green
    Write-Host '==========================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'IMPORTANT - Set Steam launch options:' -ForegroundColor Yellow
    Write-Host '  1. Open Steam -> Library -> right-click Stardew Valley -> Properties' -ForegroundColor White
    Write-Host '  2. In "Launch Options" box, paste exactly:' -ForegroundColor White
    Write-Host '     "StardewModdingAPI.exe" %command%' -ForegroundColor Cyan
    Write-Host '  3. Close Properties, click Play in Steam' -ForegroundColor White
    Write-Host ''
    Write-Host '  This makes Steam launch SMAPI instead of the raw game,' -ForegroundColor DarkGray
    Write-Host '  without modifying any game files.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Then:' -ForegroundColor White
    Write-Host '  4. Load your save, press ~ (backtick) to open chat' -ForegroundColor White
    Write-Host '  5. Choose "Channel Mode", name it Nagi' -ForegroundColor White
} else {
    Write-Host '==========================================' -ForegroundColor Red
    Write-Host '  Installation INCOMPLETE. Check red items.' -ForegroundColor Red
    Write-Host '==========================================' -ForegroundColor Red
}
