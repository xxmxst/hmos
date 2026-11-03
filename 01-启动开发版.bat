@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 启动开发版
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 正在启动鸿蒙投屏助手开发版
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
if not exist "node_modules\.bin\electron.cmd" (
  echo [失败] 项目依赖尚未安装。
  echo 请先双击“03-安装项目依赖.bat”。
  set "EXIT_CODE=1"
  goto :finish
)

echo [提示] 如果已有投屏窗口正在运行，请先关闭它，避免桥接 JAR 被占用。
echo.
call npm.cmd start
set "EXIT_CODE=%ERRORLEVEL%"
chcp 936 >nul
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [失败] 开发版启动失败，退出码：%EXIT_CODE%
) else (
  echo.
  echo [完成] 开发版已正常退出。
)

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
