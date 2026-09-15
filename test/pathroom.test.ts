/**
 * 道の長さ。Windows の 260 文字に、展開の時点で当たる。
 *
 * 利用者の機械で実際に警告が出た。落ちるのは展開のときで、
 * こちらのプログラムはまだ動いていない。だから**組むときに抑える**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { roomLeft, deepestUnder, judgeRoom, WINDOWS_MAX_PATH } from '../src/core/pathroom.ts';

describe('道の長さ', () => {
  test('余りを数える', () => {
    // Z:\AdaptiveAIStudio（19）に、149 文字のものを置く。
    // 19 + 1 + 149 = 169。260 の一つ手前（259）まで使えるので、余り 90。
    assert.equal(roomLeft(19, 149), 90);
  });

  test('超えていれば負で返る', () => {
    assert.ok(roomLeft(200, 149) < 0, '超えているのに余りがある');
    assert.equal(roomLeft(WINDOWS_MAX_PATH - 1, 0), -1);
  });

  test('いちばん深いものを、根からの相対で数える', async () => {
    const dir = await tempDir('aas-deep-');
    await mkdir(join(dir, 'a', 'bb', 'ccc'), { recursive: true });
    await writeFile(join(dir, 'a', 'bb', 'ccc', 'dddd.txt'), 'x');
    await writeFile(join(dir, 'short.txt'), 'x');
    const deepest = await deepestUnder(dir);
    // 区切りは走らせる場所のもの。長さだけを見る（Windows で数えても同じ）。
    assert.equal(deepest.length, join('a', 'bb', 'ccc', 'dddd.txt').length);
    assert.match(deepest.rel, /dddd\.txt$/);
  });

  test('線引き。超えていれば止め、際どければ言う', () => {
    // Z:\AdaptiveAIStudio（19）に 151 のもの → 余り 88。置ける。
    assert.deepEqual(judgeRoom(19, 151), { level: 'ok', room: 88 });
    // 深い所（例: 展開先が二重になった）→ 余りが減る。
    assert.equal(judgeRoom(90, 151).level, 'warn', 'モデルを置けなくなる手前で言っていない');
    assert.equal(judgeRoom(120, 151).level, 'bad', '超えているのに止めていない');
  });

  test('モデルの名前ぶんを見込んでいる', () => {
    // data\models\qwen2.5-3b-instruct-q4_k_m.gguf = 43 文字。
    // 余りがそれを下回るなら、いま動いていても、置く段で詰まる。
    const name = 'data\\models\\qwen2.5-3b-instruct-q4_k_m.gguf';
    assert.ok(name.length > 40, `線引きより短い: ${name.length}`);
    const room = judgeRoom(WINDOWS_MAX_PATH - 1 - 1 - 151 - 39, 151);
    assert.equal(room.level, 'warn');
    assert.ok(room.room < name.length, 'モデルが置ける余りなのに言っている');
  });

  test('空でも落ちない', async () => {
    const dir = await tempDir('aas-empty-');
    assert.equal((await deepestUnder(dir)).length, 0);
  });
});
