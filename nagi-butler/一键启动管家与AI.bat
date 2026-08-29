@echo off
chcp 65001 >nul 2>nul
title Nagi 一键启动 (管家 + char_agent)
cd /d "%~dp0"

echo [1/3] 检查 Node.js ...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] 未找到 Node.js，请先安装 LTS 版本: https://nodejs.org
  pause
  exit /b 1
)
echo      Node.js 已找到。

echo [2/3] 检查 Python ...
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] 未找到 Python，请先安装并勾选 "Add to PATH": https://python.org
  pause
  exit /b 1
)
echo      Python 已找到。

echo [3/3] 正在启动管家 + char_agent ...
echo.
start "Nagi Butler" cmd /k "node butler.mjs --config config.json"
start "Nagi Char Agent" cmd /k "python char_agent.py"

echo.
echo ============================================
echo   已启动两个窗口，请都保持打开！
echo   - 管家窗口：转发消息（可最小化）
echo   - char_agent 窗口：游戏内 AI 执行者
echo.
echo   下一步：浏览器打开 float - 星露谷 App - 绑定 char - 进聊天页
echo ============================================
echo.
pause
