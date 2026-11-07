# 中の 4B が知らない Node の API を選ぶ試し（2026-11-08）

成果物 5 の 3 つ目の頼みに使う API を選ぶため、手元（Linux、Node 22.22.0、CPU のみ）で Qwen3.5-4B-Q4_K_M を
node-llama-cpp で直接動かし、文書なしと、`NodeDocsSource` が nodejs.org から取った文書を頭に付けたもので、各 2 回ずつ書かせた。
書いたコードを node で動かし、API を呼んでいて出力が合うかで判定した。温度 0.7、種は 0 と 1、考える分の上限は 0。

前の頼み（`util.diff`）は、Windows の CI の `--without-network` で 4B が正しく書いた（知っていた）。

| API | 文書なし | 文書あり | 文書なしで落ちた形 |
|---|---|---|---|
| `zlib.zstdCompressSync` | 0 / 2 | 2 / 2 | 戻した Buffer を文字にしていない（API は知っている） |
| `path.matchesGlob` | 0 / 2 | 2 / 2 | 1 回目は無い包み `glob` を読み込む。2 回目は引数を逆にして `false true` |
| `util.getCallSites` | 1 / 2 | 2 / 2 | 関数を引数に渡して型の誤り |
| `assert.partialDeepStrictEqual` | 試していない | 試していない | 途中で止めた |

選んだのは `path.matchesGlob`。文書なしの落ち方が API を知らないことによる（包みを取り違える、引数の順を知らない）。
`zstd` は API を知っていて、落ちたのは出力の書き方だけなので外した。

確かめていないこと: アプリの中（役職・道具を使う流れ、挙げる段の問いの作り方）で同じ結果になるか。Windows の CI の check-user では
まだ動かしていない。2 回ずつの試しで、数は少ない。配る Node は 22.22.2 で、`path.matchesGlob` は 22.5 から入っている（実験的）。
