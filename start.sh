#!/bin/sh
# ============================================================
#  AdaptiveAIStudio 起動用
#
#  ダブルクリック、あるいは ./start.sh で始める入口。
#  引数を付ければ、選ぶところは飛ばせる:  ./start.sh ui
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js が見つかりません。"
  echo "  https://nodejs.org/ から LTS 版を入れて、やり直してください。"
  echo
  exit 1
fi

echo "  Node $(node -v)"

# 依存は入れない。実行時の依存はゼロで、npm install は要らない。
# （型検査 npm run typecheck を使うときだけ、手動で入れる）

task="${1:-}"

if [ -z "$task" ]; then
  echo
  echo "  AdaptiveAIStudio"
  echo "  ----------------------------------------"
  echo "   1  画面をひらく          （ふだんはこれ）"
  echo "   2  端末で作業させる"
  echo "   3  ただの相談"
  echo "   4  この環境を見てもらう"
  echo "   5  手元のモデルを見る"
  echo "   6  検査を回す"
  echo "   0  やめる"
  echo
  printf "   番号を入れて Enter: "
  read -r choice
  case "$choice" in
    1) task=ui ;;
    2) task=agent ;;
    3) task=chat ;;
    4) task=doctor ;;
    5) task=models ;;
    6) task=test ;;
    0) exit 0 ;;
    *) echo "  その番号はありません。"; exit 1 ;;
  esac
fi

echo
npm run "$task"
