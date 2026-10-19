/**
 * llama-server が落ちたときに、次の一手まで言う。
 *
 * 「終了コード 1」だけを見せられても、人にできることは何も無い。
 * この道具は「足りないものには次の一手が必ず付く」を原則にしているので、
 * ここもそれに合わせる。
 *
 * **当てはめの語句は、本物を落として採った**（test/fixtures/llama/）。
 * 一度は推測で書いて出しかけたが、実際に動かしてみると外れていた。
 * 例えば口の取り合いは `bind: ` ではなく
 * `couldn't bind HTTP server socket` と出る。
 * 推測で書いた見立ては、外れたときに人を誤った方向へ送るぶん、
 * 何も言わないより悪い。
 *
 * 採れていないものが1つだけある（VRAM 不足）。
 * こちらの環境に GPU が無いため再現できていない。印を付けてある。
 */
import { how } from '../cli/how.ts';

export interface Diagnosis {
  cause?: string;
  nextStep?: string;
  /** その見立てが実測に基づくか。推測のものは、そう言う。 */
  verified: boolean;
}

interface Pattern {
  match: RegExp;
  cause: string;
  nextStep: string;
  verified: boolean;
}

/**
 * よくある落ち方。上から順に見て、最初に当たったものを採る。
 *
 * 順番に意味がある。llama.cpp は原因が何であれ、最後は
 * 「failed to load model」で終わる。**決め手は途中の行にある**ので、
 * 細かいものから先に見る。
 */
const PATTERNS: Pattern[] = [
  {
    // 実測: error while loading shared libraries: libllama.so: cannot open shared object file
    match: /error while loading shared libraries|cannot open shared object file/i,
    cause: '共有ライブラリを見つけられていません。',
    nextStep: '`' + how('llama') + '` で入れ直してください。'
      + '実行ファイルだけを別の場所へ移すと、隣にあるライブラリを見失います。',
    verified: true,
  },
  {
    // 実測: gguf_init_from_file_impl: invalid magic characters: 'こ?', expected 'GGUF'
    match: /invalid magic characters|expected 'GGUF'/i,
    cause: 'そのファイルは GGUF ではありません。',
    nextStep: '途中で切れているか、別の形式です。取り直してください'
      + '（`' + how('models', '--get') + '` なら、取ってきたものを GGUF として確かめてから置きます）。',
    verified: true,
  },
  {
    // 実測: gguf_init_from_file: failed to open GGUF file '/nonexistent/model.gguf'
    match: /failed to open GGUF file/i,
    cause: 'モデルのファイルを開けません。',
    nextStep: 'その場所にファイルがあるか確認してください。'
      + '`' + how('models') + '` で、いま見えている一覧を出せます。',
    verified: true,
  },
  {
    // 実測: main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 18097
    match: /couldn't bind HTTP server socket|address already in use/i,
    cause: 'その口（ポート）は、別のものが使っています。',
    nextStep: '先に起動している llama-server を止めるか、設定の runtime.basePort を変えてください。',
    verified: true,
  },
  {
    // 実測: error: invalid argument: --this-flag-does-not-exist
    match: /invalid argument:|unknown argument|unrecognized/i,
    cause: 'llama-server が、渡した指定を理解できていません。',
    nextStep: 'llama.cpp の版が古い可能性があります。`' + how('llama', '--force') + '` で入れ直すか、'
      + '設定の runtime.commandArgs を見直してください。',
    verified: true,
  },
  {
    // 未実測。こちらの環境に GPU が無く、再現できていない。
    match: /out of memory|cudaMalloc failed|ggml_backend_cuda_buffer_type_alloc/i,
    cause: 'GPU のメモリが足りません。',
    nextStep: '層の載せ方を減らすか、もっと小さい量子化のモデルにしてください。'
      + '`' + how('models') + '` で、この機械に載る組み合わせを計算できます。',
    verified: false,
  },
  {
    match: /unknown model architecture|unsupported model/i,
    cause: 'この llama.cpp が、そのモデルの形式に対応していません。',
    nextStep: '`' + how('llama', '--force') + '` で新しくしてください。'
      + '新しい形式のモデルは、古い llama.cpp では読めません。',
    verified: false,
  },
  {
    // 最後の砦。原因は分からないが、モデルの読み込みで転んだことは分かる。
    match: /failed to load model|exiting due to model loading error/i,
    cause: 'モデルを読み込めませんでした。',
    nextStep: '上の出力に、より詳しい行が出ているはずです。'
      + 'ファイルの場所と中身（`' + how('models', '--inspect <ファイル>') + '`）を確かめてください。',
    verified: true,
  },
];

/**
 * 終了コードから、黙って落ちた理由を言う。
 *
 * 落ち方には、**何も言わずに終わる**ものがある。Windows で必要な DLL が
 * 無いときがそれで、標準エラーには一文字も出ない。出力を見る当てはめは
 * どれも当たらず、「上の出力が手がかりです」と言っても手がかりが無い。
 *
 * 番号だけが残る。だから番号も読む。
 */
export function explainExitCode(code: number | null): string {
  if (code === 3221225781) {  // 0xC0000135 STATUS_DLL_NOT_FOUND
    return '必要な DLL が隣にありません。CUDA 版なら実行時ライブラリ（cudart）が要ります。'
      + '\n  ' + how('llama') + ' で入れ直すと、実行時ライブラリも一緒に取ってきます。';
  }
  if (code === 3221225785) {  // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
    return 'DLL はありますが、版が合っていません。'
      + '\n  別の場所にある古い DLL を先に見ている可能性があります。';
  }
  return '';
}

export function diagnose(output: string): Diagnosis {
  for (const p of PATTERNS) {
    if (p.match.test(output)) {
      return { cause: p.cause, nextStep: p.nextStep, verified: p.verified };
    }
  }
  return { verified: false };
}

export function describeFailure(code: number | null, output: string): string {
  const { cause, nextStep, verified } = diagnose(output);
  const head = `llama-server が起動に失敗しました (終了コード ${code ?? '不明'})`;
  const tail = output.trim();

  // 出力に見覚えが無くても、番号で分かることがある。
  const byCode = explainExitCode(code);

  if (!cause) {
    return [
      head, tail, '',
      ...(byCode
        ? [`→ ${byCode}`]
        : [tail
          // 「上の出力が手がかりです」と言っても、出力が無いなら手がかりも無い。
          ? '見覚えのある落ち方ではありませんでした。上の出力が手がかりです。'
          : '何も出力せずに終わりました。見分けが付きません。']),
    ].filter((s) => s !== '').join('\n');
  }

  return [
    head, tail, '',
    `→ ${cause}`,
    `  ${nextStep}`,
    // 推測で書いた見立ては、推測だと言う。断定して人を誤らせない。
    ...(verified ? [] : ['  （この見分けは実物で確認できていません。違っていたら出力を知らせてください）']),
  ].filter((s) => s !== '').join('\n');
}
