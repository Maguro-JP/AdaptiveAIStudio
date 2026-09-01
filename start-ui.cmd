@echo off
rem 画面だけを開きたいときの入口。中身は start.cmd に任せる。
cd /d "%~dp0"
call start.cmd ui
