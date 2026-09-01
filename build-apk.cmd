@echo off
chcp 65001 >nul 2>&1
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0build-apk.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ========================================
    echo   Build failed. Exit code: %ERRORLEVEL%
    echo ========================================
    echo.
    pause
)
