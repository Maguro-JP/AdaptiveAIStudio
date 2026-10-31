#!/bin/sh
# ============================================================
#  AdaptiveAIStudio 起動用
#
#  ダブルクリック、あるいは ./start.sh で始める入口。
#  引数を付ければ、選ぶところは飛ばせる:  ./start.sh ui
# ============================================================
set -u
# 自分の居場所を絶対の道で持つ（`sh start.sh` では $0 に / が無く、立ち上げ直しの exec が PATH を探して落ちた）
here=$(cd "$(dirname "$0")" && pwd) || exit 1
cd "$here" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js が見つかりません。"
  echo "  https://nodejs.org/ から LTS 版を入れて、やり直してください。"
  echo
  exit 1
fi

nodev=$(node -v 2>/dev/null)
echo "  Node $nodev"

# 型を除きながら実行する仕組みを使うので、v22.6 以降が要る（古いと、意味の取れないエラーで落ちるだけになる）
major=$(echo "$nodev" | sed -n 's/^v\([0-9]*\)\..*/\1/p')
minor=$(echo "$nodev" | sed -n 's/^v[0-9]*\.\([0-9]*\).*/\1/p')
if [ -z "$major" ] || [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "${minor:-0}" -lt 6 ]; }; then
  echo
  echo "  この Node では動きません（${nodev:-版が分かりません}）。v22.6 以降が要ります。"
  echo "  https://nodejs.org/ から LTS 版を入れて、やり直してください。"
  echo
  exit 1
fi

# 依存は入れない。実行時の依存はゼロで、npm install は要らない。
# （型検査 npm run typecheck を使うときだけ、手動で入れる）

task="${1:-}"
# 2 つ目からの引数は、そのまま渡す（落としていたので `clean --yes` が見せるだけで終わった）
[ $# -gt 0 ] && shift

if [ -z "$task" ]; then
  echo
  echo "  AdaptiveAIStudio"
  echo "  ----------------------------------------"
  echo "   1  画面をひらく          （ふだんはこれ）"
  echo "   4  この環境を見てもらう"
  echo "   5  手元のモデルを見る"
  echo "   6  検査を回す"
  echo "   7  新しくする"
  echo "   8  この機械で確かめる"
  echo "   9  動くか確かめる"
  echo "   0  やめる"
  echo
  printf "   番号を入れて Enter: "
  read -r choice
  case "$choice" in
    1) task=ui ;;
    4) task=doctor ;;
    5) task=models ;;
    6) task=test ;;
    7) task=update ;;
    8) task=selftest ;;
    9) task=smoke ;;
    0) exit 0 ;;
    *) echo "  その番号はありません。"; exit 1 ;;
  esac
fi

echo

# 更新は、取り込んだあと立ち上げ直すところまでが一続き。
# 動いているコードと置いてあるコードがズレたまま使わせない。
if [ "$task" = "update" ]; then
  # 10 は「取り込まなかった（最新・やめた）」。立ち上げ直す理由が無いので、訊かずに終える
  npm run update
  code=$?
  [ "$code" -eq 10 ] && exit 0
  [ "$code" -ne 0 ] && exit "$code"
  echo
  printf "   立ち上げ直しますか？ [Y/n]: "
  read -r again
  case "$again" in
    [nN]*) exit 0 ;;
    *) exec sh "$here/start.sh" ;;
  esac
fi

# 画面の「立ち上げ直す」は 75 で終わる。そのときは同じものをもう一度起こす（start.cmd と同じ）
export AAS_RELAUNCH=1
while :; do
  if [ $# -gt 0 ]; then
    npm run "$task" -- "$@"
  else
    npm run "$task"
  fi
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
done
