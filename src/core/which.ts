/**
 * その命令が、この機械で本当に呼べるか。
 *
 * bundle には npm も npx も入っていない（node だけを同梱している）。
 * それでも設定の `mcp.servers` には `npx` と書けてしまうので、
 * **書いたのに何も起きない**が起きる。立ち上げてから失敗を読むのではなく、
 * 手前で見て「その命令がありません」と言えるようにする。
 *
 * 走らせる場所で結果が変わらないよう、環境は**渡してもらう**。
 */
import { existsSync } from 'node:fs';
import { win32, posix } from 'node:path';

export interface WhichEnv {
  platform: NodeJS.Platform;
  /** PATH の中身 */
  path?: string | undefined;
  /** Windows の PATHEXT。無ければ既定の並びを使う */
  pathext?: string | undefined;
  /** 在るかどうかの見方。試験から差し替える */
  exists?: (p: string) => boolean;
}

/** PATHEXT が無い Windows での既定。cmd.exe が見る順に合わせる。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * 見つかれば、その場所を返す。無ければ undefined。
 *
 * 道（`/` `\`）を含む名前は、PATH を見ない。書いてある場所だけを見る。
 */
export function findOnPath(command: string, env: WhichEnv): string | undefined {
  const exists = env.exists ?? existsSync;
  const win = env.platform === 'win32';
  // **走らせている場所の区切りを使わない。**Linux で Windows の道を組み立てると
  // `C:\\nodejs/npx` になり、在るものを見落とす（試験で見つけた）。
  const path = win ? win32 : posix;
  // Windows は名前だけで呼べる拡張子が決まっている（PATHEXT）。
  // .bin を足してあるのは、クラウドドライブが .exe を落とすため（start.cmd と同じ事情）。
  const exts = win
    ? (env.pathext ?? DEFAULT_PATHEXT).split(';').filter((e) => e.length > 0)
    : [];

  const candidates = (base: string): string[] => {
    // 既に拡張子が付いていれば、そのまま。付いていなければ足して探す。
    if (!win) return [base];
    // 拡張子が付いていれば、そのまま探す。足すと node.exe.EXE を探すことになる。
    return /\.[a-z0-9]+$/i.test(base) ? [base] : [base, ...exts.map((e) => base + e)];
  };

  if (/[\\/]/.test(command)) {
    return candidates(command).find((c) => exists(c));
  }

  const dirs = (env.path ?? '').split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const hit = candidates(path.join(dir, command)).find((c) => exists(c));
    if (hit) return hit;
  }
  return undefined;
}

/** いまの環境で見る、短い呼び方。 */
export function canRun(command: string): boolean {
  return findOnPath(command, {
    platform: process.platform,
    path: process.env.PATH,
    pathext: process.env.PATHEXT,
  }) !== undefined;
}
