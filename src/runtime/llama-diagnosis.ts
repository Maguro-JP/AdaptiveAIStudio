/**
 * llama-server が落ちたときに、次の一手まで言う。
 *
 * 「終了コード 1」だけを見せられても、人にできることは何も無い。
 * この道具は「足りないものには次の一手が必ず付く」を原則にしているので、
 * ここもそれに合わせる。
 *
 * 見分けは、出てきた文字列の当てはめでやる。当然、外れることがある。
 * **だから当てはまらなかったときは、当てはまらなかったと言う。**
 * 外れた見立てを断定するくらいなら、生の出力を見せた方が役に立つ。
 */

export interface Diagnosis {
  /** 何が起きたか。分からなければ undefined */
  cause?: string;
  /** 次に何をすればよいか */
  nextStep?: string;
}

interface Pattern {
  /** 出力の中に、これがあれば当てはまり */
  match: RegExp;
  cause: string;
  nextStep: string;
}

/**
 * よくある落ち方。上から順に見て、最初に当たったものを採る。
 * 順番に意味がある（VRAM 不足は「読み込み失敗」としても出るので先に置く）。
 */
const PATTERNS: Pattern[] = [
  {
    match: /out of memory|cudaMalloc failed|failed to allocate|ggml_backend_cuda_buffer_type_alloc/i,
    cause: 'GPU のメモリが足りません。',
    nextStep: '層の載せ方を減らすか（--n-gpu-layers）、もっと小さい量子化のモデルにしてください。'
      + '`npm run models` で、この機械に載る組み合わせを計算できます。',
  },
  {
    match: /no such file|does not exist|failed to open|cannot open/i,
    cause: 'モデルのファイルを開けません。',
    nextStep: '置き場所と綴りを確認してください。`npm run models` で見えている一覧が、実際に読める場所です。',
  },
  {
    match: /unknown argument|invalid argument|unrecognized|error: invalid/i,
    cause: 'llama-server が、渡した指定を理解できていません。',
    nextStep: 'llama.cpp の版が古い可能性があります。新しくするか、'
      + '設定の runtime.commandArgs で渡している指定を見直してください。',
  },
  {
    match: /unknown model architecture|unsupported model|unknown \(magic|wrong magic/i,
    cause: 'この llama.cpp が、そのモデルの形式に対応していません。',
    nextStep: 'llama.cpp を新しくしてください。新しい形式のモデルは、古い llama.cpp では読めません。',
  },
  {
    match: /address already in use|bind: /i,
    cause: 'その口（ポート）は、別のものが使っています。',
    nextStep: '先に起動している llama-server か LM Studio を止めるか、別の口を使ってください。',
  },
  {
    match: /GGML_ASSERT|Segmentation fault|Aborted/i,
    cause: 'llama.cpp 自体が異常終了しました。',
    nextStep: 'モデルのファイルが壊れている可能性があります。取り直すか、別のモデルで試してください。',
  },
  {
    match: /is not recognized as an internal or external command|command not found|ENOENT/i,
    cause: 'llama-server の実行ファイルが見つかりません。',
    nextStep: '設定の runtime.command に、llama-server の場所を書いてください。',
  },
];

/** 出力から見立てる。当てはまらなければ、空の見立てを返す。 */
export function diagnose(output: string): Diagnosis {
  for (const p of PATTERNS) {
    if (p.match.test(output)) return { cause: p.cause, nextStep: p.nextStep };
  }
  return {};
}

/**
 * 人に見せる形にまとめる。
 * 見立てが付かなくても、生の出力は必ず添える。
 */
export function describeFailure(code: number | null, output: string): string {
  const { cause, nextStep } = diagnose(output);
  const head = `llama-server が起動に失敗しました (終了コード ${code ?? '不明'})`;
  const tail = output.trim();

  if (!cause) {
    return [
      head,
      tail,
      '',
      '見覚えのある落ち方ではありませんでした。上の出力が手がかりです。',
    ].filter((s) => s !== '').join('\n');
  }

  return [head, tail, '', `→ ${cause}`, `  ${nextStep}`].filter((s) => s !== '').join('\n');
}
