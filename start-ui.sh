#!/bin/sh
# ダブルクリックで画面を開くための入口。
cd "$(dirname "$0")" || exit 1
exec npm run ui
