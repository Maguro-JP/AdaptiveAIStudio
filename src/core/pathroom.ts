/**
 * 道（パス）の長さ。
 *
 * Windows は道の全体が **260 文字** を超えると、その先を開けない。
 * bundle の中でいちばん深いファイルは 150 文字ほどあるので、
 * **展開先が長いと、展開の途中で警告が出て、途中までしか出てこない。**
 * 実際に利用者の機械で出た。
 *
 * 落ちるのは展開のときで、こちらのプログラムはまだ動いていない。
 * だから**組むときに深さを抑え**、**動いたときに余りを言う**。
 */
import { readdir } from 'node:fs/promises';

/** Windows の上限。終端の1文字を含んだ数え方。 */
export const WINDOWS_MAX_PATH = 260;

/**
 * あと何文字置けるか。負なら、その分だけ超えている。
 *
 * @param rootLength       置き場所の道の長さ（例: `Z:\\AdaptiveAIStudio` なら 19）
 * @param deepestRelative  その中でいちばん深いものの、根からの長さ
 */
export function roomLeft(
  rootLength: number,
  deepestRelative: number,
  max = WINDOWS_MAX_PATH,
): number {
  // 根 + 区切り1 + 中の道。終端の1文字ぶんを引いて数える。
  return (max - 1) - (rootLength + 1 + deepestRelative);
}

/** いちばん深いものを探す。根からの相対で数える。 */
export async function deepestUnder(root: string): Promise<{ rel: string; length: number }> {
  let best = { rel: '', length: 0 };
  const names = await readdir(root, { recursive: true });
  for (const name of names) {
    const rel = String(name);
    if (rel.length > best.length) best = { rel, length: rel.length };
  }
  return best;
}

/** 深さの見立て。数え方と線引きを、見せ方から離しておく。 */
export type RoomLevel = 'ok' | 'warn' | 'bad';

/**
 * 余りから、どう言うかを決める。
 *
 * `warn` の線は 40 文字。モデル（.gguf）は名前が長く、
 * `data\models\qwen2.5-3b-instruct-q4_k_m.gguf` だけで 43 文字ある。
 * **置けるようになったあとで置けなくなる**のを、先に言うための線。
 */
export function judgeRoom(
  rootLength: number,
  deepestRelative: number,
  max = WINDOWS_MAX_PATH,
): { level: RoomLevel; room: number } {
  const room = roomLeft(rootLength, deepestRelative, max);
  if (room < 0) return { level: 'bad', room };
  return { level: room < 40 ? 'warn' : 'ok', room };
}
