/**
 * アイデアの拡張機能（src/extensions/ideas。docs/IDEAS.md）。
 *
 * 札は、語の掛け合わせで作る。モデルもネットワークも要らない。ここで見るのは:
 * - 同梱のデータ（語・型・仕組みの文）が読め、仕組みの文には出典の URL とライセンスの表示が付いている
 * - 種を固定すると同じ札が出る（蔵が同じなら）。種を変えると違う札が出る
 * - 形の合わない語を混ぜない（疑問節を「〜を取り除く」に入れない、など）
 * - テーマの語を足すと札に入り、外すと出なくなり、戻せる。文は語として受けない
 * - 残す（星）と語の重みが上がり、やめると戻り、蔵を開き直しても残っている
 * - 「もっと」は元の札の主題を引き継いだ別の札、「組み合わせる」は 2 枚の主題をぶつけた札
 * - 「なぜ」に、掛け合わせた語と、元の仕組みの文と出典が入る
 * - 件数の上限。壊れた蔵は脇へ移して空で始める
 * - ネットワークを呼ばない（fetch を、呼ぶと投げるものに替えて札を出す）
 * - 磨きの返事は、決めた形の行だけを受ける
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { combine, distance, render, signatureOf, SLOT_TO_POOL } from '../src/extensions/ideas/combinator.ts';
import { defaultLexicon, lexiconCounts, loadLexicon, DATA_DIR } from '../src/extensions/ideas/lexicon.ts';
import { rngFrom } from '../src/extensions/ideas/rng.ts';
import { IdeaService, IdeasError, STAR_FACTOR, MAX_COUNT, MIN_COUNT } from '../src/extensions/ideas/service.ts';
import { IdeaStore, MAX_RECENT, MAX_SAVED, MAX_WEIGHT, stateFrom } from '../src/extensions/ideas/store.ts';
import { autoThemes, cleanMaterial, wordsIn, MAX_AUTO_THEMES } from '../src/extensions/ideas/themes.ts';
import { parsePolish, polishPrompt, POLISH_SYSTEM } from '../src/extensions/ideas/polish.ts';

const AUTO = ['通知', '会議', '予約'];
const fresh = async (): Promise<{ dir: string; ideas: IdeaService }> => {
  const dir = await tempDir('aas-ideas-');
  return { dir, ideas: new IdeaService(dir, { now: () => 1_700_000_000_000 }) };
};
const originals = (cards: Array<{ original: string }>): string[] => cards.map((c) => c.original);

describe('同梱のデータ', () => {
  const lex = defaultLexicon();

  test('語・型・仕組みの文が読める（数は、移した元の数）', () => {
    assert.deepEqual(lexiconCounts(lex), { terms: 169, templates: 18, mechanisms: 57, mechanismsTotal: 128 });
    assert.equal(lex.moods.length, 6);
  });

  test('仕組みの文は、どれも出典の URL（ウィキペディア）と側面を持ち、ライセンスの表示が付いている', async () => {
    const raw = JSON.parse(await readFile(join(DATA_DIR, 'mechanisms.json'), 'utf8')) as { license: string; licenseUrl: string; mechanisms: Array<{ subject: string; how: string; source: string }> };
    assert.equal(raw.license, 'CC BY-SA 4.0');
    assert.match(raw.licenseUrl, /^https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//);
    assert.deepEqual(raw.mechanisms.filter((m) => !/^https:\/\/ja\.wikipedia\.org\/wiki\/.+/.test(m.source) || !m.how || !m.subject), []);
    const aspects = new Set(lex.pools.aspects!.filter((t) => t.kind === 'noun').map((t) => t.term));
    assert.deepEqual(lex.pools.mechanisms!.filter((m) => !aspects.has(m.aspect ?? '')).map((m) => m.term), [], '側面が、側面の語（名詞句）に無い');
    assert.equal(lex.mechanismsLicense.name, 'CC BY-SA 4.0');
  });

  test('同梱の表示（NOTICE.md）に、ライセンスの名前と、元のリポジトリと、出典の記事が全部載っている', async () => {
    const notice = await readFile(join(DATA_DIR, 'NOTICE.md'), 'utf8');
    assert.match(notice, /CC BY-SA 4\.0/);
    assert.match(notice, /https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//);
    assert.match(notice, /Maguro-JP\/IDEAMAN/);
    const raw = JSON.parse(await readFile(join(DATA_DIR, 'mechanisms.json'), 'utf8')) as { mechanisms: Array<{ source: string }> };
    const missing = [...new Set(raw.mechanisms.map((m) => m.source))].filter((url) => !notice.includes(url));
    assert.deepEqual(missing, [], '出典の記事が、表示に載っていない');
  });

  test('型の needs は、どれも引けるスロット。文の {…} は、needs か仕組みの付け足しで埋まる', () => {
    for (const t of lex.templates) {
      assert.deepEqual(t.needs.filter((s) => !SLOT_TO_POOL[s]), [], t.id);
      const holes = [...t.text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
      const filled = new Set([...t.needs, ...(t.needs.includes('mechanism') ? ['mechanism_how', 'mechanism_aspect'] : [])]);
      assert.deepEqual(holes.filter((h) => !filled.has(h)), [], t.id);
    }
  });

  test('空のプール・空の型は、読むときに投げる', async () => {
    const dir = await tempDir('aas-ideas-lex-');
    for (const name of ['lexicon.json', 'templates.json', 'mechanisms.json']) await writeFile(join(dir, name), await readFile(join(DATA_DIR, name)));
    await writeFile(join(dir, 'templates.json'), '{"templates":[]}');
    assert.throws(() => loadLexicon(dir), /文の型が空です/);
  });
});

describe('抽選', () => {
  test('同じ種は同じ列。違う種は違う列', () => {
    const a = rngFrom(42);
    const b = rngFrom(42);
    const c = rngFrom(43);
    const take = (r: ReturnType<typeof rngFrom>): number[] => Array.from({ length: 5 }, () => r.next());
    const first = take(a);
    assert.deepEqual(first, take(b));
    assert.notDeepEqual(first, take(c));
    assert.ok(first.every((x) => x >= 0 && x < 1));
  });

  test('重み 0 の語は引かれない。重みの大きい語は多く引かれる', () => {
    const r = rngFrom(1);
    const got = Array.from({ length: 300 }, () => r.weighted(['a', 'b', 'c'], [0, 1, 9]));
    assert.equal(got.filter((x) => x === 'a').length, 0);
    assert.ok(got.filter((x) => x === 'c').length > got.filter((x) => x === 'b').length * 3);
  });

  test('同じ種・同じ材料・同じ重みなら、同じ種（札の元）が出る。文に、埋まっていない {…} は残らない', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const a = combine({ seed, materials: AUTO });
      assert.deepEqual(a, combine({ seed, materials: AUTO }));
      const text = render(a);
      assert.doesNotMatch(text, /[{}]/, `${a.templateId}: ${text}`);
      assert.ok(AUTO.some((m) => text.includes(m)), `材料が入っていない: ${text}`);
    }
  });

  test('材料が無いときは、材料を使わない型だけで出る', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const s = combine({ seed });
      assert.equal(s.slots.material, undefined);
      assert.doesNotMatch(render(s), /[{}]/);
    }
  });

  test('形の合わない語を混ぜない（側面は名詞句、問いの側面は疑問節、「{側面}を{操作}」の操作は動詞）', () => {
    const lex = defaultLexicon();
    const kindOf = (pool: string, term: string): string | undefined => lex.pools[pool]!.find((t) => t.term === term)?.kind;
    for (let seed = 1; seed <= 400; seed += 1) {
      const s = combine({ seed, materials: AUTO });
      if (s.slots.aspect) assert.equal(kindOf('aspects', s.slots.aspect), 'noun', render(s));
      if (s.slots.aspect_q) assert.equal(kindOf('aspects', s.slots.aspect_q), 'clause', render(s));
      if (s.slots.operation_v) assert.equal(kindOf('operations', s.slots.operation_v), 'verb', render(s));
    }
  });

  test('材料と同じ語を、概念として引かない（「通知と通知は…」を出さない）', () => {
    // 「待ち時間」は概念にも側面にも在る語
    for (let seed = 1; seed <= 300; seed += 1) {
      const s = combine({ seed, materials: ['待ち時間'] });
      const others = Object.entries(s.slots).filter(([k]) => k !== 'material' && !k.startsWith('mechanism_')).map(([, v]) => v);
      assert.ok(!others.includes('待ち時間'), render(s));
    }
  });

  test('遠さは、分野の重なりが少ないほど大きい', () => {
    assert.equal(distance({ domains: ['a', 'b'] }, { domains: ['a', 'b'] }), 0);
    assert.equal(distance({ domains: ['a'] }, { domains: ['b'] }), 1);
    assert.equal(distance({ domains: [] }, { domains: [] }), 0.5);
  });

  test('署名は、型と思いつきの語で決まる。試し方と語の順は入らない', () => {
    const a = { templateId: 't', terms: [['materials', '通知'], ['aspects', '頻度'], ['probes', 'まず A']] as Array<[string, string]> };
    const b = { templateId: 't', terms: [['aspects', '頻度'], ['materials', '通知'], ['probes', 'まず B']] as Array<[string, string]> };
    assert.equal(signatureOf(a), signatureOf(b));
    assert.notEqual(signatureOf(a), signatureOf({ ...a, templateId: 'u' }));
  });

  test('型を名指しすると、その型で出る。埋められない型（材料が無いのに材料の型）は、名指しを外す', () => {
    assert.equal(combine({ seed: 5, materials: AUTO, templateId: 'mechanism_transfer' }).templateId, 'mechanism_transfer');
    assert.notEqual(combine({ seed: 5, templateId: 'mechanism_transfer' }).templateId, 'mechanism_transfer');
  });
});

describe('札を出す', () => {
  test('種を固定すると同じ札が出る（別の蔵でも、同じ蔵で 2 回でも）。種を変えると違う札が出る', async () => {
    const a = await fresh();
    const b = await fresh();
    const first = originals(await a.ideas.receive({ seed: 7, auto: AUTO }));
    assert.deepEqual(first, originals(await b.ideas.receive({ seed: 7, auto: AUTO })));
    assert.deepEqual(first, originals(await a.ideas.receive({ seed: 7, auto: AUTO })), '前に出した札を見て、引き直している');
    assert.notDeepEqual(first, originals(await a.ideas.receive({ seed: 8, auto: AUTO })));
    assert.equal(first.length, 4);
  });

  test('枚数は 3〜5 枚に収める。同じ型は並べない。材料が在れば、仕組みの札を 1 枚は入れる', async () => {
    const { ideas } = await fresh();
    assert.equal((await ideas.receive({ seed: 1, auto: AUTO, count: 1 })).length, MIN_COUNT);
    assert.equal((await ideas.receive({ seed: 1, auto: AUTO, count: 99 })).length, MAX_COUNT);
    for (let seed = 1; seed <= 40; seed += 1) {
      const cards = await ideas.receive({ seed, auto: AUTO });
      assert.equal(new Set(cards.map((c) => c.templateId)).size, cards.length, `同じ型が並んだ（種 ${seed}）`);
      assert.ok(cards.some((c) => c.templateId === 'mechanism_transfer'), `仕組みの札が無い（種 ${seed}）`);
      assert.ok(cards.every((c) => c.material && AUTO.includes(c.material)), `材料の無い札が混ざった（種 ${seed}）`);
    }
  });

  test('テーマの語が 1 つも無くても、札は出る（概念だけの型）', async () => {
    const { ideas } = await fresh();
    const cards = await ideas.receive({ seed: 3 });
    assert.equal(cards.length, 4);
    assert.ok(cards.every((c) => c.original.length > 8 && !/[{}]/.test(c.original) && c.material === undefined));
  });

  test('種を渡さないと、前に出した札と同じ組み合わせは出さない', async () => {
    const { ideas } = await fresh();
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      for (const c of await ideas.receive({ auto: AUTO })) {
        assert.ok(!seen.has(c.original), `同じ札がもう一度出た: ${c.original}`);
        seen.add(c.original);
      }
    }
  });

  test('ネットワークを呼ばない（fetch を、呼ぶと投げるものに替えても札が出る）', async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => { called += 1; throw new Error('ネットワークを呼んだ'); }) as typeof fetch;
    try {
      const { ideas } = await fresh();
      const cards = await ideas.receive({ seed: 2, auto: AUTO });
      await ideas.followChain(cards[0]!.id, { seed: 1, auto: AUTO });
      await ideas.combineTwo(cards[0]!.id, cards[1]!.id, { seed: 1 });
      await ideas.rate(cards[0]!.id, 1);
      assert.equal(cards.length, 4);
    } finally { globalThis.fetch = real; }
    assert.equal(called, 0);
  });

  test('拡張機能のコードは、ネットワークとプロセスの口を読み込まない', async () => {
    const dir = join(import.meta.dirname, '..', 'src', 'extensions');
    const files = [...(await readdir(dir)).map((f) => join(dir, f)), ...(await readdir(join(dir, 'ideas'))).map((f) => join(dir, 'ideas', f))].filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 7);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      assert.doesNotMatch(text, /node:(http|https|net|tls|dgram|child_process)|fetch\(|WebSocket|import\(/, file);
    }
  });
});

describe('テーマの語', () => {
  test('語を足すと、その語が先頭に並び、出し直した札の半分（切り上げ）以上に入る', async () => {
    const { ideas } = await fresh();
    assert.equal(await ideas.registerTheme(' 棚卸し '), '棚卸し');
    const list = await ideas.listThemes(AUTO);
    assert.deepEqual(list.themes.map((t) => `${t.term}:${t.from}`), ['棚卸し:added', '通知:auto', '会議:auto', '予約:auto']);
    for (let seed = 1; seed <= 20; seed += 1) {
      const cards = await ideas.receive({ seed, auto: AUTO, focus: '棚卸し' });
      assert.ok(cards.filter((c) => c.original.includes('棚卸し')).length >= 2, `種 ${seed}: ${originals(cards).join(' ｜ ')}`);
    }
  });

  test('語を外すと、その語の札は出なくなる（自動で採った語も、足した語も）。戻すと、また出る', async () => {
    const { ideas } = await fresh();
    await ideas.registerTheme('棚卸し');
    await ideas.removeTheme('棚卸し');
    await ideas.removeTheme('通知');
    const list = await ideas.listThemes(AUTO);
    assert.deepEqual(list.themes.map((t) => t.term), ['会議', '予約']);
    assert.deepEqual(list.removed, ['棚卸し', '通知']);
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const c of await ideas.receive({ seed, auto: AUTO, focus: '棚卸し' })) {
        assert.ok(c.material === '会議' || c.material === '予約', `外した語が出た（種 ${seed}）: ${c.original}`);
      }
    }
    await ideas.restoreTheme('棚卸し');
    assert.deepEqual((await ideas.listThemes(AUTO)).themes.map((t) => t.term), ['棚卸し', '会議', '予約']);
    assert.deepEqual((await ideas.listThemes(AUTO)).removed, ['通知']);
    assert.ok((await ideas.receive({ seed: 1, auto: AUTO, focus: '棚卸し' })).some((c) => c.material === '棚卸し'));
    // 外してあった語を足し直すと、外したのが取り消される
    await ideas.registerTheme('通知');
    assert.deepEqual((await ideas.listThemes(AUTO)).removed, []);
  });

  test('文・1 文字・長すぎるもの・記号だけは、語として受けない', async () => {
    const { ideas } = await fresh();
    for (const bad of ['', 'あ', '予約の締切をどうするか決めきれていない', '通知 設定', '！！！', 'a'.repeat(25), '通知、会議']) {
      assert.equal(cleanMaterial(bad), undefined, bad);
      await assert.rejects(ideas.registerTheme(bad), IdeasError, bad);
    }
    assert.equal(cleanMaterial('authentication'), 'authentication');
    assert.equal(cleanMaterial('ＡＰＩ設計'), 'API設計');
    assert.deepEqual((await ideas.listThemes()).themes, []);
  });

  test('自動で採る語は、直近の依頼に多く出てくる語が先。どの頼みにも出る語は採らない。同じ入力なら同じ並び', () => {
    const input = { workRoot: '/home/u/yoyaku-app', recentRequests: ['通知の設定を直して', '会議の通知を実装して。エラーも見て', 'README を確認'] };
    const got = autoThemes(input);
    assert.deepEqual(got, autoThemes(input));
    assert.equal(got[0], '通知');
    assert.ok(got.includes('会議') && got.includes('yoyaku') && got.includes('README'));
    for (const common of ['実装', '確認', 'エラー', 'app']) assert.ok(!got.includes(common), common);
    assert.ok(autoThemes({ recentRequests: [Array.from({ length: 40 }, (_, i) => `語彙${String.fromCharCode(0x30a2 + i)}テスト`).join(' ')] }).length <= MAX_AUTO_THEMES);
    assert.deepEqual(wordsIn('ひらがなだけ の ぶん'), []);
    assert.deepEqual(autoThemes({ workRoot: '/home/u/予約' }), ['予約']);
  });
});

describe('残す（星）と語の重み', () => {
  test('残すと、札の語（試し方を除く）の重みが 1 から 1.25 に上がる。やめると 1 に戻る', async () => {
    const { ideas } = await fresh();
    const cards = await ideas.receive({ seed: 7, auto: AUTO });
    const card = cards.find((c) => c.why.parts.some((p) => p.label === '試し方'))!;
    const on = await ideas.rate(card.id, 1);
    assert.equal(on.card.starred, true);
    assert.ok(on.weights.length >= 2);
    assert.ok(on.weights.every((w) => w.weight === STAR_FACTOR), JSON.stringify(on.weights));
    assert.ok(!on.weights.some((w) => w.pool === 'probes'), '試し方（言い方）の重みを動かした');
    // 2 度押しても、2 度は上げない
    assert.deepEqual((await ideas.rate(card.id, 1)).weights, on.weights);
    assert.deepEqual((await ideas.browse()).map((c) => c.id), [card.id]);
    const off = await ideas.rate(card.id, 0);
    assert.equal(off.card.starred, false);
    assert.ok(off.weights.every((w) => w.weight === 1), JSON.stringify(off.weights));
    assert.deepEqual(await ideas.browse(), []);
  });

  test('重みの上がった語は、次から多く引かれる', async () => {
    const count = async (ideas: IdeaService): Promise<number> => {
      let n = 0;
      for (let seed = 100; seed < 160; seed += 1) n += (await ideas.receive({ seed, auto: AUTO })).filter((c) => c.material === '会議').length;
      return n;
    };
    const plain = await fresh();
    const before = await count(plain.ideas);
    const liked = await fresh();
    // 「会議」の札を、種を変えて 6 枚残す（重みは 1.25 の 6 乗で約 3.8）
    let kept = 0;
    for (let seed = 1; kept < 6 && seed < 200; seed += 1) {
      for (const c of await liked.ideas.receive({ seed, auto: AUTO })) {
        if (kept < 6 && c.material === '会議') { await liked.ideas.rate(c.id, 1); kept += 1; }
      }
    }
    assert.equal(kept, 6);
    const after = await count(liked.ideas);
    assert.ok(after > before * 1.3, `残す前 ${before} 枚、残したあと ${after} 枚`);
  });

  test('蔵を開き直しても、残した札と語の重みと、足した語・外した語が残っている', async () => {
    const { dir, ideas } = await fresh();
    await ideas.registerTheme('棚卸し');
    await ideas.removeTheme('予約');
    const cards = await ideas.receive({ seed: 7, auto: AUTO });
    const kept = (await ideas.rate(cards[0]!.id, 1));
    const again = new IdeaService(dir);
    assert.deepEqual(originals(await again.browse()), [cards[0]!.original]);
    assert.equal((await again.browse())[0]!.starred, true);
    assert.deepEqual((await again.rate(cards[0]!.id, 1)).weights, kept.weights);
    assert.deepEqual((await again.listThemes(AUTO)).themes.map((t) => t.term), ['棚卸し', '通知', '会議']);
    const status = await again.status();
    assert.equal(status.saved, 1);
    assert.equal(status.grown, kept.weights.length);
    // 残した札は、出した札の一覧から落ちても（古くなっても）辿れる
    const file = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { saved: unknown[]; weights: Record<string, Record<string, number>> };
    assert.equal(file.saved.length, 1);
    assert.ok(Object.values(file.weights).flatMap((t) => Object.values(t)).includes(STAR_FACTOR));
  });

  test('重みは上限（5）で止まる', async () => {
    const { dir, ideas } = await fresh();
    for (let seed = 1; seed <= 60; seed += 1) {
      for (const c of await ideas.receive({ seed, auto: ['通知'] })) await ideas.rate(c.id, 1);
    }
    const file = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { weights: Record<string, Record<string, number>> };
    assert.equal(file.weights.materials!['通知'], MAX_WEIGHT);
  });
});

describe('もっと・組み合わせる・なぜ', () => {
  test('「もっと」は、元の札の主題（材料・概念・側面）を 1 つは引き継いだ、別の型の札を出す。元の札を親として覚える', async () => {
    const { ideas } = await fresh();
    for (let seed = 1; seed <= 25; seed += 1) {
      const [parent] = await ideas.receive({ seed, auto: AUTO });
      const child = await ideas.followChain(parent!.id, { seed, auto: AUTO });
      assert.deepEqual(child.parents, [parent!.id]);
      assert.notEqual(child.original, parent!.original);
      assert.notEqual(child.templateId, parent!.templateId);
      const subject = (c: typeof child): string[] => c.why.parts.filter((p) => ['材料', '概念', '側面'].includes(p.label)).map((p) => p.term);
      assert.ok(subject(child).some((t) => subject(parent!).includes(t)), `主題を引き継いでいない: ${parent!.original} → ${child.original}`);
    }
  });

  test('「もっと」を同じ札に何度押しても、同じ札は出ない。同じ種なら同じ札', async () => {
    const { ideas } = await fresh();
    const [parent] = await ideas.receive({ seed: 3, auto: AUTO });
    const seen = new Set([parent!.original]);
    for (let i = 0; i < 6; i += 1) {
      const child = await ideas.followChain(parent!.id, { auto: AUTO });
      assert.ok(!seen.has(child.original), child.original);
      seen.add(child.original);
    }
    const other = await fresh();
    const [same] = await other.ideas.receive({ seed: 3, auto: AUTO });
    assert.equal((await other.ideas.followChain(same!.id, { seed: 11, auto: AUTO })).original, (await (await fresh().then(async (f) => {
      const [p] = await f.ideas.receive({ seed: 3, auto: AUTO });
      return f.ideas.followChain(p!.id, { seed: 11, auto: AUTO });
    })).original));
  });

  test('外した語は、「もっと」で引き継がない', async () => {
    const { ideas } = await fresh();
    const cards = await ideas.receive({ seed: 4, auto: AUTO });
    const parent = cards[0]!;
    await ideas.removeTheme(parent.material!);
    for (let seed = 1; seed <= 15; seed += 1) {
      const child = await ideas.followChain(parent.id, { seed, auto: AUTO });
      assert.notEqual(child.material, parent.material, child.original);
    }
  });

  test('「組み合わせる」は、1 枚目の主題に 2 枚目の主題をぶつけた札を出す。2 枚を親として覚える', async () => {
    const { ideas } = await fresh();
    let crossed = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const cards = await ideas.receive({ seed, auto: AUTO });
      const [a, b] = cards;
      const made = await ideas.combineTwo(a!.id, b!.id, { seed });
      assert.deepEqual(made.parents, [a!.id, b!.id]);
      assert.equal(made.material, a!.material);
      assert.notEqual(made.original, a!.original);
      assert.notEqual(made.original, b!.original);
      assert.doesNotMatch(made.original, /[{}]/);
      // 2 枚目の主題（材料・仕組みの主・概念）のどれかが、1 枚目の材料と違えば、出た札に入っている
      const partner = b!.why.parts.filter((p) => ['材料', '仕組み', '概念'].includes(p.label)).map((p) => p.term).find((t) => t !== a!.material);
      if (partner) { assert.ok(made.original.includes(partner), `${partner} が入っていない: ${made.original}`); crossed += 1; }
    }
    assert.ok(crossed >= 10, `2 枚目の主題をぶつけた回が少ない: ${crossed}`);
  });

  test('同じ札 2 枚・覚えていない札は、理由を言って断る', async () => {
    const { ideas } = await fresh();
    const [a] = await ideas.receive({ seed: 1, auto: AUTO });
    await assert.rejects(ideas.combineTwo(a!.id, a!.id), /違う札を 2 枚/);
    await assert.rejects(ideas.combineTwo(a!.id, 'c999'), /覚えていません/);
    await assert.rejects(ideas.followChain('c999'), /覚えていません/);
    await assert.rejects(ideas.rate('c999', 1), /覚えていません/);
  });

  test('「なぜ」: 仕組みの札は、札の文に入っている元の文と、その出典とライセンス。ほかの札は、掛け合わせた語（と、同じ側面の仕組みが在ればそれ）', async () => {
    const { ideas } = await fresh();
    let near = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const c of await ideas.receive({ seed, auto: AUTO })) {
        assert.ok(c.why.parts.length >= 2 && c.why.parts.some((p) => p.label === '材料' && p.term === c.material), c.original);
        const m = c.why.mechanism;
        if (c.templateId === 'mechanism_transfer') {
          assert.ok(m && m.direct, c.original);
          assert.ok(c.original.includes(m.how) && c.original.includes(m.subject), c.original);
          assert.match(m.source, /^https:\/\/ja\.wikipedia\.org\/wiki\//);
          assert.equal(m.license, 'CC BY-SA 4.0');
        } else if (m) {
          assert.equal(m.direct, false);
          assert.equal(m.aspect, c.why.parts.find((p) => p.label === '側面')?.term);
          assert.match(m.source, /^https:\/\/ja\.wikipedia\.org\/wiki\//);
          near += 1;
        }
      }
    }
    assert.ok(near > 0, '同じ側面の仕組みを添えた札が 1 枚も無い');
  });
});

describe('蔵', () => {
  test('出した札は 200 枚まで（古いものから落とす）。残した札は落とさない', async () => {
    const { dir, ideas } = await fresh();
    const first = await ideas.receive({ seed: 1, auto: AUTO });
    await ideas.rate(first[0]!.id, 1);
    for (let seed = 2; seed <= 62; seed += 1) await ideas.receive({ seed, auto: AUTO });
    const file = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { recent: Array<{ id: string }>; saved: Array<{ id: string }> };
    assert.equal(file.recent.length, MAX_RECENT);
    assert.ok(!file.recent.some((c) => c.id === first[0]!.id));
    assert.deepEqual(file.saved.map((c) => c.id), [first[0]!.id]);
    // 落ちた札は「もっと」で辿れないが、残した札は辿れる
    await assert.rejects(ideas.followChain(first[1]!.id), /覚えていません/);
    assert.equal((await ideas.followChain(first[0]!.id, { auto: AUTO })).parents[0], first[0]!.id);
  });

  test('残した札が上限（500 枚）なら、足すのを断る（黙って古いものを落とさない）', async () => {
    const dir = await tempDir('aas-ideas-full-');
    const card = (i: number): Record<string, unknown> => ({ id: `c${i}`, text: `札 ${i}`, templateId: 'swap_aspect', tone: 'proposal', slots: {}, terms: [], seed: i, novelty: 0.5, parents: [], createdAt: 0, starred: true });
    await writeFile(join(dir, 'store.json'), JSON.stringify({ version: 1, saved: Array.from({ length: MAX_SAVED }, (_, i) => card(i + 1)) }));
    const ideas = new IdeaService(dir);
    assert.equal((await ideas.browse()).length, MAX_SAVED);
    const [next] = await ideas.receive({ seed: 1, auto: AUTO });
    assert.equal(next!.id, `c${MAX_SAVED + 1}`, '番号が、在る札と重なった');
    await assert.rejects(ideas.rate(next!.id, 1), /500 枚までです/);
    assert.equal((await ideas.browse()).length, MAX_SAVED);
  });

  test('壊れた蔵は、脇へ移して空で始める（札は出る）。知らない形の中身は落として読む', async () => {
    const dir = await tempDir('aas-ideas-broken-');
    await writeFile(join(dir, 'store.json'), '{ こわれた');
    const ideas = new IdeaService(dir);
    assert.equal((await ideas.receive({ seed: 1, auto: AUTO })).length, 4);
    assert.ok((await readdir(dir)).some((f) => f.startsWith('store.json.broken-')), (await readdir(dir)).join(','));
    const state = stateFrom({ weights: { materials: { 通知: 99, 会議: 'x' } }, themes: { added: ['a', 1], removed: 'x' }, recent: [{ id: 1 }, null], polish: 'no', nextId: -4 });
    assert.deepEqual(state.weights, { materials: { 通知: MAX_WEIGHT } });
    assert.deepEqual(state.themes, { added: ['a'], removed: [] });
    assert.deepEqual(state.recent, []);
    assert.equal(state.nextId, 1);
  });

  test('フォルダが無くても、最初に書くときに作る', async () => {
    const dir = join(await tempDir('aas-ideas-deep-'), 'extensions', 'ideas');
    const store = new IdeaStore(dir);
    await store.state();
    assert.equal(existsSync(dir), false, '読むだけで、フォルダを作った');
    assert.equal(await store.save(), true);
    assert.equal(existsSync(join(dir, 'store.json')), true);
    await mkdir(dir, { recursive: true });
  });
});

describe('磨き（手元のモデルの返事を読む）', () => {
  const cards = [
    { id: 'c1', text: '通知の頻度を逆にする。まず15分だけ試して捨てる。', material: '通知' },
    { id: 'c2', text: '会議の順番は、なぜ今の形なのか。', material: '会議' },
  ];

  test('頼む文は、番号の付いた札の文。決まりは、番号ごとに 1 行と BEST の行を、例で見せて求める', () => {
    assert.equal(polishPrompt(cards), '1: 通知の頻度を逆にする。まず15分だけ試して捨てる。\n2: 会議の順番は、なぜ今の形なのか。');
    assert.match(POLISH_SYSTEM, /^1: …\n2: …\nBEST: 2$/m, '返す形の例が無い');
  });

  test('決めた形の行だけを受ける。おすすめは BEST の番号', () => {
    const got = parsePolish('<think>考えごと\n1: これは読まない</think>\n1: 通知の頻度を、あえて逆にしてみる。まず15分だけ試す。\n2：会議の順番は、なぜ今の形になっているのか。\nBEST: 2\n', cards);
    assert.deepEqual(got, { texts: { c1: '通知の頻度を、あえて逆にしてみる。まず15分だけ試す。', c2: '会議の順番は、なぜ今の形になっているのか。' }, best: 'c2' });
  });

  test('材料の語が消えた行・長すぎる行・短すぎる行・記号の混ざった行・番号の無い行・元と同じ行（空白だけ違う行も）は捨てる（その札は元の文のまま）', () => {
    const out = [
      '1: 頻度を逆にしてみる。まず15分だけ試して捨てる。',
      `2: 会議の順番は、${'とても'.repeat(30)}長い。`,
      'はい、整えました。',
      '3: 番号が無い札',
      'BEST: 9',
    ].join('\n');
    assert.deepEqual(parsePolish(out, cards), { texts: {} });
    assert.deepEqual(parsePolish('1: 通知\n2: - 会議の順番は、なぜ今の形なのか。箇条書き', cards), { texts: {} });
    assert.deepEqual(parsePolish(`1: ${cards[0]!.text}`, cards), { texts: {} });
    assert.deepEqual(parsePolish('1: 通知 の 頻度を逆にする。まず 15 分だけ試して捨てる。\nBEST: 1', cards), { texts: {}, best: 'c1' }, '空白を足しただけの文を、磨いた文として受けた');
    assert.deepEqual(parsePolish('', cards), { texts: {} });
  });

  test('磨いた文は札に付き、元の文は残る。外すと元の文に戻る', async () => {
    const { dir, ideas } = await fresh();
    const [card] = await ideas.receive({ seed: 1, auto: AUTO });
    await ideas.setPolished({ [card!.id]: '磨いた文' });
    const [got] = await new IdeaService(dir).cards([card!.id]);
    assert.deepEqual([got!.text, got!.original, got!.polished], ['磨いた文', card!.original, true]);
    await ideas.setPolished({ [card!.id]: '' });
    const [back] = await ideas.cards([card!.id]);
    assert.deepEqual([back!.text, back!.polished], [card!.original, false]);
    assert.equal(await ideas.polishEnabled(), true);
    assert.equal(await ideas.setPolishEnabled(false), false);
    assert.equal(await new IdeaService(dir).polishEnabled(), false);
  });
});

describe('思いつきを置く・育てる・筋', () => {
  test('思いつきを 1 行で置くと、その思いつきの語を材料に広げた札が返り、思いつきが筋の頭として残る', async () => {
    const { ideas } = await fresh();
    const { thread, cards } = await ideas.plant('  通知が多すぎて、  会議の連絡が読まれない ', { seed: 5, auto: AUTO });
    assert.equal(thread.thought, '通知が多すぎて、 会議の連絡が読まれない');
    assert.deepEqual(thread.words, ['通知', '会議', '連絡']);
    assert.deepEqual(thread.steps, []);
    assert.equal(cards.length, 4);
    assert.ok(cards.every((c) => c.material && thread.words.includes(c.material)), originals(cards).join(' ｜ '));
    assert.equal(new Set(cards.map((c) => c.templateId)).size, 4);
    assert.equal(thread.asText, '思いつき: 通知が多すぎて、 会議の連絡が読まれない');
    // 同じ種なら、別の蔵でも同じ札
    const other = await fresh();
    assert.deepEqual(originals((await other.ideas.plant('通知が多すぎて、会議の連絡が読まれない', { seed: 5, auto: AUTO })).cards), originals(cards));
  });

  test('1 語の思いつきは、その語が材料になる。語を採れない思いつきは、今のテーマの語で広げる。空は断る', async () => {
    const { ideas } = await fresh();
    const one = await ideas.plant('棚卸し', { seed: 1 });
    assert.deepEqual(one.thread.words, ['棚卸し']);
    assert.ok(one.cards.every((c) => c.material === '棚卸し'));
    const kana = await ideas.plant('もっとはやくしたい', { seed: 1, auto: AUTO });
    assert.deepEqual(kana.thread.words, []);
    assert.ok(kana.cards.every((c) => c.material && AUTO.includes(c.material)));
    await assert.rejects(ideas.plant('   '), /思いつきを 1 行で/);
    assert.equal((await ideas.plant('あ'.repeat(500), { seed: 1 })).thread.thought.length, 200);
  });

  test('札を育てると、その札が筋に足され、その札の主題を引き継いだ次の札が 3 枚返る。育てた順に 1 本の筋として残る', async () => {
    const { ideas } = await fresh();
    const planted = await ideas.plant('通知が多すぎて読まれない', { seed: 2 });
    const first = planted.cards[1]!;
    const grown = await ideas.grow(planted.thread.id, first.id, { seed: 3 });
    assert.deepEqual(grown.thread.steps.map((c) => c.id), [first.id]);
    assert.equal(grown.cards.length, 3);
    const subject = (c: typeof first): string[] => c.why.parts.filter((p) => ['材料', '概念', '側面'].includes(p.label)).map((p) => p.term);
    for (const c of grown.cards) {
      assert.deepEqual(c.parents, [first.id]);
      assert.notEqual(c.templateId, first.templateId);
      assert.ok(subject(c).some((t) => subject(first).includes(t)), `主題を引き継いでいない: ${first.original} → ${c.original}`);
    }
    const second = grown.cards[0]!;
    const again = await ideas.grow(planted.thread.id, second.id, { seed: 4 });
    assert.deepEqual(again.thread.steps.map((c) => c.id), [first.id, second.id]);
    assert.equal(again.thread.asText, `思いつき: 通知が多すぎて読まれない\n1. ${first.text}\n2. ${second.text}`);
    // 同じ札を続けて 2 度育てても、筋には 1 度しか足さない
    assert.equal((await ideas.grow(planted.thread.id, second.id, { seed: 5 })).thread.steps.length, 2);
    assert.ok(again.cards.every((c) => !again.thread.steps.some((s) => s.original === c.original)), '筋に在る札を、次の札として出した');
  });

  test('筋は、蔵を開き直しても残っていて、開き直すと続きの札が出る。新しく触った筋が先に並ぶ', async () => {
    const { dir, ideas } = await fresh();
    const a = await ideas.plant('通知が多い', { seed: 1 });
    const b = await ideas.plant('会議が長い', { seed: 1 });
    await ideas.grow(a.thread.id, a.cards[0]!.id, { seed: 1 });
    let clock = 1_700_000_100_000;
    const again = new IdeaService(dir, { now: () => (clock += 1000) });
    const list = await again.threads();
    assert.deepEqual(list.map((t) => [t.thought, t.steps.length]), [['通知が多い', 1], ['会議が長い', 0]]);
    assert.equal(list[0]!.steps[0]!.original, a.cards[0]!.original);
    // 札を渡さずに開き直すと、筋は変えずに、最後の札（無ければ思いつき）を種にした札だけが返る
    const reopened = await again.grow(a.thread.id, undefined, { seed: 9 });
    assert.equal(reopened.thread.steps.length, 1);
    assert.deepEqual(reopened.cards.map((c) => c.parents), [[a.cards[0]!.id], [a.cards[0]!.id], [a.cards[0]!.id]]);
    const fromThought = await again.grow(b.thread.id, undefined, { seed: 9 });
    assert.ok(fromThought.cards.every((c) => c.material === '会議' && c.parents.length === 0));
    // 育てると、その筋が先に来る
    await again.grow(b.thread.id, fromThought.cards[0]!.id, { seed: 1 });
    assert.deepEqual((await again.threads()).map((t) => t.thought), ['会議が長い', '通知が多い']);
    assert.equal((await again.status()).threads, 2);
  });

  test('出した札の一覧から落ちた札も、筋に在れば残る。筋は 100 本まで（古いものから落とす）。覚えていない筋・札は断る', async () => {
    const { dir, ideas } = await fresh();
    const kept = await ideas.plant('通知が多い', { seed: 1 });
    await ideas.grow(kept.thread.id, kept.cards[0]!.id, { seed: 1 });
    for (let i = 0; i < 100; i += 1) await ideas.plant(`思いつき${i}番`, { seed: i });
    const file = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { threads: Array<{ id: string }>; recent: Array<{ id: string }> };
    assert.equal(file.threads.length, 100);
    assert.ok(!file.threads.some((t) => t.id === kept.thread.id), 'いちばん古い筋が残っている');
    await assert.rejects(ideas.grow(kept.thread.id, undefined), /その筋は、もう覚えていません/);
    const last = (await ideas.threads())[0]!;
    await assert.rejects(ideas.grow(last.id, 'c999999'), /その札は、もう覚えていません/);
    // 筋に足した札は、出した札の一覧（200 枚）から落ちたあとも、筋から辿れる
    const t = await ideas.plant('会議が長い', { seed: 1 });
    const step = (await ideas.grow(t.thread.id, t.cards[0]!.id, { seed: 1 })).thread.steps[0]!;
    for (let seed = 1; seed <= 60; seed += 1) await ideas.receive({ seed, auto: AUTO });
    const after = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { recent: Array<{ id: string }> };
    assert.ok(!after.recent.some((c) => c.id === step.id), '前提: 出した札の一覧から落ちている');
    assert.equal((await ideas.followChain(step.id, { seed: 1 })).parents[0], step.id);
  });
});
