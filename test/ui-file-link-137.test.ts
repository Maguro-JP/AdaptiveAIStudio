import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

test('外を指すリンク越しのファイルは「ありません」ではなく「作業場の外」と言う', { skip: process.platform === 'win32' }, async () => {
  const home = await tempDir('aas-uifile137-');
  const work = join(home, 'work');
  const outside = join(home, 'outside');
  await mkdir(work, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'o.txt'), 'secret');
  await symlink(outside, join(work, 'lnk'));
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  const { UiServer } = await import('../src/ui/server.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const server = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, agent: { root: work, approval: 'auto' }, initiative: { enabled: false } } as never });
  const base = (await server.start()).replace(/\/$/, '');
  try {
    const viaLink = await fetch(`${base}/api/file?path=${encodeURIComponent('lnk/o.txt')}`);
    assert.equal(viaLink.status, 400);
    assert.doesNotMatch(await viaLink.text(), /secret/);
    const missing = await fetch(`${base}/api/file?path=nothing.txt`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});
