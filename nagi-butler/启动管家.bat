@echo off
chcp 65001 >nul 2>nul
title Nagi Butler (message relay)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js not found.
  echo     Please install LTS version from https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo ============================================
echo   Nagi Butler starting... (minimize this window)
echo   Stop: close this window or press Ctrl+C
echo ============================================
echo.
node "%~dp0butler.mjs" --config "%~dp0config.json"
echo.
echo Butler stopped.
echo.
pause
