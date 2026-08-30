/**
 * 動かない理由が、こちらの外にあることがある。
 *
 * ローカルでモデルを動かす層（llama.cpp とその上に載っているもの全部）は
 * ネイティブの実行ファイルで、Windows まわりで決まった詰まり方をする。
 * こちらの作りがどれだけ正しくても、そこで止まっていたら何も動かない。
 *
 * だから「うちは悪くない」で終わらせず、**外側の詰まりも見に行く**。
 * 見つけたら、次に打つ一手まで添える。
 */
import { spawn } from 'node:child_process';

export interface EnvIssue {
  level: 'warn' | 'bad';
  title: string;
  detail: string;
  fix: string;
}

/**
 * 非ASCIIを含むパス。
 *
 * llama.cpp 系はモデルを開くときにワイド文字APIを通らない箇所があり、
 * 全角や日本語を含むパスだとファイルを開けずに落ちることがある。
 * Node 側は平気なので、こちらの表示は正常なまま、
 * 「モデルだけ読めない」という分かりにくい形で出る。
 */
export function hasNonAscii(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7f]/.test(path);
}

/** そのパスのうち、非ASCIIの部分を抜き出す。何が悪いのかを指させるように。 */
export function nonAsciiPart(path: string): string {
  return [...path].filter((ch) => hasNonAscii(ch)).join('');
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve(undefined);
    }
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : undefined); });
  });
}

/** NVIDIA ドライバの版。CUDA が動くかどうかの、いちばん外側の条件。 */
export async function nvidiaDriver(): Promise<{ driver: string; cuda?: string } | undefined> {
  const out = await run('nvidia-smi', [
    '--query-gpu=driver_version', '--format=csv,noheader,nounits',
  ]);
  if (!out) return undefined;
  const driver = out.split('\n')[0]?.trim();
  if (!driver) return undefined;

  // CUDA の版は別の出し方でしか取れない
  const full = await run('nvidia-smi', []);
  const cuda = full?.match(/CUDA Version:\s*([\d.]+)/)?.[1];
  return { driver, cuda };
}

export interface EnvContext {
  /** 記録の置き場 */
  stateDir: string;
  /** 作業ディレクトリ */
  root: string;
  /** GGUF を置いている場所（llamacpp のとき） */
  modelsDir?: string;
  /** GPU を検出できているか */
  hasGpu: boolean;
  /** 既定は動いている環境。試験のために差し替えられるようにしておく。 */
  platform?: NodeJS.Platform;
  /** 利用者の既定フォルダ。Windows で Ollama の置き場を組み立てるのに使う。 */
  userProfile?: string;
}

/**
 * 外側の詰まりを探す。
 * 見つからなければ空を返す。無いのが正常。
 */
export async function inspectEnvironment(ctx: EnvContext): Promise<EnvIssue[]> {
  const issues: EnvIssue[] = [];
  const windows = (ctx.platform ?? process.platform) === 'win32';

  if (windows) {
    // 置き場のうち、モデルを読む側（ネイティブ）が触るところだけを見る。
    const paths: Array<[string, string]> = [
      ['作業ディレクトリ', ctx.root],
      ['モデルの置き場', ctx.modelsDir ?? ''],
      ['既定の Ollama 置き場', `${ctx.userProfile ?? process.env.USERPROFILE ?? ''}\\.ollama`],
    ];
    for (const [label, path] of paths) {
      if (!path || !hasNonAscii(path)) continue;
      issues.push({
        level: 'bad',
        title: `${label}に全角・日本語が入っています`,
        detail: `${path}  ← ${nonAsciiPart(path)}`,
        fix: 'llama.cpp 系（LM Studio・Ollama の中身）は、'
          + 'モデルを開くときにこの種の文字を扱えないことがあります。\n'
          + 'ASCII だけの場所に移してください。例:\n'
          + '  set OLLAMA_MODELS=C:\\ai\\ollama\n'
          + '  （llama.cpp なら modelsDir を C:\\ai\\models などにする）\n'
          + 'これが LM Studio でモデルを読めない原因のことがあります。',
      });
    }
  }

  if (ctx.hasGpu) {
    const nv = await nvidiaDriver();
    if (!nv) {
      issues.push({
        level: 'warn',
        title: 'nvidia-smi を実行できません',
        detail: 'GPU は見つかっているのに、ドライバ側の情報が取れません',
        fix: 'NVIDIA ドライバを入れ直すか、再起動してください。'
          + 'CUDA を使う実行ファイルは、これが通らないと動きません。',
      });
    } else if (nv.cuda === undefined) {
      issues.push({
        level: 'warn',
        title: 'CUDA の版を確認できません',
        detail: `ドライバ ${nv.driver}`,
        fix: 'ドライバは入っていますが CUDA の情報が出ていません。'
          + 'GPU を使う実行ファイルが CPU 実行に落ちている可能性があります。',
      });
    }
  }

  return issues;
}

/** ドライバの版を、確認できたときだけ一行で。 */
export async function describeDriver(): Promise<string | undefined> {
  const nv = await nvidiaDriver();
  if (!nv) return undefined;
  return nv.cuda ? `ドライバ ${nv.driver} / CUDA ${nv.cuda}` : `ドライバ ${nv.driver}`;
}
