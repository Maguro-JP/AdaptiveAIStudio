@echo off
rem ============================================================
rem  AdaptiveAIStudio の入口。これを押せば始まります。
rem
rem  ■ ZIP の中から押されたときを受け止める
rem
rem  Windows は ZIP をフォルダとして開けてしまう。そこで .cmd を押すと、
rem  Windows はその1ファイルだけを temp へ出して走らせるので、隣にある
rem  はずの app\ も runtime\ も無い。受け止めが無いと
rem  「指定されたパスが見つかりません」が一瞬映って窓が閉じ、
rem  何が起きたか誰にも分からない。
rem
rem  ■ このファイルは CP932 で保存する。UTF-8 にしない
rem  ■ 日本語を ( ) の中に書かない。分岐は goto で書く
rem ============================================================
if exist "%~dp0app\start.cmd" goto :run
echo.
echo   AdaptiveAIStudio を始められませんでした。
echo.
echo   ZIP を開いた中から押していませんか。
echo   ZIP は右クリックから「すべて展開」で取り出してから、
echo   出てきたフォルダの中の AdaptiveAIStudio.cmd を押してください。
echo.
echo   置き場所は、デスクトップなど自分で書き込める場所にしてください。
echo   Program Files の下は書き込みが止められていることがあります。
echo.
pause
exit /b 1
:run
call "%~dp0app\start.cmd" %*
