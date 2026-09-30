/**
 * 設定に書いた項目は、黙って捨てない。
 *
 * 読み込みは項目を一つずつ拾っていたので、拾い忘れた `network` と `chatSystem` は書いても捨てていた。
 * `network.enabled: false` と書いても外へ出る道（fetch_url）は開いたままで、承認が自動なら訊かずに外へ取りに行っていた。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { tempDir } from './tmp.ts';
import { hideAasEnv } from './env.ts';

let restore: () => void = () => undefined;
before(() => { restore = hideAasEnv(); });
after(() => { restore(); });

test('network と chatSystem を書いたとおりに読む', async () => {
  const dir = await tempDir('aas-cfg-keys-');
  await writeFile(join(dir, 'aas.config.json'), JSON.stringify({
    network: { enabled: false, allowedHosts: ['x.test'] },
    chatSystem: '話すときのシステムプロンプト',
  }), 'utf8');
  const { config } = loadConfig(dir);
  assert.equal(config.network?.enabled, false, 'network を捨てた（外へ出る道を閉じられない）');
  assert.deepEqual(config.network?.allowedHosts, ['x.test']);
  assert.equal(config.chatSystem, '話すときのシステムプロンプト');
});

test('既定を埋める項目は、今までどおり埋める（対）', async () => {
  const dir = await tempDir('aas-cfg-keys2-');
  await writeFile(join(dir, 'aas.config.json'), JSON.stringify({ temperature: 0.3 }), 'utf8');
  const { config } = loadConfig(dir);
  assert.equal(config.temperature, 0.3);
  assert.equal(config.runtime?.kind, 'inproc');
  assert.ok(Array.isArray(config.providers));
  assert.deepEqual(config.roles, []);
});
