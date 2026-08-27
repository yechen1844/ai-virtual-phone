@echo off
chcp 65001 >nul 2>nul
title Installing SMAPI and NagiBridge
cd /d "%~dp0"
echo.
echo ==========================================
echo   Installing to: Stardew Valley (Steam)
echo ==========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] Script reported an error. See messages above.
)
echo.
echo.
echo ==========================================
echo   Script finished. Press any key to close.
echo ==========================================
pause >nul
