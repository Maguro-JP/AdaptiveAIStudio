#!/usr/bin/env bash
# Windows 向けの portable を、GitHub Actions を使わずに組む。
#
#   bash scripts/local-windows-portable.sh <作業場> [版]
#
# 作業場（リポジトリの外。中身は消して作り直す）に origin/main を取り出し、
# モデルを読むライブラリの Windows 版と、Windows 用の Node を取ってきて組む。
# リポジトリの node_modules とロックファイルには触れない。
# 最後に 26MB ごとに分けたファイルを作る（送れる大きさの上限が 30MB のため）。
# Windows では copy /b a.part0+a.part1 a.zip で 1 つに戻す。
#
# setup.exe は作らない（NSIS が要る）。CUDA・Vulkan の分は入れない（大きいため）。
set -euo pipefail

work="${1:?作業場のパスを渡してください}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
nodever="$(sed -n 's/^  NODEVER: \(v[0-9.]*\)$/\1/p' "$repo/.github/workflows/release.yml")"
sha="$(git -C "$repo" rev-parse --short origin/main)"
version="${2:-$(node -p "require('$repo/package.json').version")-$sha-local}"

case "$work" in
  "$repo"|"$repo"/*) echo "作業場はリポジトリの外にしてください: $work" >&2; exit 1 ;;
esac
rm -rf "$work" && mkdir -p "$work/src"
git -C "$repo" archive origin/main | tar -x -C "$work/src"

cd "$work/src"
npm ci --no-audit --no-fund
npm install --no-save --no-audit --no-fund --omit=optional --force --ignore-scripts \
  node-llama-cpp @node-llama-cpp/win-x64 @modelcontextprotocol/server-github
# llama.cpp の元のコードは要らない（release.yml と同じ片づけ）。
find node_modules/node-llama-cpp/llama -type f ! -name '*.json' -delete
find node_modules/node-llama-cpp/llama -type d -empty -delete

curl -fsSL --retry 3 -o "$work/node.exe" "https://nodejs.org/dist/$nodever/win-x64/node.exe"
node scripts/bundle.mjs --out "$work/dist/AdaptiveAIStudio" --node-exe "$work/node.exe" --version "$version"

d="$work/dist/AdaptiveAIStudio"
test "$(head -c2 "$d/runtime/node.exe")" = MZ
for f in AdaptiveAIStudio.cmd app/start.cmd VERSION \
  app/node_modules/node-llama-cpp/dist/index.js \
  app/node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node \
  app/node_modules/@modelcontextprotocol/server-github/dist/index.js; do
  test -f "$d/$f" || { echo "入っていません: $f" >&2; exit 1; }
done

zip_name="AdaptiveAIStudio-portable-$version.zip"
(cd "$work/dist" && zip -qr "$work/$zip_name" AdaptiveAIStudio)
(cd "$work" && split -b 26m -d -a 1 "$zip_name" "$zip_name.part")
cat "$work/$zip_name".part* | cmp - "$work/$zip_name"
echo "版: $version"
ls -l "$work/$zip_name" "$work/$zip_name".part*
