/**
 * CLI の案内は、その置かれ方で打てる形で言う（30 回目の調査の残り）。
 * `aas models` は、配った形でも `npm run models -- --get` と言っていた（`how()` を使っていなかった）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { noModelsHint } from '../src/cli/how.ts';

test('**配った形では、モデルが無いときの案内を AdaptiveAIStudio.cmd で言う**', async () => {
  const product = await tempDir('aas-hint-dist-');
  const app = join(product, 'app');
  await mkdir(app, { recursive: true });
  await writeFile(join(product, 'AdaptiveAIStudio.cmd'), '@echo off\r\n');
  const said = noModelsHint(app);
  assert.match(said, /AdaptiveAIStudio\.cmd models --get/);
  assert.match(said, /AdaptiveAIStudio\.cmd models --available/);
  assert.doesNotMatch(said, /npm run/, said);
});

test('クローンでは、今までどおり npm run で言う（対）', async () => {
  const repo = await tempDir('aas-hint-repo-');
  assert.match(noModelsHint(repo), /npm run models -- --get/);
});
