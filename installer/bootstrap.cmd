@echo off
rem ============================================================
rem  AdaptiveAIStudio - set up on a machine with nothing installed
rem
rem  Usage: bootstrap.cmd [destination]
rem  Default destination: %LOCALAPPDATA%\Programs\AdaptiveAIStudio
rem  That is where Windows puts per-user programs (same place VS Code
rem  installs itself without admin rights). Never dump a folder at the
rem  root of C:.
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
setlocal
title AdaptiveAIStudio

set "DEST=%~1"
if "%DEST%"=="" set "DEST=%LOCALAPPDATA%\Programs\AdaptiveAIStudio"
rem Full path without a trailing backslash. With "Z:\AAS\" the work folder
rem below became "Z:\AAS\.setup", inside DEST again. A drive root keeps its
rem backslash; bundle.mjs then refuses to build instead of deleting anything.
for %%I in ("%DEST%") do set "DEST=%%~fI"
if not "%DEST:~-2%"==":\" if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

set "REPO=https://github.com/Maguro-JP/AdaptiveAIStudio"
set "BRANCH=main"
rem Needs 22.6+ to run TypeScript by stripping types.
set "NODEVER=v24.18.0"

echo.
echo   AdaptiveAIStudio を用意します
echo   置き場所: %DEST%
echo.

rem A full-width user name makes this path full-width too, and llama.cpp
rem cannot open models from there. The app moves models alone to
rem %ProgramData%\AdaptiveAIStudio\models in that case (see
rem src/core/home.ts, asciiModelsDir). Nothing to refuse here.
echo %DEST%| findstr /R "[^ -~]" >nul
if not errorlevel 1 goto :noteFullwidth
goto :checkTools

:noteFullwidth
echo   置き場所に全角が含まれています。モデルだけ ProgramData へ置きます。
echo.

:checkTools
where curl >nul 2>nul
if errorlevel 1 goto :noTools
where tar >nul 2>nul
if errorlevel 1 goto :noTools

mkdir "%DEST%" 2>nul
cd /d "%DEST%"
if errorlevel 1 goto :badDest

rem The work folder sits next to DEST, not inside it. bundle.mjs clears
rem DEST before building, which used to delete the downloaded source
rem and node.exe halfway through (and data\ on a reinstall).
rem
rem One run at a time. A second double-click used to rmdir the first
rem run's folder halfway through. mkdir fails when the folder already
rem exists, so exactly one run gets the lock. Every exit below removes it.
set "LOCK=%DEST%.setup-lock"
mkdir "%LOCK%" 2>nul
if errorlevel 1 goto :busy
set "WORK=%DEST%.setup"
rmdir /s /q "%WORK%" 2>nul
mkdir "%WORK%"
if errorlevel 1 goto :badDestLocked

echo   [1/4] 中身を取ってきます
rem Pin the commit first, then fetch that very commit. The version stamped
rem below is the package version plus this commit, so "doctor" can tell
rem two bootstrap installs apart (it used to say "main-bootstrap" always).
rem If the API is unreachable, fall back to the branch; the version then
rem says "+main" and does not claim a commit it did not check.
set "SHA="
set "REF=refs/heads/%BRANCH%"
set "STAMP=+%BRANCH%-bootstrap"
curl -fsSL --retry 2 -H "Accept: application/vnd.github.sha" -o "%WORK%\sha.txt" "https://api.github.com/repos/Maguro-JP/AdaptiveAIStudio/commits/%BRANCH%" 2>nul
if errorlevel 1 goto :fetchSource
set /p SHA=<"%WORK%\sha.txt"
if not defined SHA goto :fetchSource
if "%SHA:~39,1%"=="" goto :noSha
if not "%SHA:~40,1%"=="" goto :noSha
set "REF=%SHA%"
set "STAMP=+%SHA:~0,7%-bootstrap"
goto :fetchSource
:noSha
set "SHA="
:fetchSource
curl -fL --retry 3 -o "%WORK%\src.zip" "%REPO%/archive/%REF%.zip"
if errorlevel 1 goto :netfail
tar -xf "%WORK%\src.zip" -C "%WORK%"
if errorlevel 1 goto :cannotUnpack

set "SRC="
for /d %%d in ("%WORK%\AdaptiveAIStudio-*") do set "SRC=%%~fd"
if not defined SRC goto :cannotUnpack

echo   [2/4] Node を取ってきます（%NODEVER%）
rem Fetch as node.bin. The work PC's cloud drive (Z:) drops files by
rem their .exe name, and node.exe never arrived there. Then try to use it
rem as node.exe: copy and run it. Only if that runs is the .exe kept;
rem otherwise node.bin is what gets installed (start.cmd looks for both).
rem cmd.exe runs a file whose extension is listed in PATHEXT, so .BIN is
rem added for this window, the same as start.cmd does.
curl -fL --retry 3 -o "%WORK%\node.bin" "https://nodejs.org/dist/%NODEVER%/win-x64/node.exe"
if errorlevel 1 goto :netfail
set "NODENAME=node.exe"
copy /y "%WORK%\node.bin" "%WORK%\node.exe" >nul 2>nul
"%WORK%\node.exe" -v >nul 2>nul
if not errorlevel 1 goto :build
set "NODENAME=node.bin"
set "PATHEXT=.BIN;%PATHEXT%"
goto :noteBin

:build
echo   [3/4] 組み立てます
"%WORK%\%NODENAME%" "%SRC%\scripts\bundle.mjs" --out "%DEST%" --src "%SRC%" --node-exe "%WORK%\%NODENAME%" --node-name %NODENAME% --keep-data --version "%STAMP%"
if errorlevel 1 goto :cannotBuild

rmdir /s /q "%WORK%" 2>nul

echo   [4/4] 確かめます
"%DEST%\runtime\%NODENAME%" -v
if errorlevel 1 goto :nodeBroken
echo         試験を回します。数分かかります（画面はその間、止まって見えます）。
"%DEST%\runtime\%NODENAME%" "%DEST%\app\scripts\run-tests.mjs" >nul 2>&1
if errorlevel 1 goto :testsRed
echo         試験を通りました
goto :checked

:testsRed
echo         試験に失敗がありました。入口の 4 番（動くか確かめる）で、どこが動かないかを見られます。

:checked
rmdir "%LOCK%" 2>nul
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

:badDestLocked
rmdir "%LOCK%" 2>nul
goto :badDest

:busy
echo   もう一つの用意が動いています。終わってから、もう一度ダブルクリックしてください。
echo   動いていないのにこう出るときは、前の回が途中で閉じられています。
echo   次の空のフォルダを消してから、やり直してください（中身は無く、消しても何も失いません）:
echo     %LOCK%
echo.
pause
exit /b 1

:noteBin
echo         この場所には .exe を置けないので、Node を node.bin の名前で入れます。
goto :build

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
rmdir "%LOCK%" 2>nul
pause
exit /b 1
