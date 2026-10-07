/**
 * 試験の仮置き場。
 *
 * 各試験が mkdtemp で作りっぱなしにしていたため、
 * 一度走らせるごとに %TEMP% / /tmp に置き土産が積み上がっていた。
 * Windows では溜まった置き土産の走査（ウイルス対策の巻き添え）が効いてくる。
 * 打ち切られたときに残るのは避けられないが、最後まで走ったなら片づける。
 */
import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

after(async () => {
  // 片づけで投げると、全部通っていても走行そのものが赤くなる。
  // 消せないのは Windows で掴まれたままのときで、確かめたことの成否とは関係ない。
  await Promise.all(created.map((d) => rm(d, {
    recursive: true, force: true,
    // Windows は掴んだままの相手がいると消せない。少し待って諦める。
    maxRetries: 5, retryDelay: 100,
  }).catch(() => { /* 諦める。置き土産は次回の mkdtemp を邪魔しない */ })));
  // 一覧は空にしない。後の `after`（サーバーの止め際の保存）が同じ場所を作り直すので、終わるときにもう一度消す（下）
});

/*
 * **終わるときにも消す。**`after` は、この部品が読み込まれた時点の試験に付く。試験の中で後から読み込む
 * （`await import('./tmp.ts')`）と、もう走り出した試験の側に付いて一度も走らず、作った場所が残り続けた
 * （一回の確かめで千個を超え、ディスクを埋めた）。プロセスの終わりなら、どこから読み込まれても必ず通る。
 * ここは同期でしか書けない。掴まれていて消せないもの（Windows）は諦める
 */
process.on('exit', () => {
  for (const d of created) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 掴まれたままなら諦める */ }
  }
});

/**
 * その場で片づける。**投げない。**
 *
 * Windows は、打ち切った子processが掴んだままだと消せない（EBUSY）。
 * 後始末で投げると、試験そのものが落ちたように見える。実際に落ちたのは
 * 片づけであって、確かめたかったことは通っている —— これは嘘の赤になる。
 * 消せなければ諦めてよい。最後に after が retry つきでもう一度当たる。
 */
export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => { /* 掴まれたままなら諦める。after が拾う */ });
}

/** 仮の作業場所を作る。試験の終わりに自動で片づく。 */
export async function tempDir(prefix = 'aas-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
