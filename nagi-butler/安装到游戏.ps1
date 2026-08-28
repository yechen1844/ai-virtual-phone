$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = "E:\SteamLibrary\steamapps\common\Stardew Valley"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  SMAPI + NagiBridge 一键安装到正版游戏" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $game)) {
    Write-Host "[X] 找不到正版游戏目录: $game" -ForegroundColor Red
    Write-Host "    请确认游戏安装在正确位置" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

Write-Host "[1/4] 安装 SMAPI 运行时文件..." -ForegroundColor Yellow
$smapiSrc = Join-Path $scriptDir "downloads\smapi-files"
if (-not (Test-Path $smapiSrc)) {
    Write-Host "[X] 找不到 SMAPI 文件包: $smapiSrc" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}
$copied = 0
Get-ChildItem $smapiSrc | ForEach-Object {
    $dest = Join-Path $game $_.Name
    Copy-Item $_.FullName $dest -Recurse -Force
    $copied++
    Write-Host "  -> $($_.Name)"
}
Write-Host "  完成: $copied 个文件/文件夹" -ForegroundColor Green

Write-Host ""
Write-Host "[2/4] 创建 Mods 文件夹..." -ForegroundColor Yellow
$modsDir = Join-Path $game "Mods"
New-Item -ItemType Directory -Force -Path $modsDir | Out-Null
Write-Host "  -> $modsDir" -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] 安装 NagiBridge mod..." -ForegroundColor Yellow
$nagiSrc = Join-Path $scriptDir "downloads\NagiBridge-extracted\NagiBridge"
if (-not (Test-Path $nagiSrc)) {
    Write-Host "[X] 找不到 NagiBridge mod 文件夹: $nagiSrc" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}
$nagiDest = Join-Path $modsDir "NagiBridge"
Copy-Item $nagiSrc $nagiDest -Recurse -Force
Write-Host "  -> NagiBridge.dll + manifest.json" -ForegroundColor Green

Write-Host ""
Write-Host "[4/4] 验证安装..." -ForegroundColor Yellow
$checks = @(
    @("SMAPI 启动器", (Test-Path "$game\StardewModdingAPI.exe")),
    @("SMAPI 内部文件", (Test-Path "$game\smapi-internal")),
    @("Mods 文件夹", (Test-Path $modsDir)),
    @("NagiBridge.dll", (Test-Path "$nagiDest\NagiBridge.dll")),
    @("NagiBridge manifest.json", (Test-Path "$nagiDest\manifest.json"))
)
$allOk = $true
foreach ($c in $checks) {
    $mark = if ($c[1]) { "OK" } else { "MISSING" }
    $color = if ($c[1]) { "Green" } else { "Red" }
    if (-not $c[1]) { $allOk = $false }
    Write-Host "  [$mark] $($c[0])" -ForegroundColor $color
}

Write-Host ""
if ($allOk) {
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host "  安装成功！" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步:" -ForegroundColor White
    Write-Host "  1. 双击 nagi-butler 文件夹里的 启动管家.bat" -ForegroundColor White
    Write-Host "  2. 用 Steam 启动星露谷（会自动用SMAPI启动）" -ForegroundColor White
    Write-Host "  3. 进入存档后，按 ~ 键打开聊天面板" -ForegroundColor White
    Write-Host "  4. 选 Channel Mode，名字填 Nagi" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "==========================================" -ForegroundColor Red
    Write-Host "  安装不完整，请检查上面的红字" -ForegroundColor Red
    Write-Host "==========================================" -ForegroundColor Red
}
Read-Host "按回车关闭窗口"
