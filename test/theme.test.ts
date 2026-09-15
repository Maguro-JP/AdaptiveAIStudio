import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairTheme, baseTheme, isSafeValue, cssVarName, toCssVars,
  THEMES, TOKENS, DEFAULT_THEME_ID, EFFECTS,
} from '../src/ui/theme.ts';

describe('用意された見た目', () => {
  test('どれも、そのまま読める形になっている', () => {
    for (const t of THEMES) {
      const { theme, repairs } = repairTheme(t);
      assert.deepEqual(repairs, [], `${t.id} を直す必要があった`);
      assert.equal(theme.id, t.id);
    }
  });

  test('どれも、必要な項目が全部埋まっている', () => {
    for (const t of THEMES) {
      for (const token of TOKENS) {
        assert.ok(t.tokens[token], `${t.id} に ${token} が無い`);
      }
    }
  });

  test('明暗が宣言されている（入力欄や巻物の色に効く）', () => {
    for (const t of THEMES) assert.ok(t.scheme === 'dark' || t.scheme === 'light', t.id);
  });

  test('知らない名前を頼まれたら既定に落ちる', () => {
    assert.equal(baseTheme('そんな色は無い').id, DEFAULT_THEME_ID);
  });

  test('取り出したものは独立している', () => {
    const a = baseTheme('slate');
    a.tokens.bg = '#000000';
    assert.notEqual(baseTheme('slate').tokens.bg, '#000000');
  });
});

describe('値の検め', () => {
  test('色として読めるものは通す', () => {
    for (const v of ['#fff', '#0f1116', 'rgb(1,2,3)', 'rgba(1,2,3,.5)', 'hsl(200 50% 40%)',
      'oklch(0.7 0.1 250)', 'transparent', 'color-mix(in oklab, #fff 20%, #000)']) {
      assert.ok(isSafeValue(v), `弾いてしまった: ${v}`);
    }
  });

  test('長さや書体も通す', () => {
    for (const v of ['10px', '1.55', 'calc(var(--radius) - 3px)',
      "ui-monospace, Menlo, monospace", '0 1px 2px rgba(0,0,0,.35)']) {
      assert.ok(isSafeValue(v), `弾いてしまった: ${v}`);
    }
  });

  test('CSS を抜け出す書き方は通さない', () => {
    for (const v of [
      'red; } body { display: none } .x { color: blue',
      'url(http://example.com/x.png)',
      '#fff}',
      'expression(alert(1))',
      'javascript:alert(1)',
      '@import "evil.css"',
      '<script>',
    ]) {
      assert.equal(isSafeValue(v), false, `通してしまった: ${v}`);
    }
  });

  test('空や長すぎるものは通さない', () => {
    assert.equal(isSafeValue(''), false);
    assert.equal(isSafeValue('#' + 'a'.repeat(300)), false);
  });

  test('知らない関数は通さない', () => {
    assert.equal(isSafeValue('attr(href)'), false);
    assert.equal(isSafeValue('image-set(x)'), false);
  });
});

describe('壊れた見た目でも画面を出す', () => {
  const ok = (raw: unknown) => {
    const { theme } = repairTheme(raw);
    for (const token of TOKENS) assert.ok(theme.tokens[token], `${token} が空`);
    return theme;
  };

  test('null でも出る', () => { ok(null); });
  test('文字列でも出る', () => { ok('赤くして'); });
  test('空の入れ物でも出る', () => { ok({}); });
  test('配列でも出る', () => { ok([1, 2]); });
});

describe('見た目の直し方', () => {
  test('土台の上に、変えたところだけ乗る', () => {
    const { theme } = repairTheme({ base: 'slate', tokens: { accent: '#ff8800' } });
    assert.equal(theme.tokens.accent, '#ff8800');
    assert.equal(theme.tokens.bg, baseTheme('slate').tokens.bg);
  });

  test('知らない項目は無視して、そう言う', () => {
    const { theme, repairs } = repairTheme({ base: 'slate', tokens: { nope: '#fff' } });
    assert.equal((theme.tokens as Record<string, string>).nope, undefined);
    assert.ok(repairs.some((r) => r.detail.includes('nope')));
  });

  test('危ない値は捨てて、なぜ効かないかを言う', () => {
    const { theme, repairs } = repairTheme({
      base: 'slate', tokens: { accent: 'red; } body { display: none } .x{color:red' },
    });
    assert.equal(theme.tokens.accent, baseTheme('slate').tokens.accent, '危ない値が残った');
    assert.ok(repairs.some((r) => r.detail.includes('accent')));
  });

  test('文字以外で書かれていたら、そのままにする', () => {
    const { theme, repairs } = repairTheme({ base: 'slate', tokens: { accent: 123 } });
    assert.equal(theme.tokens.accent, baseTheme('slate').tokens.accent);
    assert.ok(repairs.some((r) => r.detail.includes('文字')));
  });

  test('知らない土台なら既定を土台にして、そう言う', () => {
    const { theme, repairs } = repairTheme({ base: '虹色', tokens: { accent: '#ff0000' } });
    assert.equal(theme.tokens.bg, baseTheme(DEFAULT_THEME_ID).tokens.bg);
    assert.equal(theme.tokens.accent, '#ff0000');
    assert.ok(repairs.some((r) => r.detail.includes('虹色')));
  });

  test('明暗の指定が変なら土台のものを使う', () => {
    const { theme } = repairTheme({ base: 'paper', scheme: 'まぶしい' });
    assert.equal(theme.scheme, 'light');
  });

  test('直した結果は、もう直す必要が無い', () => {
    const once = repairTheme({
      base: 'cyber', tokens: { accent: 'url(x)', bg: '#010203', nope: 'y' },
    }).theme;
    const twice = repairTheme(once);
    assert.deepEqual(twice.repairs, []);
    assert.deepEqual(twice.theme, once);
  });
});

describe('画面へ流す形', () => {
  test('camelCase は繋ぎ字になる', () => {
    assert.equal(cssVarName('accentText'), '--accent-text');
    assert.equal(cssVarName('bg'), '--bg');
    assert.equal(cssVarName('fontMono'), '--font-mono');
  });

  test('全ての項目が変数になる', () => {
    const vars = toCssVars(baseTheme('slate'));
    for (const token of TOKENS) assert.ok(vars[cssVarName(token)], `${token} が出ていない`);
  });

  test('危ない値は、万一残っていても流さない', () => {
    const theme = baseTheme('slate');
    (theme.tokens as Record<string, string>).accent = 'red; } body{display:none}';
    assert.equal(toCssVars(theme)['--accent'], undefined);
  });
});

describe('効果', () => {
  test('用意した見た目には、性格が付いている', () => {
    // 色だけでは見た目の性格は決まらない。
    const withFx = THEMES.filter((t) => (t.effects ?? []).length > 0);
    assert.ok(withFx.length >= 4, `効果の付いた見た目が少ない: ${withFx.length}`);
  });

  test('使う効果は、すべて用意されているものだけ', () => {
    for (const t of THEMES) {
      for (const fx of t.effects ?? []) {
        assert.ok((EFFECTS as readonly string[]).includes(fx), `${t.id} に知らない効果: ${fx}`);
      }
    }
  });

  test('知らない効果は外す。任意の CSS を流し込ませない', () => {
    // 流し込みを許すと、見た目の設定が画面を書き換える口になる。
    const { theme, repairs } = repairTheme({
      id: 'x', effects: ['glass', 'position:fixed;top:0', 'glow'],
    });
    assert.deepEqual(theme.effects, ['glass', 'glow']);
    assert.ok(repairs.some((r) => r.detail.includes('知らない効果')));
  });

  test('同じ効果を重ねて書いても、一度だけ', () => {
    const { theme } = repairTheme({ id: 'x', effects: ['glow', 'glow', 'glow'] });
    assert.deepEqual(theme.effects, ['glow']);
  });

  test('効果は無くてもよい', () => {
    const { theme } = repairTheme({ id: 'x', effects: [] });
    assert.equal(theme.effects, undefined);
  });

  test('用意した効果には、必ず見た目の指定がある', async () => {
    // 名前だけあって何も起きない効果は、選べるだけ無駄。
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = await readFile(join(here, '..', 'src', 'ui', 'web', 'style.css'), 'utf8');
    for (const fx of EFFECTS) {
      assert.ok(css.includes(`[data-fx~="${fx}"]`), `効果に見た目の指定が無い: ${fx}`);
    }
  });
});

describe('ブラウザが自分で描く部品', () => {
  test('どのテーマも、透けない地を持っている', async () => {
    const { THEMES } = await import('../src/ui/theme.ts');
    for (const t of THEMES) {
      const solid = t.tokens.surfaceSolid;
      assert.ok(solid, `${t.id} に surfaceSolid が無い`);
      // 半透明だと、select の一覧が真っ白になって読めない。
      assert.doesNotMatch(solid!, /rgba?\([^)]*,\s*0?\.\d+\s*\)/,
        `${t.id} の surfaceSolid が透けている: ${solid}`);
    }
  });

  test('一覧の地に、その色を使っている', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = await readFile(join(here, '..', 'src', 'ui', 'web', 'style.css'), 'utf8');
    assert.match(css, /select option[\s\S]*?--surface-solid/, 'option に透けない地を渡していない');
  });
});

describe('読めるかどうかは、好みの前の問題', () => {
  test('文字と地の差が、どのテーマでも足りている', async () => {
    // 一日中見る画面なので、読めることは好みより先に来る。
    // 実際に測ったら4つ足りていなかった（paper の accent と warn、
    // ember の accent、terminal の dim）。目で見て決めない。
    const { THEMES } = await import('../src/ui/theme.ts');
    const core = await import('../src/ui/web/color-core.js') as {
      parse: (v: string) => { r: number; g: number; b: number; a: number } | undefined;
      contrast: (a: unknown, b: unknown) => number;
    };

    const thin: string[] = [];
    for (const t of THEMES) {
      const k = t.tokens;
      // 板の地（透けない色）の上で測る。半透明の上では測れない。
      const bg = core.parse(k.surfaceSolid ?? k.bg ?? '');
      assert.ok(bg, `${t.id} の地を読めない`);
      for (const name of ['text', 'dim', 'accent', 'good', 'warn', 'bad'] as const) {
        const c = core.parse(k[name] ?? '');
        assert.ok(c, `${t.id} の ${name} を読めない`);
        const ratio = core.contrast(c, bg);
        if (ratio < 4.5) thin.push(`${t.id}.${name} = ${ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(thin, [], `読みにくい組み合わせがある:\n  ${thin.join('\n  ')}`);
  });

  test('accent の上に載る文字も、読める', async () => {
    // accent はボタンの地にもなる。その上の文字が読めないと、
    // 「押せるもの」がいちばん読みにくい、という形になる。
    const { THEMES } = await import('../src/ui/theme.ts');
    const core = await import('../src/ui/web/color-core.js') as {
      parse: (v: string) => unknown;
      contrast: (a: unknown, b: unknown) => number;
    };
    const thin: string[] = [];
    for (const t of THEMES) {
      const on = core.parse(t.tokens.accentText ?? '');
      const bg = core.parse(t.tokens.accent ?? '');
      if (!on || !bg) continue;
      const ratio = core.contrast(on, bg);
      if (ratio < 4.5) thin.push(`${t.id} = ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(thin, [], `押せるものの文字が読みにくい:\n  ${thin.join('\n  ')}`);
  });
});

describe('選べるものは、効くようになっている', () => {
  test('効果の名前に、対応する見た目がある', async () => {
    // 名前で選ばせる作りなので、CSS 側が無いと**選べるのに何も起きない**。
    // 落ちないので気づけない。板の見出しが抜けていたのと同じ型。
    const { EFFECTS } = await import('../src/ui/theme.ts');
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = await readFile(join(here, '..', 'src', 'ui', 'web', 'style.css'), 'utf8');

    const missing = EFFECTS.filter((e) => !css.includes(`[data-fx~="${e}"]`));
    assert.deepEqual(missing, [], `選べるのに何も起きない効果がある: ${missing.join(', ')}`);
  });

  test('CSS にあるのに選べない効果を、残さない', async () => {
    // 逆も見る。CSS だけ書いて名前を足し忘れると、誰も使えない。
    const { EFFECTS } = await import('../src/ui/theme.ts');
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = await readFile(join(here, '..', 'src', 'ui', 'web', 'style.css'), 'utf8');

    const used = new Set([...css.matchAll(/\[data-fx~="([a-z]+)"\]/g)].map((m) => m[1]!));
    const orphan = [...used].filter((e) => !(EFFECTS as readonly string[]).includes(e));
    assert.deepEqual(orphan, [], `CSS にあるのに選べない: ${orphan.join(', ')}`);
  });
});
