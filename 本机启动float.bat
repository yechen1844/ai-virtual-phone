@echo off
chcp 65001 >nul 2>nul
title float 本地启动
cd /d "%~dp0"
echo ============================================
echo   float 本地服务器启动中...
echo ============================================
echo.
echo 启动后，请在浏览器打开： http://localhost:3001
echo 关闭这个窗口，float 就会停止。
echo.
node --max-old-space-size=4096 scripts/local-next-server.mjs --dev
pause
