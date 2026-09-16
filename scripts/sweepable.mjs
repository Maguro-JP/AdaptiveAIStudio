/**
 * sweep を動かせるかを決める。
 *
 * `scripts/check-bundle.mjs` は「Chromium が無い機械ではそう言う」と書いて
 * ありながら、実際には落ちていた（`playwright-core` が無いと、読み込むだけで
 * 死ぬ）。つまり**あの一つの命令が、配る先の機械では最後まで通らなかった。**
 * 確かめる命令が途中で死ぬと、その先（止まるところまで見る）も見ないまま終わる。
 *
 * ここだけ別のファイルにしてあるのは、**判定を試験から読むため**。
 * `check-bundle.mjs` は読み込むだけで bundle を組み始めるので、そこから
 * 取り出せない。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './find-browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{ resolve?: (name: string) => string; platform?: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean }} how
 * @returns {{ ok: true } | { ok: false; why: string }}
 */
export function sweepable(how = {}) {
  const resolve = how.resolve ?? createRequire(join(root, 'package.json')).resolve;
  try {
    resolve('playwright-core');
  } catch {
    return { ok: false, why: 'playwright-core が入っていません（npm i --no-save playwright-core で入ります）' };
  }
  const picked = findBrowser({
    platform: how.platform ?? process.platform,
    env: how.env ?? process.env,
    exists: how.exists ?? existsSync,
  });
  return picked.ok ? { ok: true } : { ok: false, why: picked.why };
}
