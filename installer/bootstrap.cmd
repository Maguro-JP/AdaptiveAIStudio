@echo off
rem ============================================================
rem  AdaptiveAIStudio - set up on a machine with nothing installed
rem
rem  Usage: bootstrap.cmd C:\AAS
rem  Needs Windows 10+ only. curl and tar ship with Windows.
rem  No git, no Node, no npm, no admin rights.
rem
rem  Produces the same shape as the distribution:
rem    AdaptiveAIStudio.cmd / README.txt / VERSION / app\ / runtime\
rem  The layout is built by the app's own bundle.mjs, not spelled out
rem  here. Spelling it out here is how it drifted last time (Node ended
rem  up in three different places).
rem
rem  RULE: no non-ASCII inside ( ) blocks or after ||.
rem  cmd.exe parses a block as one unit; multi-byte characters break it
rem  and the fragments get executed as commands. Use goto labels, and
rem  keep Japanese in label bodies only (those are messages for people).
rem ============================================================
chcp 65001 >nul 2>nul
setlocal
title AdaptiveAIStudio

set "DEST=%~1"
if "%DEST%"=="" set "DEST=%~dp0AdaptiveAIStudio"

set "REPO=https://github.com/Maguro-JP/AdaptiveAIStudio"
set "BRANCH=main"
rem Needs 22.6+ to run TypeScript by stripping types.
set "NODEVER=v24.18.0"

echo.
echo   AdaptiveAIStudio を用意します
echo   置き場所: %DEST%
echo.

rem Refuse full-width paths before downloading anything: llama.cpp
rem cannot open models under them, and finding out later means
rem re-downloading several GB.
echo %DEST%| findstr /R "[^ -~]" >nul
if not errorlevel 1 goto :fullwidth

where curl >nul 2>nul
if errorlevel 1 goto :noTools
where tar >nul 2>nul
if errorlevel 1 goto :noTools

mkdir "%DEST%" 2>nul
cd /d "%DEST%"
if errorlevel 1 goto :badDest

set "WORK=%DEST%\.setup"
rmdir /s /q "%WORK%" 2>nul
mkdir "%WORK%"
if errorlevel 1 goto :badDest

echo   [1/4] 中身を取ってきます
curl -fL --retry 3 -o "%WORK%\src.zip" "%REPO%/archive/refs/heads/%BRANCH%.zip"
if errorlevel 1 goto :netfail
tar -xf "%WORK%\src.zip" -C "%WORK%"
if errorlevel 1 goto :cannotUnpack

set "SRC="
for /d %%d in ("%WORK%\AdaptiveAIStudio-*") do set "SRC=%%~fd"
if not defined SRC goto :cannotUnpack

echo   [2/4] Node を取ってきます（%NODEVER%）
curl -fL --retry 3 -o "%WORK%\node.exe" "https://nodejs.org/dist/%NODEVER%/win-x64/node.exe"
if errorlevel 1 goto :netfail

echo   [3/4] 組み立てます
"%WORK%\node.exe" "%SRC%\scripts\bundle.mjs" --out "%DEST%" --src "%SRC%" --node-exe "%WORK%\node.exe" --version "%BRANCH%-bootstrap"
if errorlevel 1 goto :cannotBuild

rmdir /s /q "%WORK%" 2>nul

echo   [4/4] 確かめます
"%DEST%\runtime\node.exe" -v
if errorlevel 1 goto :nodeBroken
"%DEST%\runtime\node.exe" "%DEST%\app\scripts\run-tests.mjs" >nul 2>&1
if errorlevel 1 goto :testsRed
echo         検査を通りました
goto :checked

:testsRed
echo         検査に失敗がありました。入口の 6 番で中身を見られます。

:checked
echo.
echo   用意できました: %DEST%
echo   AdaptiveAIStudio.cmd をダブルクリックして始めてください。
echo.
pause
exit /b 0

rem ============================================================
rem  Messages only. Keeping them here is what lets the control flow
rem  above stay ASCII.
rem ============================================================

:fullwidth
echo   [止めました] 置き場所に全角や日本語が入っています。
echo     %DEST%
echo.
echo   モデルを開く段で詰まります。半角英数字だけの場所を渡してください。
echo     例:  bootstrap.cmd C:\AAS
echo.
pause
exit /b 1

:noTools
echo   curl と tar が要ります。Windows 10 以降なら最初から入っています。
echo.
pause
exit /b 1

:badDest
echo   その場所を使えませんでした: %DEST%
echo.
pause
exit /b 1

:cannotUnpack
echo   取ってきたものを展開できませんでした。
goto :fail

:cannotBuild
echo   組み立てに失敗しました。
goto :fail

:nodeBroken
echo   同梱した Node が動きませんでした。
goto :fail

:netfail
echo.
echo   取ってこられませんでした。
echo   会社の網だと、外への接続が塞がれていることがあります。
echo   その場合は、繋がる機械で次を叩いて、出来たフォルダを持ってきてください。
echo     npm run bundle
echo   このフォルダは、置くだけで動きます。
goto :fail

:fail
echo.
rmdir /s /q "%WORK%" 2>nul
pause
exit /b 1
