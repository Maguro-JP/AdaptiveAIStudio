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
