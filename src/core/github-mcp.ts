/**
 * GitHub に繋ぐ道具（MCP）を、どうやって起こすか。
 *
 * ここまで `npx -y @modelcontextprotocol/server-github` と書いていた。
 * **入れた機械では、これは動かない。**
 *
 *   ・`npx` は npm に付いてくる。bundle に入れているのは `node` だけ
 *   ・`-y` は毎回ネットから取ってくる。会社の PC は外へ出られない
 *
 * つまり「GitHub と繋ぐ」は、画面に口があるだけで**一度も繋がらない**。
 *
 * だから、道具そのものをbundle に入れて、**同梱の Node で直に起こす**。
 * 核の依存は増やさない（node-llama-cpp と同じで、bundle にだけ入れる）。
 * 作業コピーで動かすときは、入っていなければ npx へ落ちる。
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canRun } from './which.ts';

/** bundle の中の道具。ここに在れば、npx は要らない。 */
export function bundledGithubServer(from = dirname(fileURLToPath(import.meta.url))): string | undefined {
  // src/core/ の二つ上が app/。その下の node_modules を見る。
  const app = join(from, '..', '..');
  const at = join(app, 'node_modules', '@modelcontextprotocol', 'server-github', 'dist', 'index.js');
  return existsSync(at) ? at : undefined;
}

export interface McpLaunch {
  command: string;
  args: string[];
  /** 起こせるか。起こせないなら、なぜ。 */
  why?: string;
}

/**
 * 起こし方を決める。
 *
 * **同梱してあるなら、それ。**無ければ npx。どちらも無いなら、
 * 「無い」と言う（黙って繋がらないのがいちばん困る）。
 */
export function githubLaunch(
  opts: { bundled?: string | undefined; hasNpx?: boolean; node?: string } = {},
): McpLaunch {
  // **「無い」と渡されたら、無いものとして扱う。**
  // `!== undefined` で見ていたので、`{ bundled: undefined }` と渡しても
  // 置き場を探しに行き、**渡した側の言い分を無視**していた。
  // そのせいで、道具が入っている機械（CI・bundle）でだけ答えが変わった。
  const bundled = 'bundled' in opts ? opts.bundled : bundledGithubServer();
  if (bundled) {
    // 同梱の Node で起こす。PATH の Node に頼らない（入っていない機械がある）。
    return { command: opts.node ?? process.execPath, args: [bundled] };
  }
  const hasNpx = opts.hasNpx ?? canRun('npx');
  if (hasNpx) {
    return { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] };
  }
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    why: 'GitHub に繋ぐ道具が見つかりません。'
      + 'この bundle には入っていないようです（新しい版を入れ直すと入っています）。'
      + '作業コピーで使うなら、Node を入れるか `npm i @modelcontextprotocol/server-github` してください。',
  };
}
