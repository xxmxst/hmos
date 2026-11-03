@echo off
setlocal
chcp 936 >nul
title 鸿蒙投屏助手 - 常用命令
pushd "%~dp0"

:menu
cls
echo ==================================================
echo              鸿蒙投屏助手 - 常用命令
echo ==================================================
echo.
echo   1. 启动开发版
echo   2. 查看手机连接
echo   3. 安装项目依赖
echo   4. 运行自动测试
echo   5. 完整检查
echo   6. 快速打包
echo   7. 完整打包
echo   8. 打开打包目录
echo   0. 退出
echo.
set "MENU_CHOICE="
set /p "MENU_CHOICE=请输入编号后按回车："

if "%MENU_CHOICE%"=="1" call "%~dp001-启动开发版.bat"
if "%MENU_CHOICE%"=="2" call "%~dp002-查看手机连接.bat"
if "%MENU_CHOICE%"=="3" call "%~dp003-安装项目依赖.bat"
if "%MENU_CHOICE%"=="4" call "%~dp004-运行自动测试.bat"
if "%MENU_CHOICE%"=="5" call "%~dp005-完整检查.bat"
if "%MENU_CHOICE%"=="6" call "%~dp006-快速打包.bat"
if "%MENU_CHOICE%"=="7" call "%~dp007-完整打包.bat"
if "%MENU_CHOICE%"=="8" call "%~dp008-打开打包目录.bat"
if "%MENU_CHOICE%"=="0" goto :quit

if not "%MENU_CHOICE%"=="1" if not "%MENU_CHOICE%"=="2" if not "%MENU_CHOICE%"=="3" if not "%MENU_CHOICE%"=="4" if not "%MENU_CHOICE%"=="5" if not "%MENU_CHOICE%"=="6" if not "%MENU_CHOICE%"=="7" if not "%MENU_CHOICE%"=="8" (
  echo.
  echo [提示] 请输入 0 到 8 之间的数字。
  if not defined HMR_NO_PAUSE pause
)
goto :menu

:quit
popd
endlocal
exit /b 0
