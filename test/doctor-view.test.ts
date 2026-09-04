/**
 * doctor の並べ方の検証。
 * 長い見出しが混ざっても、説明の列が揃っていることを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatChecks, nameColumn, summaryLine, type Check } from '../src/cli/doctor-view.ts';
import { displayWidth } from '../src/cli/width.ts';

/** 色を付けない見た目。桁の検証をするので、装飾は邪魔になる。 */
const plain = {
  mark: { ok: '  ok  ', warn: ' 注意 ', bad: ' 未了 ' },
  markWidth: 6,
  dim: (s: string) => s,
  hint: (s: string) => s,
  good: (s: string) => s,
};

const at = (line: string, text: string) => displayWidth(line.slice(0, line.indexOf(text)));

describe('doctor の並べ方', () => {
  test('見出しの長さが違っても説明の列が揃う', () => {
    const checks: Check[] = [
      { name: 'Node.js', level: 'ok', detail: 'v24.0.0' },
      { name: '設定', level: 'ok', detail: '既定値' },
      { name: '接続 (ollama)', level: 'bad', detail: '繋がりません' },
    ];
    const lines = formatChecks(checks, plain);
    const columns = lines.map((l, i) => at(l, checks[i]!.detail));
    assert.equal(new Set(columns).size, 1, `列がずれています: ${columns.join(', ')}`);
  });

  test('見出しが長いときは列幅を広げる', () => {
    const checks: Check[] = [
      { name: 'Node.js', level: 'ok', detail: 'v24.0.0' },
      { name: '既定の Ollama 置き場', level: 'warn', detail: 'C:\\ai\\ollama' },
    ];
    const lines = formatChecks(checks, plain);
    assert.equal(at(lines[0]!, 'v24.0.0'), at(lines[1]!, 'C:\\ai\\ollama'));
    assert.equal(lines.length, 2, '広げられる範囲なら折り返さない');
  });

  test('上限を超える見出しは説明を次の行へ落とし、列は保つ', () => {
    const long = 'nvidia-smi を実行できません（ドライバ側の情報が取れません）';
    const checks: Check[] = [
      { name: 'Node.js', level: 'ok', detail: 'v24.0.0' },
      { name: long, level: 'warn', detail: 'GPU は見つかっています' },
    ];
    const lines = formatChecks(checks, plain);

    assert.equal(lines.length, 3, '見出しの行と説明の行に分かれる');
    assert.ok(lines[1]!.includes(long));
    assert.equal(at(lines[0]!, 'v24.0.0'), at(lines[2]!, 'GPU は見つかっています'));
  });

  test('次の一手は矢印の下にぶら下がる', () => {
    const checks: Check[] = [
      { name: 'モデル', level: 'bad', detail: '土台がありません', fix: 'A を入れる\nB でもよい' },
    ];
    const lines = formatChecks(checks, plain);
    assert.equal(lines.length, 3);
    assert.equal(at(lines[1]!, '→'), plain.markWidth + 1);
    assert.equal(at(lines[2]!, 'B でもよい'), at(lines[1]!, 'A を入れる'));
  });

  test('列幅は下限と上限の内に収まる', () => {
    assert.equal(nameColumn([{ name: 'a', level: 'ok', detail: '' }]), 16);
    assert.equal(nameColumn([{ name: 'あ'.repeat(40), level: 'ok', detail: '' }]), 30);
  });

  /** 開発の場所の呼び方。 */
  const npmWay = { ui: 'npm run ui', agent: 'npm run agent' };

  test('未了が無ければ「動かせます」', () => {
    const ok: Check[] = [{ name: 'Node.js', level: 'ok', detail: 'v24' },
      { name: '接続', level: 'warn', detail: '遅いです' }];
    assert.match(summaryLine(ok, plain, npmWay), /動かせます/);
    assert.doesNotMatch(summaryLine(ok, plain, npmWay), /かたづければ/);
  });

  test('打てない一手を出さない', () => {
    // bundle には npm が無い。npm run ui と言われても打てない（実際に出していた）。
    const ok: Check[] = [{ name: 'Node.js', level: 'ok', detail: 'v24' }];
    const ng: Check[] = [{ name: 'モデル', level: 'bad', detail: 'ありません' }];
    const portable = { ui: 'AdaptiveAIStudio.cmd' };
    for (const line of [summaryLine(ok, plain, portable), summaryLine(ng, plain, portable)]) {
      assert.doesNotMatch(line, /npm/, line);
      assert.match(line, /AdaptiveAIStudio\.cmd/, line);
    }
    // 端末の道が無いなら、その案内も出さない。
    assert.doesNotMatch(summaryLine(ok, plain, portable), /端末/);
    assert.match(summaryLine(ok, plain, npmWay), /端末/);
  });

  test('未了があれば件数を出す', () => {
    const ng: Check[] = [{ name: 'モデル', level: 'bad', detail: 'ありません' }];
    assert.match(summaryLine(ng, plain, npmWay), /1 件かたづければ/);
  });
});
