# AdaptiveAIStudio バグ調査レポート

調査日: 2026-09-18
対象リポジトリ: `Maguro-JP/AdaptiveAIStudio`
対象コミット: `5229a27`（`main`）
調査環境: Ubuntu 24.04 / Node.js v22.13.0 / npm

## 結論

実行時の基本的なスモークテストは成功しました。モデル未配置のLinux環境でもUIが起動し、モデル未配置を正しく案内し、設定・配置・会話初期化・送信時のエラー応答を確認できました。

一方、`npm test` は **2447テスト中2422成功、15失敗、10スキップ**でした。失敗の中心は製品の通常実行ではなく、Node.js 22.13.0で子プロセスとして `.ts` を起動するテストハーネスの引数不足です。ただし、CIや開発者が標準手順でテストを実行すると失敗するため、開発品質上は修正が必要です。

また、テスト以外に、READMEの「`npm install` は要りません」という説明と、`npm run typecheck` が依存未導入では実行できない実装に不整合があります。

## 検査結果

| 検査 | 結果 | 詳細 |
|---|---:|---|
| `npm ci` | 成功 | 7パッケージを導入。脆弱性0件 |
| `npm audit --omit=dev` | 成功 | info/low/moderate/high/critical すべて0 |
| `npm run typecheck` | 成功（`npm ci`後） | TypeScriptエラーなし |
| `npm run smoke` | 成功 | モデル未配置時のUIとエラー案内を確認 |
| `npm run doctor` | 成功 | 環境診断を完走。モデルとnode-llama-cppは未配置として案内 |
| `npm run check` | 失敗 | 内部の全テスト失敗を反映 |
| `npm test` | 失敗 | 2447中2422成功、15失敗、10スキップ |

## 発見事項

### BUG-001: doctorの子プロセス起動にTypeScript実行フラグがなく、Node.js 22.13.0で11テストが失敗する

**重要度:** 中（開発・CIを阻害。通常の`npm run doctor`自体は成功）

**再現条件:**

1. Node.js v22.13.0を使用する。
2. `npm ci`を実行する。
3. リポジトリルートで `npm test`を実行する。

**実際のエラー:**

```text
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
for /tmp/AdaptiveAIStudio/src/cli/doctor.ts
```

**原因:** `test/doctor-inproc.test.ts` の `runDoctor()` が、子プロセスを次の引数で起動しています。

```ts
run(process.execPath, ['--no-warnings', at], ...)
```

Node.js 22.6〜22.17では、`.ts`を実行するために `--experimental-strip-types` が必要です。プロダクション側の `src/ui/tasks.ts` と `scripts/run-tests.mjs` はNodeバージョンに応じてこのフラグを付与していますが、doctorテスト側が同じ処理を行っていません。

**影響:** `test/doctor-inproc.test.ts` 内の、設定・モデル・MCP・GGUF検査を対象とする11サブテストが、機能の検証前に同じ起動エラーで失敗します。`test/installed-env.test.ts` の関連サブテストも連鎖して1件失敗します。

**修正案:** `test/doctor-inproc.test.ts` でも `src/core/node-flags.ts` の`needsStripFlag()`を利用し、次のように起動引数を組み立てる。

```ts
const flags = needsStripFlag(process.versions.node)
  ? ['--experimental-strip-types']
  : [];
const out = await run(process.execPath, [...flags, '--no-warnings', at], ...);
```

### BUG-002: TaskRunnerのテストがNode起動引数の位置を固定しており、正常なフラグ追加で失敗する

**重要度:** 低〜中（テストの誤検知。TaskRunner本体の起動処理は意図どおり）

**再現条件:**

`npm test`を実行すると、`test/tasks.test.ts` の「検査だけは走らせ役を通す」が失敗します。

**実際のエラー:**

```text
The input did not match the regular expression /scripts[\\/]run-tests\\.mjs$/.
Input: '--no-warnings'
```

**原因:** `src/ui/tasks.ts` は現在、次の順で引数を渡します。

```text
[--experimental-strip-types] [--no-warnings] <script>
```

一方、テストは `calls[0].args[1]` がスクリプトパスだと仮定しています。Node.js 22.13.0では`args[1]`が`--no-warnings`になるため失敗します。

**修正案:** 引数の固定位置ではなく、`args` の中から対象パスを検索する。

```ts
assert.ok(calls[0]!.args.some((arg) => /scripts[\\/]run-tests\\.mjs$/.test(arg)));
assert.ok(c2[0]!.args.some((arg) => /src[\\/]cli[\\/]doctor\\.ts$/.test(arg)));
```

### BUG-003: タグ後に4コミット進んでいるのに、package.jsonのバージョンがv0.12.0のまま

**重要度:** 低（配布物の識別性・リリース管理に影響）

**再現条件:**

`npm test`を実行すると、`test/version-bump.test.ts` が次の理由で失敗します。

```text
タグ v0.12.0 から 4 コミット進んでいるのに、package.json が 0.12.0 のままです。
```

**原因:** HEADはタグ`v0.12.0`から4コミット先にありますが、`package.json`のバージョンは`0.12.0`のままです。

**修正案:** 変更内容がバグ修正だけなら`0.12.1`へ、機能追加を含むリリースならプロジェクトの方針に従って`0.13.0`へ更新し、`package-lock.json`のバージョンも同期する。リリース前の作業中コミットで意図的に据え置く場合は、テストをリリースブランチ向けの検査に限定するなど、判定条件を明確にする。

### BUG-004: READMEの「npm installは要りません」とtypecheckの実行条件が矛盾する

**重要度:** 中（初回セットアップ時の開発者体験を阻害）

**再現条件:**

1. 新しいクローン直後に`npm install`や`npm ci`を実行しない。
2. READMEの手順に従って`npm run typecheck`または`npm run check`を実行する。

**実際のエラー:**

```text
Cannot find module '/tmp/AdaptiveAIStudio/node_modules/typescript/bin/tsc'
```

**原因:** `package.json`では`typescript`が`devDependencies`にあり、`typecheck`は`node_modules/typescript/bin/tsc`を直接参照します。一方、README 13〜14行目は「`npm install`は要りません」と説明しています。通常利用の`doctor`や`smoke`は依存なしで動作しますが、型検査・全テストは依存導入が必須です。

**修正案:** READMEを次のいずれかに変更する。

- 通常利用だけを対象にするなら「実行時の依存はゼロ。ただし開発者向けの型検査・テストには`npm ci`が必要」と明記する。
- 開発手順を一つにするなら、冒頭で`npm ci`を実行させる。

## セキュリティ確認

ソースとスクリプトに対して、一般的な秘密情報パターンを検索しました。明白なAPIキー、秘密鍵、パスワードの直書きは検出されませんでした。`npm audit --omit=dev`も脆弱性0件でした。

ただし、MCPやコマンド実行機能は設計上、外部コマンドを起動します。これは直ちにバグと判定するものではありませんが、設定ファイルやユーザー入力からコマンドが組み立てられる経路は、今後も許可リストと引数分離を維持する必要があります。

## 未確認事項

実際のGGUFモデルを用いた推論、Ollama接続、llama.cpp接続、Windows配布物、NVIDIA GPU環境は今回のLinux・モデル未配置環境では検証していません。`npm run doctor`はこれらが未配置であることを正しく報告しましたが、実モデルを用いた応答品質やGPU固有の不具合がないことまでは保証しません。

## 推奨対応順

1. **BUG-001**を修正する。失敗の大部分を占め、CIで本来のdoctor機能を検証できないためです。
2. **BUG-002**を修正する。Nodeバージョンに依存しないテストにします。
3. **BUG-004**を修正する。READMEと初回開発手順を一致させます。
4. **BUG-003**をリリース方針に合わせて処理する。バージョンを上げるか、作業中ブランチでは検査対象外にします。
5. Node.js 22.13.0、22.18以降、Node.js 24、Windowsで同じテストを実行し、環境差を確認します。

## References

[1]: https://github.com/Maguro-JP/AdaptiveAIStudio "AdaptiveAIStudio GitHub repository"
[2]: https://nodejs.org/api/typescript.html "Node.js TypeScript support"
