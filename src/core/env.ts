/**
 * トークンを、置き場の `.env` から読む。
 *
 * 設定ファイルにはトークンの**名前**しか書かない（値は書かない）と決めた。
 * では値はどこに置くのか。環境変数を自分で立てられる人ばかりではないし、
 * 会社の PC では立てられない。**データの置き場（`data\\.env`）に一行ずつ置く**。
 * `.env` は保護の既定に入っているので、モデルは書けないし、見る窓にも出ない。
 *
 *   GITHUB_TOKEN=ghp_xxxx
 *   # 先頭が # の行は注釈
 *
 * 既にある環境変数は上書きしない。外から渡されたものが勝つ。
 * 依存は増やさない（dotenv は入れない）。形は一行 `KEY=VALUE` だけ。
 */
import { readFileSync } from 'node:fs';
import { inOrder } from './in-order.ts';

/** 一行ずつ読む。壊れた行は飛ばす（そこで全部を止めない）。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 先頭の BOM（古いメモ帳の utf8 保存）は、下の trim() が空白として外す。
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // 両端の引用符は外す。中の # は値の一部（引用符が無いときだけ注釈と見る）。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * `.env` から入れた名前。**値は持たない。**
 *
 * ここに入っているものは「この機械の持ち主が、トークンとして置いた値」なので、
 * 子のプロセス（外部ツール・`run_command`）へは渡さない。渡す先を決めるのに
 * 名前が要るので、入れた時点で覚えておく。
 */
const fromEnvFile = new Set<string>();

/** `.env` から入れた名前（値は返さない）。 */
export function secretNames(): string[] {
  return [...fromEnvFile];
}

/**
 * 名前だけで見た「トークンらしさ」。`.env` を通っていないものも拾う。
 *
 * `.env` に置かず、自分で `export` している人も居る。名前で見ておけば、
 * そこも渡さずに済む（外れることはあるが、外れて困るのは**渡らない**側で、
 * 渡ってしまう側ではない）。
 */
const LOOKS_SECRET = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS?|COOKIE|SESSION)S?(_|$)/i;

/**
 * 子のプロセスへ渡す環境変数。**トークンは入れない。**
 *
 * `spawn` に `env` を渡さないと、親の環境変数がそのまま全部子へ行く。
 * 外部ツール（MCP）の子も、`run_command` で走らせるものも同じで、
 * **`echo` 一つでトークンが読めた**（出力はモデルの履歴と会話の記録に入る。
 * 遠くのモデルを候補に入れていれば、そこへも出て行く）。
 *
 * 渡す先で本当に要るものは、外部ツールなら `envFrom` で名前を書く。
 * `run_command` で要るなら、その場の命令に書く（`KEY=... npm test` のように）。
 */
export function envForChild(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (fromEnvFile.has(key)) continue;
    if (LOOKS_SECRET.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 読んで環境変数へ入れる。**既にあるものは上書きしない。**
 * 入れた名前を返す（値は返さない。記録にも出さない）。
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
    // 入れた名前を覚える（子へ渡さないため）。値は覚えない。
    if (env === process.env) fromEnvFile.add(key);
  }
  return loaded;
}

/**
 * トークンを1つ書き足す（同じ名前があれば差し替える）。
 *
 * **他の行を残す。**丸ごと書き直すと、手で書いた別のトークンや注釈が消える。
 * 値は返さないし、記録にも出さない（呼ぶ側で出させないため、名前だけ返す）。
 *
 * **本人しか読めない権限で置く。**ここに入るのは GITHUB_TOKEN のような
 * トークンそのもの。既定のまま書くと 644（同じ機械の他の利用者が読める）に
 * なっていた。鍵をどこに置くかで守れる範囲が決まる、という話の入口で、
 * いちばん安いのがここ。
 *
 * Windows では権限の考え方が違うので、この一手はほぼ効かない（読み取り専用の
 * 印を触るだけ）。**効かない所で落とさない**ように、失敗しても進む。
 *
 * @returns 書いた名前
 */
export async function writeEnvValue(path: string, key: string, value: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`トークンの名前として使えません: ${key}`);
  // 改行を混ぜられると、一行で別のトークンを足せてしまう。
  if (/[\r\n]/.test(value)) throw new Error('トークンに改行は入れられません');
  /*
   * 同じファイルへの書き込みは一つずつ。読んで一行足して全部を書き戻すので、二つの口（GitHub を繋ぐ・MCP を繋ぐ）が同時に書くと、
   * 後の書き込みが前の行を消していた（動いている間は環境に値が在るので気づかず、立ち上げ直すと消えている）
   */
  return inOrder(path, () => writeEnvValueNow(path, key, value));
}

async function writeEnvValueNow(path: string, key: string, value: string): Promise<string> {

  const { writeFile, mkdir, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  /*
   * バイト列で読む。utf8 でないもの（Shift_JIS の注釈）を文字として読んで書き戻すと、全体が化ける。
   * 先頭の BOM と行末（CRLF）は、読んだ形のまま書き戻す。
   */
  const { contentOf, readPrior } = await import('../harness/put-back.ts');
  /*
   * **読めないときは書かない。**「無い」以外の読めなさ（ウイルス対策・同期ソフトが一瞬掴んだ等）を空として読み、
   * 空に一行足して丸ごと書き直していたので、そこに在ったほかのトークンが全部消えていた。
   */
  const bytes = await readPrior(path).catch((e: unknown) => {
    throw new Error(`${path} を読めないので書き換えません（${(e as Error).message}）。ほかのトークンを消さないためです。少し置いてから、もう一度入れてください`);
  }) ?? Buffer.alloc(0);
  const decoded = contentOf(bytes);
  if (typeof decoded !== 'string') {
    throw new Error(`${path} は utf8 ではないので書き換えません（化けるため）。utf8 で保存し直してから、もう一度入れてください`);
  }
  const bom = decoded.startsWith('\uFEFF') ? '\uFEFF' : '';
  const before = decoded.slice(bom.length);
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const line = `${key}=${value}`;
  let replaced = false;
  const after = lines.map((raw) => {
    const t = raw.trim();
    if (t.startsWith('#')) return raw;
    const eq = t.indexOf('=');
    if (eq <= 0 || t.slice(0, eq).trim() !== key) return raw;
    replaced = true;
    return line;
  });
  // 末尾の空行を増やさない（書き換えるたびに一行ずつ増えていた）。
  while (after.length > 0 && after[after.length - 1]!.trim() === '') after.pop();
  if (!replaced) after.push(line);
  // 作るときの権限。既に在るファイルには効かないので、下で付け直す。
  await writeFile(path, `${bom}${after.join(eol)}${eol}`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => { /* Windows では効かない。落とさない */ });
  return key;
}
