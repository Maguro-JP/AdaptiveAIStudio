# 動かないとき

## まず

困ったら、まずこれを実行して、出た内容をそのまま貼ってください。

```
npm run selftest
```

この機械で実際に動くかを一通り確かめて、貼れる形で出します。
直しはしません（見るだけです）。起動用の 8 番でも同じことができます。

## まず

```
npm run doctor
```

足りないものと、次に打つ一手が出ます。
それでも動かないときは、以下を上から見てください。

---

## LM Studio でも Ollama でもモデルが動かない

**こちらの作りの問題ではありません。** その二つとこの場所は、
どれも中身は llama.cpp です。共通の土台が詰まっています。

### 疑うのは、まずパスの文字

```
C:\Users\ｍ＠ｇｕｒｏ\.ollama
           ^^^^^^^^ 全角
```

llama.cpp 系は、モデルを開くときにワイド文字のAPIを通らない箇所があり、
**全角や日本語を含むパスだとファイルを開けずに落ちる**ことがあります。

分かりにくいのは、アプリ自体は起動することです。
一覧も出るし設定もできる。**モデルを読む瞬間だけ**失敗します。

`npm run doctor` がこれを見つけたら、そう言います。

```
未了  既定の Ollama 置き場に全角・日本語が入っています
      C:\Users\ｍ＠ｇｕｒｏ\.ollama  ← ｍ＠ｇｕｒｏ
      → ASCII だけの場所に移してください。例:
          set OLLAMA_MODELS=%ProgramData%\Ollama
```

**直し方（Ollama）**

```
setx OLLAMA_MODELS %ProgramData%\Ollama
```

設定したらコマンドプロンプトを開き直して `ollama serve` から。
既に落としたモデルは `C:\Users\...\.ollama\models` から
`%ProgramData%\Ollama\models` へ移せば、落とし直さずに済みます。

**直し方（LM Studio）**

設定の Models Directory を `%ProgramData%\LMStudio` のような場所へ変更します。

**直し方（この場所を llama.cpp で使う場合）**

```json
{ "runtime": { "kind": "llamacpp",
               "command": "C:\\ProgramData\\AdaptiveAIStudio\\bin\\llama-server.exe",
               "modelsDir": "C:\\ProgramData\\AdaptiveAIStudio\\models" } }
```

`%ProgramData%`（実体は `C:\ProgramData`）は必ず半角英数字で、
管理者権限が無くても書けます。**`C:` 直下にフォルダを作らないでください。**

**直し方（この道具が自分で取ってくるモデル）**

`npm run models -- --get` で取ってきたものは、既定で `~/.aas/models` に入ります。
**利用者名が全角なら、この置き場も全角になります。**設定を書かずに逃がすなら:

```
setx AAS_MODELS_DIR %ProgramData%\AdaptiveAIStudio\models
```

ただし、**この道具は設定していなくても自分で逃がします。**根が全角を含むときは、
モデルだけ `%ProgramData%\AdaptiveAIStudio\models` に置きます
（`src/core/home.ts` の `asciiModelsDir`）。上の設定は、置き場所を
自分で決めたいときだけで構いません。

**モデルを取ってくる前に**設定してください。数GB 落としてから開けないと
分かるのが、いちばん無駄なので。`npm run doctor` は、設定していなくても
既定の置き場を見て、全角が入っていれば言います。

### 次に疑うのは、ドライバ

```
nvidia-smi
```

これが動かない、あるいは `CUDA Version` の行が出ないなら、
GPU を使う実行ファイルは動きません。ドライバを入れ直してください。

`npm run doctor` は、GPU を見つけているのに `nvidia-smi` が
通らない場合にそう言います。

### 何も言わずに終わるとき（Windows）

いちばん分かりにくい落ち方です。`llama-server` を起動したのに、
**標準エラーに一文字も出ないまま**終わります。

Windows は必要な DLL を見つけられないと、何も言わずに特定の番号で落ちます。
出力を見る見分けはどれも当たらないので、この道具は**終了コードも読みます**。

```
llama-server が起動に失敗しました (終了コード 3221225781)

→ 必要な DLL が隣にありません。CUDA 版なら実行時ライブラリ（cudart）が要ります。
  npm run llama で入れ直すと、実行時ライブラリも一緒に取ってきます。
```

| 番号 | 意味 |
|---|---|
| 3221225781 (`0xC0000135`) | DLL が見つからない |
| 3221225785 (`0xC0000139`) | DLL はあるが版が合っていない |

CUDA 版の llama-server は**単体では起動しません**。`npm run llama` は
本体と一緒に cudart（CUDA の実行時ライブラリ）も取ってきます。
実行ファイルだけをどこかへ移すと、この落ち方をします。

### 何も入れられない機械で使う

Node を**インストールする**必要はありません。`node.exe` は
単体で動く実行ファイルで、置くだけで使えます。

```
npm run bundle
```

**いま動かしている Node ごと**、配れる形に固めます。
取ってきません（網が要りません）。CI も使いません。
出来たフォルダ（`dist\AdaptiveAIStudio`）を、そのまま持って行けば動きます。

```
AdaptiveAIStudio\
  AdaptiveAIStudio.cmd   これを押す
  app\  runtime\  data\
```

向こうの機械で検査も回せます（`app\scripts\run-tests.mjs`）。
CI の枠を使い切っても、この道は塞がりません。

**ただし固めた Node は、固めた機械向けです。**Windows で固めたものを
Windows へ持って行く分には問題ありませんが、Linux で固めたものは
Windows では動きません。

それでも駄目な場合は、次のどちらかです。

- **実行ファイルの実行そのものが禁止されている**（AppLocker 等）
  → この道具に限らず何も動きません。管理者に相談する以外にありません
- **外への接続が塞がれている**
  → 繋がる機械で `npm run bundle` して、フォルダごと持ち込んでください

### それでも動かないなら

**エラーの文字をそのまま見る**のがいちばん速いです。

LM Studio なら、モデル読み込みに失敗したときのログ（Developer タブ）。
Ollama なら、`ollama serve` を動かしている窓に出ている文字。

よくある形と、その意味:

| 出ている文字 | 意味 |
|---|---|
| `failed to load model` / `unable to load model` | パスかファイルの問題。上の「パスの文字」を先に疑う |
| `CUDA error` / `no CUDA-capable device` | ドライバか CUDA 側 |
| `not enough memory` / `failed to allocate` | VRAM 不足。もっと小さいモデルか量子化を下げる |
| `illegal instruction` | CPU が AVX2 に対応していない。CPU 実行版が必要 |
| 何も出ずに落ちる | ウイルス対策ソフトが実行ファイルを止めていることがある |

---

## モデルは動くが、遅すぎる

遅いこと自体は異常ではありません。
この場所は「遅くてもいいから動く」を狙って作られています。

ただし、**GPU に載っていないのに載っているつもり**でいると、
不必要に遅くなります。

```
npm run models
```

計画（何層を GPU に載せるか）と、見積もりの速度が出ます。
`劣化:` の行に、何を諦めたかが書いてあります。

---

## 画面は開くが、指示を出しても何も返らない

```
npm run doctor
```

`接続` の行を見てください。`ollama serve` が動いていないと、
画面は開いても中身が動きません。

---

## llama-server が起動しない

`runtime.kind` を `llamacpp` にしているとき、llama.cpp が立ち上がらない場合。
終了コードだけでは何も分からないので、**落ち方に見覚えがあれば次の一手まで出します**。

```
llama-server が起動に失敗しました (終了コード 1)
gguf_init_from_file_impl: invalid magic characters: '...', expected 'GGUF'
llama_model_load: error loading model: ...
main: exiting due to model loading error

→ そのファイルは GGUF ではありません。
  途中で切れているか、別の形式です。取り直してください。
```

見分けているのは、共有ライブラリを見失った・GGUF でない・ファイルが無い・
口（ポート）の取り合い・知らない指定・VRAM 不足・対応していない形式、の7通りです。

このうち**5つは本物を実際に落として文字列を採ってあります**
（`test/fixtures/llama/`）。VRAM 不足と対応形式の2つは再現できていないので、
その見立てを出すときは「実物で確認できていません」と断ります。
断定して誤った方向へ送るくらいなら、そう言う方がよいので。

見覚えが無ければ「見覚えのある落ち方ではありませんでした」と言って、
生の出力を出します。その出力を貼ってもらえれば、見分けを足します。

## Windows で `npm test` が落ちる

Linux では全部通るのに Windows で落ちる場合、まず次の2つを疑う。
どちらも直してあるので、**最新にしてから**もう一度試す。

1. **試験の並べ方を殻に任せていた** — `node --test test/*.test.ts` の `*` を
   cmd.exe は展開しない。いまは `scripts/run-tests.mjs` がファイルを自分で並べる。
2. **仮の GGUF を本当に 4GB 書いていた** — 試験3件が 4GB の 0 を書き出しており、
   並列で走る試験どうしがメモリとディスクを食い合っていた。
   いまは末尾の位置だけを動かす（中身を作らない）。全体で 89秒 → 9秒。

それでも落ちるなら、落ちたものだけを名前で絞って走らせ、その出力を見る。

```
npm test gguf
npm test ui-server
```

置き土産（`%TEMP%\aas-*`）は試験の終わりに片づくようになっているが、
途中で打ち切ると残る。溜まっていたら消してよい。

## 何を試しても駄目なとき

`npm run doctor` の出力をそのまま貼ってください。
機械の構成、パス、ドライバ、繋ぎ先の状態が全部入っています。
