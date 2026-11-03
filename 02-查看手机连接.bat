@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 查看手机连接
pushd "%~dp0"
set "EXIT_CODE=0"
set "HDC_EXE="

echo ==================================================
echo 正在检查 HDC 和手机连接
echo ==================================================
echo.

if defined HMR_HDC_PATH if exist "%HMR_HDC_PATH%" set "HDC_EXE=%HMR_HDC_PATH%"
if not defined HDC_EXE if exist "vendor\hdc\hdc.exe" set "HDC_EXE=%CD%\vendor\hdc\hdc.exe"
if not defined HDC_EXE if exist "D:\hdc\hdc.exe" set "HDC_EXE=D:\hdc\hdc.exe"
if not defined HDC_EXE (
  for /f "delims=" %%I in ('where hdc.exe 2^>nul') do if not defined HDC_EXE set "HDC_EXE=%%I"
)

if not defined HDC_EXE (
  echo [失败] 未找到 hdc.exe。
  echo 请设置 HMR_HDC_PATH，或将新版 HDC 放入 vendor\hdc。
  set "EXIT_CODE=1"
  goto :finish
)

echo HDC 路径：%HDC_EXE%
echo.
echo ---------------- HDC 版本 ----------------
"%HDC_EXE%" -v
set "HDC_RESULT=%ERRORLEVEL%"
chcp 936 >nul
if not "%HDC_RESULT%"=="0" (
  echo [失败] 无法运行 HDC。
  set "EXIT_CODE=1"
  goto :finish
)
echo.
echo ---------------- 设备列表 ----------------
"%HDC_EXE%" list targets -v
set "HDC_RESULT=%ERRORLEVEL%"
chcp 936 >nul
set "EXIT_CODE=%HDC_RESULT%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [失败] 无法读取设备列表，退出码：%EXIT_CODE%
) else (
  echo.
  echo [提示] 手机状态应显示为 Ready 或 Connected。
)

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
