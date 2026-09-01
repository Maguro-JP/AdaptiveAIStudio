@echo off
rem ============================================================
rem  AdaptiveAIStudio — 何も入っていない機械に、一式を用意する
rem
rem  使い方: このファイルを置いた場所で、ダブルクリック。
rem          または  bootstrap.cmd D:\AAS   のように置き場所を渡す。
rem
rem  要るもの: Windows 10 以降だけ。
rem    curl と tar は Windows に最初から入っている。
rem    git も Node も npm も管理者権限も要らない。
rem
rem  入れるもの: 渡したフォルダの中だけ。この機械には何も残らない。
rem              フォルダごと消せば、跡形もなくなる。
rem ============================================================
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
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
rem 後で分かると 数GB 落とし直しになるので、ここで止める。
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

rem --- 中身を取ってくる --------------------------------------
echo   [1/3] 中身を取ってきます
curl -fL --retry 3 -o src.zip "%REPO%/archive/refs/heads/%BRANCH%.zip" || goto netfail
tar -xf src.zip || (echo   展開できませんでした & pause & exit /b 1)
rem zip の中は AdaptiveAIStudio-main\ の一階層下にある。平らに移す。
for /d %%d in (AdaptiveAIStudio-*) do (
  xcopy "%%d" "%DEST%" /E /I /Y /Q >nul
  rmdir /s /q "%%d"
)
del src.zip 2>nul

rem --- Node を取ってくる -------------------------------------
echo   [2/3] Node を取ってきます（%NODEVER%・この中だけに置きます）
if exist "node\node.exe" (
  echo         すでにあります
) else (
  curl -fL --retry 3 -o node.exe "https://nodejs.org/dist/%NODEVER%/win-x64/node.exe" || goto netfail
  mkdir node 2>nul
  move /y node.exe node\node.exe >nul
)

rem --- 目印 ---------------------------------------------------
rem これがあると、記録もモデルも実行ファイルも、この中の aas-home に入る。
> portable.txt echo このフォルダは「持ち運び版」です。
>> portable.txt echo.
>> portable.txt echo 記録・モデル・実行ファイルは、すべて隣の aas-home に入ります。
>> portable.txt echo この機械には何も残りません。フォルダごと消せば、跡形もなくなります。
>> portable.txt echo.
>> portable.txt echo 始め方: start.cmd をダブルクリック

echo   [3/3] 確かめます
"node\node.exe" -v || (echo   Node が動きませんでした & pause & exit /b 1)
"node\node.exe" scripts\run.mjs test >nul 2>&1
if errorlevel 1 (
  echo         検査に失敗がありました。start.cmd の 6 番で中身を見られます。
) else (
  echo         検査を通りました
)

echo.
echo   用意できました: %DEST%
echo   start.cmd をダブルクリックして始めてください。
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
pause
exit /b 1
