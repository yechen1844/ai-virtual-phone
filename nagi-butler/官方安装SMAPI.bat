@echo off
chcp 65001 >nul 2>nul
title Full setup: SMAPI (official) + NagiBridge
cd /d "%~dp0"

set GAME=E:\SteamLibrary\steamapps\common\Stardew Valley
set INSTALLER=%~dp0downloads\SMAPI-installer\SMAPI 4.5.2 installer\internal\windows\SMAPI.Installer.exe

echo ============================================================
echo   Full Setup: official SMAPI installer + NagiBridge mod
echo ============================================================
echo.
echo   Game folder: %GAME%
echo.

echo [Step 1/3] Restore original game exe (undo manual patch)...
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$g='E:\SteamLibrary\steamapps\common\Stardew Valley'; $bak=Join-Path $g 'Stardew Valley.exe.bak'; if(Test-Path $bak){ Copy-Item $bak (Join-Path $g 'Stardew Valley.exe') -Force; Write-Host '  OK: restored original Stardew Valley.exe from .bak' } else { Write-Host '  No .bak, nothing to restore' }"
echo.

echo [Step 2/3] Run official SMAPI installer (interactive)...
echo ------------------------------------------------------------
echo   A console will appear with SMAPI installer.
echo   It usually shows a menu like:
echo     [1] Apply / install SMAPI
echo     [2] Uninstall
echo   TYPE 1  and press  ENTER   to install.
echo   If it lists multiple games, pick the number for Stardew Valley.
echo   When it finishes, it says "SMAPI is installed!".
echo.
echo   >>> Press any key to launch the installer now <<<
pause >nul

"%INSTALLER%" --game-path "%GAME%"

echo.
echo [Step 3/3] Install NagiBridge mod into Mods folder...
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$g='E:\SteamLibrary\steamapps\common\Stardew Valley'; $mods=Join-Path $g 'Mods'; New-Item -ItemType Directory -Force -Path $mods | Out-Null; $src='$PSScriptRoot\downloads\NagiBridge-extracted\NagiBridge'; $src=$src -replace '\$PSScriptRoot','$PWD'; $srcFull=Join-Path $PWD 'downloads\NagiBridge-extracted\NagiBridge'; $dest=Join-Path $mods 'NagiBridge'; Copy-Item $srcFull $dest -Recurse -Force; Write-Host '  OK: NagiBridge installed'; Write-Host ('  DLL exists: ' + (Test-Path (Join-Path $dest 'NagiBridge.dll'))); Write-Host ('  manifest exists: ' + (Test-Path (Join-Path $dest 'manifest.json')))"
echo.

echo ============================================================
echo   Verifying...
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$g='E:\SteamLibrary\steamapps\common\Stardew Valley'; $c=@(); $c+=@('SMAPI launcher', (Test-Path (Join-Path $g 'StardewModdingAPI.exe'))); $c+=@('smapi-internal', (Test-Path (Join-Path $g 'smapi-internal'))); $c+=@('Mods folder', (Test-Path (Join-Path $g 'Mods'))); $c+=@('NagiBridge.dll', (Test-Path (Join-Path $g 'Mods\NagiBridge\NagiBridge.dll'))); $c+=@('manifest.json', (Test-Path (Join-Path $g 'Mods\NagiBridge\manifest.json'))); foreach($i in $c){ if($i -is [bool]){ $m=if($i){'OK'}else{'MISSING'}; $col=if($i){'Green'}else{'Red'}; Write-Host ('  ['+$m+'] '+$prev) -ForegroundColor $col } else { $prev=$i } }"

echo.
echo ============================================================
echo   Done. Press any key to close.
echo ============================================================
pause >nul
