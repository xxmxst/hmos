@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 打包目录
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 最新安装包和便携版
echo ==================================================
echo.

if not exist "release" (
  echo [提示] release 目录尚不存在，请先运行打包命令。
  set "EXIT_CODE=1"
  goto :finish
)

powershell.exe -NoProfile -Command "Get-ChildItem -LiteralPath '.\release' -File -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 10 FullName,@{N='大小(MiB)';E={[math]::Round($_.Length/1MB,1)}},LastWriteTime | Format-Table -AutoSize"
echo.
echo [完成] 正在打开：%CD%\release
start "" explorer.exe "%CD%\release"

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
