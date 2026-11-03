@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 自动测试
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 正在运行自动测试
echo ==================================================
echo.

if not exist "node_modules\.bin\vitest.cmd" (
  echo [失败] 项目依赖尚未安装。
  echo 请先双击“03-安装项目依赖.bat”。
  set "EXIT_CODE=1"
  goto :finish
)

call npm.cmd test
set "EXIT_CODE=%ERRORLEVEL%"
chcp 936 >nul
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [失败] 自动测试未通过，退出码：%EXIT_CODE%
) else (
  echo.
  echo [完成] 所有自动测试均已通过。
)

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
