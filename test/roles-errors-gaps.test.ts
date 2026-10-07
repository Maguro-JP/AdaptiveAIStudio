/**
 * 名簿と、相手の誤りの分け方の不具合（60 回目の調査）。
 *
 * - 400 の本文に「context」という語があるだけで「大きすぎる」とし、ツールの引数の形の誤りを黙って次の候補へ回した
 * - 分単位の制限（語は「exceeded your current quota」）も残高切れとして 30 分冷やした（相手の本文の形は確かめていない）
 * - 権限の並べ替えだけで「権限が変わった」と知らせた
 * - 引き継ぎ先を外しても知らせなかった
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { kindFromHttpStatus } from '../src/providers/errors.ts';
import { RoleLedger } from '../src/roles/ledger.ts';
import type { Role } from '../src/roles/role.ts';

describe('相手の誤りの分け方', () => {
  test('**ツールの引数の形の誤りは、大きすぎるとしない**', () => {
    const body = JSON.stringify({ error: { message: "Invalid schema for function 'f': In context=('properties', 'a'), array schema missing items.", code: 'invalid_function_parameters' } });
    assert.equal(kindFromHttpStatus(400, body), 'invalid_request');
    // 符号が無くても、語で取り違えない
    assert.equal(kindFromHttpStatus(400, "Invalid schema for function 'f': In context=('properties', 'a')"), 'invalid_request');
  });

  test('文脈の長さを超えたものは、大きすぎるとする（対）', () => {
    assert.equal(kindFromHttpStatus(400, JSON.stringify({ error: { message: 'x', code: 'context_length_exceeded' } })), 'context_too_long');
    assert.equal(kindFromHttpStatus(400, "This model's maximum context length is 8192 tokens"), 'context_too_long');
    assert.equal(kindFromHttpStatus(400, 'prompt is too long: 300000 tokens'), 'context_too_long');
  });

  test('**分単位の制限は、残高切れにしない**', () => {
    const body = JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 41s', status: 'RESOURCE_EXHAUSTED' } }]);
    assert.equal(kindFromHttpStatus(429, body), 'rate_limited');
    assert.equal(kindFromHttpStatus(429, JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })), 'quota_exhausted', '本物の残高切れ（対）');
  });
});

const role = (over: Partial<Role> & { id: string }): Role => ({
  codename: over.id.toUpperCase(), name: '担当', responsibility: '責務', disposition: '姿勢',
  access: ['read'], instructions: ['a', 'b', 'c'], ...over,
});

describe('名簿', () => {
  test('**権限の並べ替えだけでは知らせない**', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout', access: ['read', 'network'] })]);
    assert.deepEqual(l.sync([role({ id: 'scout', access: ['network', 'read'] })]), []);
  });

  test('**引き継ぎ先を外したら知らせる**', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'a', succeededBy: ['b'] }), role({ id: 'b' })]);
    const changes = l.sync([role({ id: 'a', succeededBy: [] }), role({ id: 'b' })]);
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.equal(changes[0]!.kind, 'succeeded');
  });
});
