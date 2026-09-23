/**
 * 外へ出る道と、書き込みを、同じ役職に持たせない。
 *
 * CLAUDE.md にも docs にも決まりとして書いてあったのに、**どこも見て
 * いなかった。**設定から足す役職は `access` をそのまま受け取るので、
 * `['write', 'network']` と書けば通った。外から入ってきたものを、そのまま
 * リポジトリへ書ける形で、検問所を置いた意味が無くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleRegistry, dropWriteIfOutbound } from '../src/roles/registry.ts';
import { BUILTIN_ROLES } from '../src/roles/builtin.ts';

test('外へ出る道があれば、write を落とす', () => {
  assert.deepEqual(dropWriteIfOutbound(['read', 'write', 'network']),
    { access: ['read', 'network'], dropped: true });
  assert.deepEqual(dropWriteIfOutbound(['read', 'write', 'mcp']),
    { access: ['read', 'mcp'], dropped: true });
  // 外へ出ないなら、そのまま。
  assert.deepEqual(dropWriteIfOutbound(['read', 'write', 'execute']),
    { access: ['read', 'write', 'execute'], dropped: false });
  // 外へ出るだけなら、落とすものが無い。
  assert.deepEqual(dropWriteIfOutbound(['read', 'network']),
    { access: ['read', 'network'], dropped: false });
});

test('設定から足した役職にも効く。そして黙って落とさない', () => {
  const said: string[] = [];
  const reg = new RoleRegistry([{
    id: 'both', name: '両方', responsibility: 'x', disposition: 'y',
    access: ['read', 'write', 'network'],
  }], (t) => said.push(t));
  assert.deepEqual(reg.get('both')?.access, ['read', 'network']);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /both/);
  assert.match(said[0]!, /write/);
  assert.deepEqual([...reg.droppedWrite], said);
});

test('元の役職を継いだときも、継いだ側の access を見る', () => {
  // extends だけ書いて access を書かなければ、元の役職のものが使われる。
  // 元の役職が既に両方持っていたら、そこでも落ちる。
  const reg = new RoleRegistry([{ id: 'copy', extends: 'scout' }]);
  const access = reg.get('copy')?.access ?? [];
  const outbound = access.includes('network') || access.includes('mcp');
  if (outbound) assert.ok(!access.includes('write'), '継いだ側に両方残っています');
});

test('組み込みの役職も、両方は持たない', () => {
  const bad = BUILTIN_ROLES
    .filter((r) => (r.access.includes('network') || r.access.includes('mcp'))
      && r.access.includes('write'))
    .map((r) => r.id);
  assert.deepEqual(bad, [], `外へ出る道と write を両方持っています: ${bad.join(', ')}`);
});

/**
 * **組み込みの役職も、同じ道を通す。**
 *
 * ここは素通しで入れていたので、守りが効くのは設定から足す役職だけだった。
 * いまの一覧に違反は無いが（上の試験）、足した人が気づけない形は残さない。
 */
test('組み込みとして渡ってきたものでも、write を落とす', () => {
  const said: string[] = [];
  const reg = new RoleRegistry([], (t) => said.push(t), [{
    id: 'envoy2', codename: 'envoy2', name: '外と話す係', responsibility: 'x', disposition: 'y',
    access: ['read', 'write', 'mcp'],
    instructions: [], prefers: 'any',
  }]);
  assert.deepEqual(reg.get('envoy2')?.access, ['read', 'mcp'],
    '組み込みの側では write が落ちていない');
  assert.equal(said.length, 1, '黙って落としている');
  assert.match(said[0]!, /envoy2/);
});
