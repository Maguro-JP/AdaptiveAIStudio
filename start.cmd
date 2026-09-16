@echo off
rem ============================================================
rem  AdaptiveAIStudio 起動用
rem
rem  ダブルクリックで開く入口。npm を覚えていなくても始められる。
rem  引数を付ければ、選ぶところは飛ばせる:  start.cmd ui
rem
rem  **この窓は入口であって、道具ではない。**
rem  点検・モデル・片づけ・設定は画面の中にある。ここに並べると、
rem  立ち上げたあとに窓が塞がって、見たいものが見られなくなる。
rem  端末から直に呼びたいときのために、引数の道だけ残してある。
rem
rem  ■ このファイルは CP932 で保存する。UTF-8 にしない
rem
rem  cmd.exe はバッチを console の文字集合（日本語 Windows なら CP932）
rem  として読む。UTF-8 で置くと日本語が化けるだけでなく行が壊れる。
rem  BOM を付けても直らず、1 行目の @echo off まで効かなくなる。
rem  chcp 65001 も要らない（ファイルも console も CP932 で揃うため）。
rem
rem  ■ 日本語を ( ) の中に書かない
rem
rem  cmd.exe は括弧の塊をまとめて解釈する。そこに多バイト文字が入ると
rem  行が壊れ、壊れた断片をコマンドとして実行する。
rem  だから分岐は goto で書き、日本語はラベルの中だけに置く。
rem
rem  この窓は、失敗しても勝手に閉じない。
rem ============================================================
setlocal
cd /d "%~dp0"
title AdaptiveAIStudio

rem --- Node を探す -----------------------------------------
rem `..` を含んだまま探さない。割り当てドライブ（Z: など）や
rem OneDrive の下だと、そのままでは見つけられないことがある。
set "HERE=%~dp0"
for %%i in ("%~dp0..") do set "UP=%%~fi"

set "BUNDLED="
set "NODEFILE=node.exe"

rem 製品の形（app\ の隣の runtime\）を先に見る。
if not exist "%UP%\runtime\node.exe" goto :tryBin
set "BUNDLED=%UP%\runtime"
goto :bundled

:tryBin
rem 会社のクラウドドライブは、中身ではなく **名前を見て** .exe を落とす。
rem .bin なら置ける（Z: で実測。92,534,088 バイトそのまま書けた）。
rem cmd.exe は PATHEXT に載っている拡張子をそのまま実行するので、
rem 名前が違うだけで、呼び方は何も変わらない。
if not exist "%UP%\runtime\node.bin" goto :tryHere
set "BUNDLED=%UP%\runtime"
set "NODEFILE=node.bin"
goto :bundled

:tryHere
if exist "%HERE%runtime\node.exe" set "BUNDLED=%HERE%runtime"
if exist "%HERE%node\node.exe" set "BUNDLED=%HERE%node"
if defined BUNDLED goto :bundled

rem 同梱版の目印はあるのに Node が無い、という形をここで覚えておく。
rem クラウドドライブが .exe を落としたときに起きる。
rem
rem ただし、ここで止めない。**入っている Node を一度も探さずに諦めていた。**
rem 実際に、Node を同梱していない版を渡したら、Node が入っている機械で
rem 「.exe が落とされたのでは」と言って止まった。案内が的外れなうえ、
rem 使える Node が在るのに使わない。探してから決める。
set "STRIPPED="
if exist "%UP%\.portable" set "STRIPPED=1"

where node >nul 2>nul
if errorlevel 1 goto :noBundledNode
set "NODE=node"
rem npm は full path で呼ぶ。裸の名前を call に渡すと、npm.cmd の中の %~dp0 が
rem いま居る場所になり、npm が自分の中身をこの下で探して落ちる。
rem Windows で実測: Cannot find module ...\node_modules\npm\bin\npm-prefix.js
rem 見つからなければ npm を使わない。package.json を直接読む道がある。
set "NPM="
for /f "delims=" %%p in ('where npm.cmd 2^>nul') do if not defined NPM set "NPM=%%p"
set "RUNNER=npm"
if not defined NPM set "RUNNER=direct"
if defined STRIPPED echo   同梱の Node はありませんが、この機械の Node を使います
goto :haveNode

:noBundledNode
rem 入っている Node も無い。ここで初めて、何が起きたのかを言う。
if defined STRIPPED goto :exeStripped
goto :noNode

:bundled
set "NODE=%BUNDLED%\%NODEFILE%"
set "PATH=%BUNDLED%;%PATH%"
if "%NODEFILE%"=="node.exe" goto :extDone
rem .bin をそのまま呼ぶための一手。子の cmd にも効かせたいので環境変数で渡す。
set "PATHEXT=%PATHEXT%;.BIN"
set "NODE=node"
:extDone
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
set "NODEV="
for /f "tokens=*" %%v in ('"%NODE%" -v 2^>nul') do set "NODEV=%%v"
rem 版が取れないのは、動かせていないということ。ここで止めないと
rem 「この Node では動きません（）」という、何も分からない表示になる。
if not defined NODEV goto :nodeSilent
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
rem 引数で来たときは一度だけ動かして終わる（他から呼ばれる形）。
rem 自分で選んだときは、終わってもここへ戻る。**一回で閉じない。**
set "TASK=%~1"
set "ONCE="
set "ARGS="
if "%TASK%"=="" goto :menu
set "ONCE=1"
shift
goto :collect

rem 2つ目からの引数を集める。集めないと落ちる（clean --yes が効かなかった）。
:collect
if "%~1"=="" goto :run
set "ARGS=%ARGS% %~1"
shift
goto :collect

:menu
set "TASK="
echo.
echo   AdaptiveAIStudio
echo   ----------------------------------------
echo    1  画面をひらく          （ふだんはこれだけ）
echo    2  新しくする
echo    3  困ったとき（この環境を見てもらう）
echo    4  動くか確かめる
echo    5  本当に答えるか確かめる
echo    0  やめる
echo.
echo   点検・モデル・片づけ・設定は、画面の中にあります。
echo   端末から直に呼ぶときは:  start.cmd doctor   のように渡してください。
echo.
set "CHOICE="
set /p CHOICE="   番号を入れて Enter: "

if "%CHOICE%"=="1" set "TASK=ui"
if "%CHOICE%"=="2" set "TASK=update"
if "%CHOICE%"=="3" set "TASK=doctor"
if "%CHOICE%"=="4" set "TASK=smoke"
if "%CHOICE%"=="5" set "TASK=selftest"
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
rem 画面の「立ち上げ直す」は 75 で終わる。そのときは同じものをもう一度起こす。
rem 回線の中継（HTTPS_PROXY 等）が環境にあれば、Node の fetch にも通す。
rem 無ければ何も変わらない。効くかどうかは実機で未確認。
set "NODE_USE_ENV_PROXY=1"
set "AAS_RELAUNCH=1"
if "%RUNNER%"=="direct" call "%NODE%" scripts\run.mjs %TASK%%ARGS%
if "%RUNNER%"=="direct" goto :ran
if defined ARGS call "%NPM%" run %TASK% --%ARGS%
if not defined ARGS call "%NPM%" run %TASK%

:ran
set "CODE=%errorlevel%"
if "%CODE%"=="75" goto :run

rem --- 終わり方 --------------------------------------------
rem 正常に終わったときも、何が出ていたか読む間を置く。
echo.
if not "%CODE%"=="0" echo   終了コード %CODE% で終わりました。上の内容が手がかりです。
if defined ONCE goto :bye
echo   ----------------------------------------
pause
goto :menu

:bye
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
echo   この PC に入れられないときは、置くだけで動かせます。
echo   ブラウザで次を落として、node.exe をここへ置いてください。
echo.
echo     https://nodejs.org/dist/v24.18.0/win-x64/node.exe
echo.
echo     置き場所:  %HERE%node\node.exe
echo.
echo   フォルダ node を作って、その中に入れるだけです。
echo   インストールではないので、管理者権限も要りません。
echo   要らなくなったら、このフォルダごと消せば跡形もなくなります。
echo.
echo   ふつうに入れられるなら、https://nodejs.org/ の LTS 版でも構いません。
echo.
echo   ---- 探した場所 ----
echo     %UP%\runtime\node.exe
echo     %UP%\runtime\node.bin
echo     %HERE%runtime\node.exe
echo     %HERE%node\node.exe
echo.
pause
exit /b 1

:oldNode
echo.
echo   この Node では動きません（%NODEV%）。v22.6 以降が要ります。
echo   型を剥がしながら実行する仕組みを使っているためです。
echo.
echo   入れ直せないときは、置くだけで差し替えられます。
echo   ブラウザで次を落として、node.exe をここへ置いてください。
echo     https://nodejs.org/dist/v24.18.0/win-x64/node.exe
echo     置き場所:  %HERE%node\node.exe
echo   こちらが先に使われます。入っている Node はそのままで構いません。
echo.
pause
exit /b 1

:exeStripped
echo.
echo   同梱の Node がありません（他のファイルは揃っています）。
echo.
echo   いまの置き場所:
echo     %UP%
echo.
echo   会社のクラウドドライブ（OneDrive・PassageDrive など）へ展開すると、
echo   .exe だけが黙って落ちることがあります。書き込みが拒まれても、
echo   展開する側は何も言わずに進みます。
echo.
echo   この機械には Node も入っていません。どちらかで動きます。
echo.
echo     1. Node 22.6 以降を入れる       https://nodejs.org
echo     2. .exe を置ける場所へ展開し直す
echo.
echo   会社のクラウドドライブなら、.exe を含まない版も使えます。
echo   Node の名前が node.bin になっているだけで、中身は同じです。
echo.
pause
exit /b 1

:nodeSilent
rem どの Node を動かせなかったのかで、言うことが違う。同梱のものと
rem 決めつけて「大きさを見てください」と言っていたが、PATH の node が
rem 動かないときにも同じ文が出た。しかもパスは空の `\node.exe` に
rem なる。案内が的外れなうえ、何を見ればいいかも分からない。
if defined BUNDLED goto :bundledSilent
echo.
echo   この機械の Node を動かせませんでした。
echo.
echo   where node では見つかりましたが、-v が返りません。
echo   版を選んでいない nvm など、名前だけが残っている形で起きます。
echo.
echo   端末で node -v を試してください。同じように返らないはずです。
echo   直せないときは、置くだけで差し替えられます。
echo     https://nodejs.org/dist/v24.18.0/win-x64/node.exe
echo     ここへ:  %HERE%node\node.exe
echo   こちらが先に使われます。
echo.
pause
exit /b 1

:bundledSilent
echo.
echo   同梱の Node を動かせませんでした。
echo     %BUNDLED%\%NODEFILE%
echo.
echo   会社の設定で実行が止められているか、ファイルが壊れています。
echo   大きさを見てください（90MB 前後が正しい）。
echo.
pause
exit /b 1

:badChoice
echo.
echo   その番号はありません。
echo.
pause
goto :menu

:quit
endlocal
exit /b 0
