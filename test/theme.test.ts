import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairTheme, baseTheme, isSafeValue, cssVarName, toCssVars,
  THEMES, TOKENS, DEFAULT_THEME_ID,
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
