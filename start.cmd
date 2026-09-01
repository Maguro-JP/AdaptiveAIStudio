@echo off
rem ============================================================
rem  AdaptiveAIStudio 起動用
rem
rem  ダブルクリックで開く入口。npm を覚えていなくても始められる。
rem  引数を付ければ、選ぶところは飛ばせる:  start.cmd ui
rem
rem  この窓は、失敗しても勝手に閉じない。
rem  一瞬で閉じて何も分からない、が一番困るため。
rem ============================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title AdaptiveAIStudio

rem --- Node を探す -----------------------------------------
rem 同梱していれば、そちらを使う。会社の機械のように
rem 何も入れられない場所では、これだけが頼りになる。
set NODE=node
set NPM=npm
set RUNNER=npm
if exist "%~dp0node\node.exe" (
  set "NODE=%~dp0node\node.exe"
  set "PATH=%~dp0node;%PATH%"
  echo   Node は同梱のものを使います
  rem npm まで同梱していないことがある。無ければ package.json を
  rem 直接読んで動かす（scripts/run.mjs）。二重に書き写さないので、ずれない。
  if exist "%~dp0node\npm.cmd" (
    set "NPM=%~dp0node\npm.cmd"
  ) else (
    set RUNNER=direct
  )
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Node.js が見つかりません。
    echo   https://nodejs.org/ から LTS 版を入れるか、
    echo   Node を同梱した持ち運び版を使ってください。
    echo.
    pause
    exit /b 1
  )
)

for /f "tokens=*" %%v in ('"%NODE%" -v') do set NODEV=%%v
echo   Node %NODEV%

rem 依存は入れない。実行時の依存はゼロで、npm install は要らない。
rem （型検査 npm run typecheck を使うときだけ、手動で入れる）

rem --- 何をするか ------------------------------------------
set TASK=%1
if not "%TASK%"=="" goto run

echo.
echo   AdaptiveAIStudio
echo   ----------------------------------------
echo    1  画面をひらく          （ふだんはこれ）
echo    2  端末で作業させる
echo    3  ただの相談
echo    4  この環境を見てもらう
echo    5  手元のモデルを見る
echo    6  検査を回す
echo    7  新しくする
echo    8  この機械で確かめる
echo    0  やめる
echo.
set /p CHOICE="   番号を入れて Enter: "

if "%CHOICE%"=="1" set TASK=ui
if "%CHOICE%"=="2" set TASK=agent
if "%CHOICE%"=="3" set TASK=chat
if "%CHOICE%"=="4" set TASK=doctor
if "%CHOICE%"=="5" set TASK=models
if "%CHOICE%"=="6" set TASK=test
if "%CHOICE%"=="7" set TASK=update
if "%CHOICE%"=="8" set TASK=selftest
if "%CHOICE%"=="0" exit /b 0
if "%TASK%"=="" (
  echo   その番号はありません。
  echo.
  pause
  exit /b 1
)

:run
echo.

rem 更新は、取り込んだあと立ち上げ直すところまでが一続き。
rem 動いているコードと置いてあるコードがズレたまま使わせない。
if not "%TASK%"=="update" goto normal
if "%RUNNER%"=="direct" ( call "%NODE%" scripts/run.mjs update ) else ( call "%NPM%" run update )
echo.
set /p AGAIN="   立ち上げ直しますか？ [Y/n]: "
if /i "%AGAIN%"=="n" exit /b 0
"%~f0"
exit /b %errorlevel%

:normal
if "%RUNNER%"=="direct" (
  call "%NODE%" scripts/run.mjs %TASK%
) else (
  call "%NPM%" run %TASK%
)
set CODE=%errorlevel%

rem --- 終わり方 --------------------------------------------
rem 正常に終わったときも窓を残す。すぐ閉じると、
rem 最後に何が出ていたのかを読む間がない。
echo.
if not "%CODE%"=="0" (
  echo   終了コード %CODE% で終わりました。上の内容が手がかりです。
)
pause
endlocal
