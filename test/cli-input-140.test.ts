import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLine } from '../src/cli/slash.ts';
import { expandCommand } from '../src/agent/commands.ts';
import { tempDir } from './tmp.ts';

test('全角の ／ で打った命令も命令として読む', () => {
  assert.equal(normalizeLine('  ／exit '), '/exit');
  assert.equal(normalizeLine('ふつうの依頼'), 'ふつうの依頼');
});

test('/ だけの行は依頼として送らず、知らない命令として使えるものを並べる', async () => {
  const root = await tempDir('aas-cli140-');
  const r = await expandCommand('/', root);
  assert.equal(r.kind, 'unknown');
  if (r.kind === 'unknown') assert.ok(r.known.length > 0);
});
