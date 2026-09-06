/**
 * 合言葉を、置き場の `.env` から読む。
 *
 * 設定ファイルには合言葉の**名前**しか書かない（値は書かない）と決めた。
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

/** 一行ずつ読む。壊れた行は飛ばす（そこで全部を止めない）。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
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
  }
  return loaded;
}

/**
 * 合言葉を1つ書き足す（同じ名前があれば差し替える）。
 *
 * **他の行を残す。**丸ごと書き直すと、手で書いた別の合言葉や注釈が消える。
 * 値は返さないし、記録にも出さない（呼ぶ側で出させないため、名前だけ返す）。
 *
 * **本人しか読めない権限で置く。**ここに入るのは GITHUB_TOKEN のような
 * 合言葉そのもの。既定のまま書くと 644（同じ機械の他の利用者が読める）に
 * なっていた。鍵をどこに置くかで守れる範囲が決まる、という話の入口で、
 * いちばん安いのがここ。
 *
 * Windows では権限の考え方が違うので、この一手はほぼ効かない（読み取り専用の
 * 印を触るだけ）。**効かない所で落とさない**ように、失敗しても進む。
 *
 * @returns 書いた名前
 */
export async function writeEnvValue(path: string, key: string, value: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`合言葉の名前として使えません: ${key}`);
  // 改行を混ぜられると、一行で別の合言葉を足せてしまう。
  if (/[\r\n]/.test(value)) throw new Error('合言葉に改行は入れられません');

  const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  const before = await readFile(path, 'utf8').catch(() => '');
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
  if (!replaced) {
    // 末尾の空行を増やさない。
    while (after.length > 0 && after[after.length - 1]!.trim() === '') after.pop();
    after.push(line);
  }
  // 作るときの権限。既に在るファイルには効かないので、下で付け直す。
  await writeFile(path, `${after.filter((l, i) => !(l === '' && i === after.length)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => { /* Windows では効かない。落とさない */ });
  return key;
}
