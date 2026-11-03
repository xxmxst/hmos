@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 完整检查
pushd "%~dp0"
set "EXIT_CODE=0"

echo ==================================================
echo 正在执行发布前完整检查
echo ==================================================
echo.

if not exist "node_modules\.bin\tsc.cmd" (
  echo [失败] 项目依赖尚未安装。
  echo 请先双击“03-安装项目依赖.bat”。
  set "EXIT_CODE=1"
  goto :finish
)
if not exist "vendor\sdk\hosScrcpy-1.0.15-beta.jar" (
  echo [失败] 缺少 HOScrcpy SDK。
  echo 可运行“07-完整打包.bat”自动准备，或执行 npm run vendor:sdk。
  set "EXIT_CODE=1"
  goto :finish
)

call :check_jar_available
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto :finish
)

echo [1/5] TypeScript 类型检查
call :run_npm run typecheck
if errorlevel 1 goto :command_failed

echo.
echo [2/5] 自动测试
call :run_npm test
if errorlevel 1 goto :command_failed

echo.
echo [3/5] 应用构建
call :run_npm run build
if errorlevel 1 goto :command_failed

echo.
echo [4/5] Java 桥接冒烟测试
call :run_npm run smoke:bridge
if errorlevel 1 goto :command_failed

echo.
echo [5/5] 离线 OCR 冒烟测试
call :run_npm run smoke:ocr
if errorlevel 1 goto :command_failed

echo.
echo [完成] 类型、测试、构建和冒烟检查均已通过。
goto :finish

:command_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [失败] 完整检查已停止，退出码：%EXIT_CODE%
goto :finish

:run_npm
call npm.cmd %*
set "COMMAND_RESULT=%ERRORLEVEL%"
chcp 936 >nul
exit /b %COMMAND_RESULT%

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
