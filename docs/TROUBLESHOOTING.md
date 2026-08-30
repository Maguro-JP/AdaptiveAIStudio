# 動かないとき

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
          set OLLAMA_MODELS=C:\ai\ollama
```

**直し方（Ollama）**

```
setx OLLAMA_MODELS C:\ai\ollama
```

設定したらコマンドプロンプトを開き直して `ollama serve` から。
既に落としたモデルは `C:\Users\...\.ollama\models` から
`C:\ai\ollama\models` へ移せば、落とし直さずに済みます。

**直し方（LM Studio）**

設定の Models Directory を `C:\ai\lmstudio` のような場所へ変更します。

**直し方（この場所を llama.cpp で使う場合）**

```json
{ "runtime": { "kind": "llamacpp",
               "command": "C:\\ai\\llama\\llama-server.exe",
               "modelsDir": "C:\\ai\\models" } }
```

`C:` 直下など、ASCII だけの場所に置きます。

### 次に疑うのは、ドライバ

```
nvidia-smi
```

これが動かない、あるいは `CUDA Version` の行が出ないなら、
GPU を使う実行ファイルは動きません。ドライバを入れ直してください。

`npm run doctor` は、GPU を見つけているのに `nvidia-smi` が
通らない場合にそう言います。

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

## 何を試しても駄目なとき

`npm run doctor` の出力をそのまま貼ってください。
機械の構成、パス、ドライバ、繋ぎ先の状態が全部入っています。
