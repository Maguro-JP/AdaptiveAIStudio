#!/bin/sh
# 画面だけを開きたいときの入口。中身は start.sh に任せる。
cd "$(dirname "$0")" || exit 1
exec ./start.sh ui
