@echo off
rem ============================================================
rem  AdaptiveAIStudio 起動用
rem
rem  ダブルクリックで開く入口。npm を覚えていなくても始められる。
rem  引数を付ければ、選ぶところは飛ばせる:  start.cmd ui
rem
rem  ■ 日本語を ( ) の中に書かない
rem
rem  cmd.exe は括弧の塊をまとめて解釈する。そこに多バイト文字が入ると
rem  行が壊れ、**壊れた断片をコマンドとして実行する**。
rem  実際にこうなった:
rem      'de\' is not recognized as an internal or external command,
rem      '□か、' is not recognized as an internal or external command,
rem  だから分岐は goto で書き、日本語は括弧の外だけに置く。
rem
rem  先頭に BOM を付けてあるのも同じ理由。無いと cmd.exe は
rem  この中身を console の文字集合（日本語 Windows なら CP932）として
rem  読むので、UTF-8 の日本語が化ける。
rem
rem  この窓は、失敗しても勝手に閉じない。
rem  一瞬で閉じて何も分からない、が一番困るため。
rem ============================================================
setlocal
cd /d "%~dp0"
title AdaptiveAIStudio

rem --- Node を探す -----------------------------------------
rem 同梱していれば、そちらを使う。会社の機械のように
rem 何も入れられない場所では、これだけが頼りになる。
rem 製品の形（app\ の隣の runtime\）を先に見る。
set "BUNDLED="
if exist "%~dp0..\runtime\node.exe" set "BUNDLED=%~dp0..\runtime"
if exist "%~dp0runtime\node.exe" set "BUNDLED=%~dp0runtime"
if exist "%~dp0node\node.exe" set "BUNDLED=%~dp0node"
if defined BUNDLED goto :bundled

where node >nul 2>nul
if errorlevel 1 goto :noNode
set "NODE=node"
set "NPM=npm"
set "RUNNER=npm"
goto :haveNode

:bundled
set "NODE=%BUNDLED%\node.exe"
set "PATH=%BUNDLED%;%PATH%"
rem npm まで同梱していないことがある。無ければ package.json を
rem 直接読んで動かす（scripts/run.mjs）。二重に書き写さないので、ずれない。
set "NPM=npm"
set "RUNNER=direct"
if not exist "%BUNDLED%\npm.cmd" goto :bundledDone
set "NPM=%BUNDLED%\npm.cmd"
set "RUNNER=npm"
:bundledDone
echo   Node は同梱のものを使います

:haveNode
for /f "tokens=*" %%v in ('"%NODE%" -v') do set "NODEV=%%v"
echo   Node %NODEV%

rem --- 版を確かめる ----------------------------------------
rem 型を剥がしながら実行する仕組みを使うので、v22.6 以降が要る。
rem 古いままだと、意味の分からない構文エラーが出るだけで、
rem 「Node が古い」とは誰も気づけない。ここで止めて、そう言う。
set "NMAJOR=0"
set "NMINOR=0"
for /f "tokens=1 delims=v." %%a in ("%NODEV%") do set "NMAJOR=%%a"
for /f "tokens=2 delims=v." %%a in ("%NODEV%") do set "NMINOR=%%a"
set "NODEOLD="
if %NMAJOR% LSS 22 set "NODEOLD=1"
if %NMAJOR% EQU 22 if %NMINOR% LSS 6 set "NODEOLD=1"
if defined NODEOLD goto :oldNode

rem 依存は入れない。実行時の依存はゼロで、npm install は要らない。
rem （型検査 npm run typecheck を使うときだけ、手動で入れる）

rem --- 何をするか ------------------------------------------
set "TASK=%~1"
if not "%TASK%"=="" goto :run

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
echo    9  溜まったものを片づける
echo    0  やめる
echo.
set "CHOICE="
set /p CHOICE="   番号を入れて Enter: "

if "%CHOICE%"=="1" set "TASK=ui"
if "%CHOICE%"=="2" set "TASK=agent"
if "%CHOICE%"=="3" set "TASK=chat"
if "%CHOICE%"=="4" set "TASK=doctor"
if "%CHOICE%"=="5" set "TASK=models"
if "%CHOICE%"=="6" set "TASK=test"
if "%CHOICE%"=="7" set "TASK=update"
if "%CHOICE%"=="8" set "TASK=selftest"
if "%CHOICE%"=="9" set "TASK=clean"
if "%CHOICE%"=="0" goto :quit
if "%TASK%"=="" goto :badChoice

:run
echo.

rem 更新は、取り込んだあと立ち上げ直すところまでが一続き。
rem 動いているコードと置いてあるコードがズレたまま使わせない。
if not "%TASK%"=="update" goto :normal
if "%RUNNER%"=="direct" call "%NODE%" scripts\run.mjs update
if not "%RUNNER%"=="direct" call "%NPM%" run update
echo.
set "AGAIN="
set /p AGAIN="   立ち上げ直しますか？ [Y/n]: "
if /i "%AGAIN%"=="n" goto :quit
call "%~f0"
exit /b %errorlevel%

:normal
if "%RUNNER%"=="direct" call "%NODE%" scripts\run.mjs %TASK%
if not "%RUNNER%"=="direct" call "%NPM%" run %TASK%
set "CODE=%errorlevel%"

rem --- 終わり方 --------------------------------------------
rem 正常に終わったときも窓を残す。すぐ閉じると、
rem 最後に何が出ていたのかを読む間がない。
echo.
if not "%CODE%"=="0" echo   終了コード %CODE% で終わりました。上の内容が手がかりです。
pause
endlocal
exit /b %CODE%

rem ============================================================
rem  ここから下は、伝えることだけ。
rem  括弧の中に日本語を置かないための置き場所でもある。
rem ============================================================

:noNode
echo.
echo   Node.js が見つかりません。
echo.
echo   直し方は二つあります。
echo     1. https://nodejs.org/ から LTS 版を入れる
echo     2. Node を同梱した版を使う（この PC には何も入りません）
echo.
echo   2 の作り方: Node のある機械で  npm run bundle
echo   出来た dist\AdaptiveAIStudio を、そのまま持ってくれば動きます。
echo.
pause
exit /b 1

:oldNode
echo.
echo   この Node では動きません（%NODEV%）。v22.6 以降が要ります。
echo   型を剥がしながら実行する仕組みを使っているためです。
echo.
echo   直し方は二つあります。
echo     1. https://nodejs.org/ から新しい版を入れる
echo     2. Node を同梱した版を使う（この PC には何も入りません）
echo.
pause
exit /b 1

:badChoice
echo.
echo   その番号はありません。
echo.
pause
exit /b 1

:quit
endlocal
exit /b 0
