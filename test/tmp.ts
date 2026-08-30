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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

after(async () => {
  await Promise.all(created.map((d) => rm(d, {
    recursive: true, force: true,
    // Windows は掴んだままの相手がいると消せない。少し待って諦める。
    maxRetries: 5, retryDelay: 100,
  })));
  created.length = 0;
});

/** 仮の作業場所を作る。試験の終わりに自動で片づく。 */
export async function tempDir(prefix = 'aas-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
