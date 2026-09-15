import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, tokenize, normalizeTitle, formatRecall, formatEntry,
} from '../src/memory/memory.ts';

const DAY = 86_400_000;

describe('語に割る', () => {
  test('英語は語で割る', () => {
    assert.deepEqual(tokenize('fix the config loader'), ['fix', 'config', 'loader']);
  });

  test('日本語は2文字ずつで拾う（部分一致のため）', () => {
    const t = tokenize('設定の読み込み');
    assert.ok(t.includes('設定'));
    assert.ok(t.includes('読み'));
  });

  test('記号で落ちない', () => {
    assert.deepEqual(tokenize('  '), []);
    assert.deepEqual(tokenize('!?、。'), []);
  });
});

describe('覚える', () => {
  test('初めてなら新規になる', () => {
    const m = new Memory();
    const r = m.remember({ kind: 'fact', title: 'Ollama は 11434 番で待つ' });
    assert.equal(r.isNew, true);
    assert.equal(r.entry.confirms, 1);
  });

  test('同じことは上書きではなく確認回数が増える', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'Ollama は 11434 番で待つ' });
    const r = m.remember({ kind: 'fact', title: 'Ollama は 11434 番で待つ。' });
    assert.equal(r.isNew, false);
    assert.equal(r.reinforced, true);
    assert.equal(r.entry.confirms, 2);
    assert.equal(m.size, 1);
  });

  test('種類が違えば別の記憶', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: '同じ題' });
    m.remember({ kind: 'decision', title: '同じ題' });
    assert.equal(m.size, 2);
  });

  test('覚え直しで詳しい話が増えるなら受け取る', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'x', detail: '短い' });
    const r = m.remember({ kind: 'fact', title: 'x', detail: 'もっと詳しい説明がある' });
    assert.equal(r.entry.detail, 'もっと詳しい説明がある');
  });

  test('覚え直しで詳しい話を失わない', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'x', detail: 'もっと詳しい説明がある' });
    const r = m.remember({ kind: 'fact', title: 'x', detail: '短い' });
    assert.equal(r.entry.detail, 'もっと詳しい説明がある');
  });
});

describe('決め直し', () => {
  test('古い決定は消さずに繋ぐ', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'decision', title: 'Ollama を使う', tags: ['runtime'] }).entry;
    const b = m.remember({
      kind: 'decision', title: 'llama.cpp を使う', tags: ['runtime'], supersedes: a.id,
    }).entry;
    assert.equal(m.size, 2, '古い決定が消えている');
    assert.equal(m.all().find((e) => e.id === a.id)!.supersededBy, b.id);
  });

  test('決め直した古い決定は思い出さない', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'decision', title: 'Ollama を使う', tags: ['runtime'] }).entry;
    m.remember({ kind: 'decision', title: 'llama.cpp を使う', tags: ['runtime'], supersedes: a.id });
    const got = m.recall('使う', { kinds: ['decision'] });
    assert.deepEqual(got.map((e) => e.title), ['llama.cpp を使う']);
  });

  test('なぜ変えたのかを辿れる', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'decision', title: '一つ目' }).entry;
    const b = m.remember({ kind: 'decision', title: '二つ目', supersedes: a.id }).entry;
    const c = m.remember({ kind: 'decision', title: '三つ目', supersedes: b.id }).entry;
    assert.deepEqual(m.history(c.id).map((e) => e.title), ['一つ目', '二つ目', '三つ目']);
  });
});

describe('矛盾', () => {
  test('同じ話題で別のことを決めたら黙って飲み込まない', () => {
    const m = new Memory();
    m.remember({ kind: 'decision', title: '既定は autoEdit', tags: ['approval'] });
    const r = m.remember({ kind: 'decision', title: '既定は auto', tags: ['approval'] });
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]!.title, '既定は autoEdit');
  });

  test('決め直しと明示していれば矛盾ではない', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'decision', title: '既定は autoEdit', tags: ['approval'] }).entry;
    const r = m.remember({ kind: 'decision', title: '既定は auto', tags: ['approval'], supersedes: a.id });
    assert.deepEqual(r.conflicts, []);
  });

  test('話題が違えば矛盾ではない', () => {
    const m = new Memory();
    m.remember({ kind: 'decision', title: '既定は autoEdit', tags: ['approval'] });
    const r = m.remember({ kind: 'decision', title: 'Ollama を使う', tags: ['runtime'] });
    assert.deepEqual(r.conflicts, []);
  });

  test('決定以外は矛盾を見ない', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'A である', tags: ['x'] });
    const r = m.remember({ kind: 'fact', title: 'B である', tags: ['x'] });
    assert.deepEqual(r.conflicts, []);
  });
});

describe('思い出す', () => {
  test('話題が重ならないものは出さない', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'まったく無関係な話' });
    assert.deepEqual(m.recall('設定の読み込み'), []);
  });

  test('何度も確かめられたことが先に出る', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: '設定は環境変数で上書きできる' });
    m.remember({ kind: 'fact', title: '設定は JSON で書く' });
    m.remember({ kind: 'fact', title: '設定は JSON で書く' });
    m.remember({ kind: 'fact', title: '設定は JSON で書く' });
    const got = m.recall('設定');
    assert.equal(got[0]!.title, '設定は JSON で書く');
  });

  test('種類で絞れる', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: '設定は JSON' });
    m.remember({ kind: 'decision', title: '設定は一箇所に集める' });
    const got = m.recall('設定', { kinds: ['decision'] });
    assert.deepEqual(got.map((e) => e.kind), ['decision']);
  });

  test('件数を絞れる', () => {
    const m = new Memory();
    for (let i = 0; i < 20; i += 1) m.remember({ kind: 'fact', title: `設定の話 ${i}` });
    assert.equal(m.recall('設定', { limit: 3 }).length, 3);
  });
});

describe('同じ失敗を繰り返さない', () => {
  test('前に駄目だった手を思い出す', () => {
    const m = new Memory();
    m.remember({
      kind: 'attempt', title: '総時間で打ち切る', outcome: 'failed',
      detail: '遅いモデルが必ず殺される',
    });
    const got = m.failedBefore('打ち切りを総時間で入れる');
    assert.equal(got.length, 1);
    assert.ok(got[0]!.detail.includes('遅いモデル'));
  });

  test('うまくいった手は失敗として出さない', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: '停滞で打ち切る', outcome: 'worked' });
    assert.deepEqual(m.failedBefore('打ち切り'), []);
  });
});

describe('刈り込み', () => {
  test('上限以下なら何もしない', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'x' });
    assert.equal(m.compact({ max: 10 }), 0);
    assert.equal(m.size, 1);
  });

  test('決めたことと好みは刈らない', () => {
    const m = new Memory();
    const now = Date.now();
    m.remember({ kind: 'decision', title: '決定', now });
    m.remember({ kind: 'preference', title: '好み', now });
    for (let i = 0; i < 20; i += 1) m.remember({ kind: 'fact', title: `事実${i}`, now });
    m.compact({ max: 5, now });
    const kinds = m.all().map((e) => e.kind);
    assert.ok(kinds.includes('decision'));
    assert.ok(kinds.includes('preference'));
    assert.equal(m.size, 5);
  });

  test('一度しか見ていない古い事実から落ちる', () => {
    const now = Date.now();
    const m = new Memory();
    m.remember({ kind: 'fact', title: '古くて一度きり', now: now - 400 * DAY });
    m.remember({ kind: 'fact', title: '何度も確かめた', now: now - 400 * DAY });
    m.remember({ kind: 'fact', title: '何度も確かめた', now: now - 400 * DAY });
    m.remember({ kind: 'fact', title: '何度も確かめた', now: now - 400 * DAY });
    m.remember({ kind: 'fact', title: '新しい', now });
    const dropped = m.compact({ max: 2, now });
    assert.equal(dropped, 1);
    assert.equal(m.all().some((e) => e.title === '古くて一度きり'), false);
  });
});

describe('保存', () => {
  test('保存して読み直すと、確認回数まで戻る', async () => {
    const dir = await tempDir('aas-mem-');
    const path = join(dir, 'memory.jsonl');
    const a = new Memory(path);
    a.remember({ kind: 'decision', title: '決めたこと', tags: ['x'] });
    a.remember({ kind: 'fact', title: '事実' });
    a.remember({ kind: 'fact', title: '事実' });
    await a.save();

    const b = new Memory(path);
    await b.load();
    assert.equal(b.size, 2);
    assert.equal(b.all().find((e) => e.kind === 'fact')!.confirms, 2);
  });

  test('1行壊れても記憶全体を失わない', async () => {
    const dir = await tempDir('aas-mem-');
    const path = join(dir, 'memory.jsonl');
    const a = new Memory(path);
    a.remember({ kind: 'fact', title: '無事な記憶' });
    a.remember({ kind: 'fact', title: 'もう一つ' });
    await a.save();
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.split('\n')[0] + '\n{壊れた行\n' + raw.split('\n')[1] + '\n', 'utf8');

    const b = new Memory(path);
    await b.load();
    assert.equal(b.size, 2);
  });

  test('記憶が無いところから始めても落ちない', async () => {
    const m = new Memory(join(tmpdir(), 'aas-mem-none', 'nope.jsonl'));
    await m.load();
    assert.equal(m.size, 0);
  });

  test('保存先を持たなくても動く', async () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: 'x' });
    await m.save();
    assert.equal(m.size, 1);
  });
});

describe('渡す形', () => {
  test('確度が分かる形で出る', () => {
    const m = new Memory();
    m.remember({ kind: 'fact', title: '一度きりの記録' });
    m.remember({ kind: 'fact', title: '確かめた記録' });
    m.remember({ kind: 'fact', title: '確かめた記録' });
    m.remember({ kind: 'fact', title: '確かめた記録' });
    const out = formatRecall(m.recall('記録'));
    assert.ok(out.includes('一度だけ'));
    assert.ok(out.includes('確か'));
  });

  test('失敗した試みは失敗と分かる', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'これは駄目だった', outcome: 'failed' });
    assert.ok(formatRecall(m.recall('駄目')).includes('（失敗した）'));
  });

  test('何も無ければ空', () => {
    assert.equal(formatRecall([]), '');
  });

  test('一覧に決め直し済みが分かる', () => {
    const m = new Memory();
    const a = m.remember({ kind: 'decision', title: '古い' }).entry;
    m.remember({ kind: 'decision', title: '新しい', supersedes: a.id });
    assert.ok(formatEntry(m.all()[0]!).includes('決め直し済み'));
  });
});

describe('表記の揺れ', () => {
  test('空白と句読点を無視して同じと見る', () => {
    assert.equal(normalizeTitle('設定は JSON で書く。'), normalizeTitle('設定はJSONで書く'));
  });
});

describe('番号', () => {
  /**
   * 刈り込みで途中の番号が抜けたあと、読み込み直して覚えると、
   * **既にあるものと同じ番号を配っていた。**件数から続きを決めていたため。
   * 同じ番号があると、決め直しの繋ぎ先も、忘れる先も、当たる相手が変わる。
   */
  test('**途中が抜けた後も、同じ番号を配らない**', async () => {
    const dir = await tempDir('aas-mem-seq-');
    const path = join(dir, 'memory.jsonl');

    const first = new Memory(path);
    for (let i = 0; i < 5; i += 1) first.remember({ kind: 'fact', title: `事実 ${i}` });
    await first.save();

    // 途中を落とす（刈り込みの後の姿）
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`);

    const memory = new Memory(path);
    await memory.load();
    assert.deepEqual(memory.all().map((e) => e.id), ['m1', 'm3']);

    memory.remember({ kind: 'fact', title: '新しい事実' });
    const ids = memory.all().map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `同じ番号を配っている: ${ids.join(', ')}`);
  });

  test('番号が続くので、決め直しが別のものに当たらない', async () => {
    const dir = await tempDir('aas-mem-seq2-');
    const path = join(dir, 'memory.jsonl');

    const first = new Memory(path);
    for (let i = 0; i < 4; i += 1) first.remember({ kind: 'decision', title: `決めごと ${i}` });
    await first.save();
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`);

    const memory = new Memory(path);
    await memory.load();
    const added = memory.remember({ kind: 'decision', title: 'あとから決めたこと' });
    // 新しいものが、残っていた m3 の番号を横取りしていない。
    assert.notEqual(added.entry.id, 'm3');
    assert.equal(memory.all().filter((e) => e.id === 'm3').length, 1);
    assert.equal(memory.all().find((e) => e.id === 'm3')?.title, '決めごと 2');
  });
});

/**
 * 語が一つも取れない依頼で、全部を思い出していた。
 *
 * 当たり判定は `overlap === 0 && q.size > 0` で外していたので、語がゼロだと
 * この条件が成り立たず、**全部が当たりとして残る**。実機で「1+1=」と送ったら
 * 関係の無い「src/a.txt を書き換えて」が依頼に差し込まれ、2B が混乱した並びを
 * 返した（tokenize('1+1=') は []）。
 */
describe('語が取れない依頼では、思い出さない', () => {
  const stocked = () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'src/a.txt を書き換えて', detail: '触ったもの: src/a.txt' });
    m.remember({ kind: 'fact', title: '設定は aas.config.json に置く' });
    m.remember({ kind: 'decision', title: 'コンテキストウィンドウは 8192 を既定にする' });
    return m;
  };

  test('**「1+1=」で何も思い出さない**（語がゼロ）', () => {
    assert.equal(tokenize('1+1=').length, 0, '前提が崩れている');
    assert.deepEqual(stocked().recall('1+1=', { lessons: false }), []);
  });

  test('記号だけでも思い出さない', () => {
    assert.deepEqual(stocked().recall('!?、。', { lessons: false }), []);
    assert.deepEqual(stocked().recall('   ', { lessons: false }), []);
  });

  test('**語が取れれば、ちゃんと思い出す（対）**', () => {
    const hits = stocked().recall('src/a.txt を直したい', { lessons: false });
    assert.ok(hits.length > 0, '語が重なっているのに思い出していない');
    assert.ok(hits.some((e) => e.title.includes('src/a.txt')));
  });

  test('嫌がられたことは、語がゼロでも残す（話題に関係なく効かせる）', () => {
    const m = stocked();
    m.remember({ kind: 'displeasure', title: '同じ一覧を貼らない' });
    const hits = m.recall('1+1=');
    assert.equal(hits.length, 1, '嫌がられたことだけが残るはず');
    assert.equal(hits[0]!.kind, 'displeasure');
  });
});
