@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 完整打包
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 完整打包：准备 SDK、JRE 并生成发布包
echo ==================================================
echo.

if not exist "node_modules\.bin\electron-builder.cmd" (
  echo [失败] 项目依赖尚未安装。
  echo 请先双击“03-安装项目依赖.bat”。
  set "EXIT_CODE=1"
  goto :finish
)
if not exist "vendor\hdc\hdc.exe" (
  echo [失败] 缺少 vendor\hdc\hdc.exe，请先放入完整的新版 HDC。
  set "EXIT_CODE=1"
  goto :finish
)

call :check_jar_available
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto :finish
)

echo [提示] 完整打包可能需要下载 SDK，并重新生成最小 JRE。
echo [警告] release 中相同版本的安装包和便携版可能被覆盖。
choice /C YN /N /M "确认继续完整打包吗？[Y/N] "
if errorlevel 2 (
  echo [取消] 未执行打包。
  goto :finish
)

echo.
call :run_npm run dist
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [失败] 完整打包失败，退出码：%EXIT_CODE%
  goto :finish
)

echo.
echo [完成] 完整打包成功，最新产物如下：
call :show_packages
goto :finish

:run_npm
call npm.cmd %*
set "COMMAND_RESULT=%ERRORLEVEL%"
chcp 936 >nul
exit /b %COMMAND_RESULT%

:show_packages
powershell.exe -NoProfile -Command "Get-ChildItem -LiteralPath '.\release' -File -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName,@{N='SizeMiB';E={[math]::Round($_.Length/1MB,1)}},LastWriteTime | Format-Table -AutoSize"
chcp 936 >nul
exit /b 0

:check_jar_available
powershell.exe -NoProfile -Command "$jar=Join-Path $pwd.Path 'bridge\build\hmremote-bridge.jar'; if(-not (Test-Path -LiteralPath $jar)){exit 0}; try{$stream=[IO.File]::Open($jar,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $stream.Dispose(); exit 0}catch{exit 1}"
set "LOCK_RESULT=%ERRORLEVEL%"
chcp 936 >nul
if not "%LOCK_RESULT%"=="0" (
  echo [失败] Java 桥接 JAR 正在被投屏程序占用。
  echo 请关闭正在运行的鸿蒙投屏助手后重试。
)
exit /b %LOCK_RESULT%

:finish
echo.
if not defined HMR_NO_PAUSE pause
popd
endlocal & exit /b %EXIT_CODE%
