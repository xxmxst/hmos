@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 安装项目依赖
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 正在安装或更新项目依赖
echo ==================================================
echo.

if not exist "package.json" (
  echo [失败] 当前目录不是项目根目录。
  set "EXIT_CODE=1"
  goto :finish
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo [失败] 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  set "EXIT_CODE=1"
  goto :finish
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [失败] 未找到 npm.cmd，请重新安装 Node.js。
  set "EXIT_CODE=1"
  goto :finish
)

call npm.cmd install
set "EXIT_CODE=%ERRORLEVEL%"
chcp 936 >nul
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [失败] 依赖安装失败，退出码：%EXIT_CODE%
) else (
  echo.
  echo [完成] 项目依赖已经安装。
)

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
