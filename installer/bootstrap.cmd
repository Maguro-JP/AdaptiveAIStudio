@echo off
rem ============================================================
rem  AdaptiveAIStudio — 何も入っていない機械に、一式を用意する
rem
rem  使い方: bootstrap.cmd C:\AAS
rem          （渡さなければ、このファイルの隣に作る）
rem
rem  要るもの: Windows 10 以降だけ。
rem    curl と tar は Windows に最初から入っている。
rem    git も Node も npm も管理者権限も要らない。
rem
rem  作るもの: 配布物と同じ形。
rem    AdaptiveAIStudio.cmd / README.txt / VERSION / app\ / runtime\
rem
rem    形を揃えるために、**落とした Node で組み立てまでやらせる**。
rem    ここで組み立て方を書き写すと、配布物と食い違う
rem    （実際に一度、Node の置き場所が三箇所で食い違った）。
rem ============================================================
chcp 65001 >nul 2>nul
setlocal
title AdaptiveAIStudio — 用意

set "DEST=%~1"
if "%DEST%"=="" set "DEST=%~dp0AdaptiveAIStudio"

set "REPO=https://github.com/Maguro-JP/AdaptiveAIStudio"
set "BRANCH=main"
rem 型注釈をそのまま実行する仕組みが要るので、22.6 以降であること。
set "NODEVER=v24.18.0"

echo.
echo   AdaptiveAIStudio を用意します
echo   置き場所: %DEST%
echo.

rem --- 全角の混ざる場所を避ける ------------------------------
rem llama.cpp 系は、全角を含むパスのモデルを開けないことがある。
rem 後で分かると 数GB 落とし直しになるので、取ってくる前に止める。
echo %DEST%| findstr /R "[^ -~]" >nul
if not errorlevel 1 (
  echo   [止めました] 置き場所に全角や日本語が入っています。
  echo     %DEST%
  echo.
  echo   モデルを開く段で詰まります。半角英数字だけの場所を渡してください。
  echo     例:  bootstrap.cmd C:\AAS
  echo.
  pause
  exit /b 1
)

rem --- 道具があるか ------------------------------------------
where curl >nul 2>nul || (echo   curl が見つかりません。Windows 10 以降が要ります。& pause & exit /b 1)
where tar  >nul 2>nul || (echo   tar が見つかりません。Windows 10 以降が要ります。& pause & exit /b 1)

mkdir "%DEST%" 2>nul
cd /d "%DEST%" || (echo   その場所に入れませんでした: %DEST% & pause & exit /b 1)

rem 途中のものは、名前で分けておく。組み立てが終わったら消す。
set "WORK=%DEST%\.setup"
rmdir /s /q "%WORK%" 2>nul
mkdir "%WORK%" || (echo   作業場所を作れませんでした & pause & exit /b 1)

rem --- 中身を取ってくる --------------------------------------
echo   [1/4] 中身を取ってきます
curl -fL --retry 3 -o "%WORK%\src.zip" "%REPO%/archive/refs/heads/%BRANCH%.zip" || goto netfail
tar -xf "%WORK%\src.zip" -C "%WORK%" || (echo   展開できませんでした & goto fail)

rem zip の中は AdaptiveAIStudio-main\ の一階層下にある。
set "SRC="
for /d %%d in ("%WORK%\AdaptiveAIStudio-*") do set "SRC=%%~fd"
if not defined SRC (echo   中身が見つかりませんでした & goto fail)

rem --- Node を取ってくる -------------------------------------
echo   [2/4] Node を取ってきます（%NODEVER%・この中だけに置きます）
curl -fL --retry 3 -o "%WORK%\node.exe" "https://nodejs.org/dist/%NODEVER%/win-x64/node.exe" || goto netfail

rem --- 配布物と同じ形に組み立てる ----------------------------
rem 組み立て方は書き写さない。落とした Node に、中身側の組み立て器を走らせる。
echo   [3/4] 組み立てます
"%WORK%\node.exe" "%SRC%\scripts\bundle.mjs" --out "%DEST%" --src "%SRC%" ^
  --node-exe "%WORK%\node.exe" --version "%BRANCH%-bootstrap" || (echo   組み立てに失敗しました & goto fail)

rmdir /s /q "%WORK%" 2>nul

rem --- 確かめる -----------------------------------------------
echo   [4/4] 確かめます
"%DEST%\runtime\node.exe" -v || (echo   Node が動きませんでした & pause & exit /b 1)
"%DEST%\runtime\node.exe" "%DEST%\app\scripts\run.mjs" test >nul 2>&1
if errorlevel 1 (
  echo         検査に失敗がありました。入口の 6 番で中身を見られます。
) else (
  echo         検査を通りました
)

echo.
echo   用意できました: %DEST%
echo   AdaptiveAIStudio.cmd をダブルクリックして始めてください。
echo.
pause
exit /b 0

:netfail
echo.
echo   取ってこられませんでした。
echo   会社の網だと、外への接続が塞がれていることがあります。
echo   その場合は、繋がる機械で用意したフォルダを、そのまま持ってきてください
echo   （このフォルダは、置くだけで動きます）。
echo.
:fail
rmdir /s /q "%WORK%" 2>nul
pause
exit /b 1
