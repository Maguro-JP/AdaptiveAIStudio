import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasNonAscii, nonAsciiPart, inspectEnvironment, parseCudaVersion,
} from '../src/runtime/environment.ts';

describe('全角・日本語を含むパス', () => {
  test('見つける', () => {
    assert.equal(hasNonAscii('C:\\Users\\ｍ＠ｇｕｒｏ\\.ollama'), true);
    assert.equal(hasNonAscii('C:\\Users\\山田\\models'), true);
    assert.equal(hasNonAscii('C:\\ai\\models'), false);
    assert.equal(hasNonAscii('/home/user/models'), false);
  });

  test('どの文字が悪いのかを指させる', () => {
    assert.equal(nonAsciiPart('C:\\Users\\ｍ＠ｇｕｒｏ\\x'), 'ｍ＠ｇｕｒｏ');
    assert.equal(nonAsciiPart('C:\\ai'), '');
  });

  test('半角の記号は問題にしない', () => {
    assert.equal(hasNonAscii('C:\\Users\\m@guro\\.ollama'), false);
  });
});

describe('環境の見立て', () => {
  const base = {
    stateDir: 'C:\\Users\\test\\.aas',
    root: 'C:\\ai\\work',
    hasGpu: false,
    platform: 'win32' as NodeJS.Platform,
    userProfile: 'C:\\Users\\test',
  };

  test('全角のユーザー名を、止まる原因として挙げる', async () => {
    const issues = await inspectEnvironment({
      ...base, userProfile: 'C:\\Users\\ｍ＠ｇｕｒｏ',
    });
    const found = issues.find((i) => i.title.includes('Ollama'));
    assert.ok(found, '既定の Ollama 置き場を見ていない');
    assert.equal(found!.level, 'bad');
    assert.ok(found!.detail.includes('ｍ＠ｇｕｒｏ'));
    assert.ok(found!.fix.includes('OLLAMA_MODELS'), '次に打つ一手が無い');
    assert.ok(found!.fix.includes('LM Studio'), '同じ原因で困る場所に触れていない');
  });

  test('モデルの置き場も見る', async () => {
    const issues = await inspectEnvironment({
      ...base, modelsDir: 'D:\\モデル置き場',
    });
    assert.ok(issues.some((i) => i.title.includes('モデルの置き場')));
  });

  test('作業ディレクトリは見ない。読むのは Node なので全角でも動く', async () => {
    const issues = await inspectEnvironment({ ...base, root: 'C:\\Users\\ｍ＠ｇｕｒｏ\\work' });
    assert.deepEqual(issues, [], '実機で正常動作している構成を「未了」にしてはいけない');
  });

  test('ASCII だけなら何も言わない', async () => {
    const issues = await inspectEnvironment({ ...base, modelsDir: 'C:\\ai\\models' });
    assert.deepEqual(issues, []);
  });

  test('Windows 以外では、この話をしない', async () => {
    const issues = await inspectEnvironment({
      ...base, platform: 'linux', root: '/home/山田/work', userProfile: '/home/山田',
    });
    assert.deepEqual(issues, []);
  });

  test('GPU が無ければ、ドライバの話もしない', async () => {
    const issues = await inspectEnvironment({ ...base, hasGpu: false });
    assert.equal(issues.some((i) => i.title.includes('ドライバ')), false);
  });

  test('見つけたものには、必ず次の一手が付く', async () => {
    const issues = await inspectEnvironment({
      ...base, root: 'C:\\作業', modelsDir: 'D:\\モデル', userProfile: 'C:\\Users\\ｍ＠ｇｕｒｏ',
    });
    assert.equal(issues.length, 2, 'モデルの置き場と Ollama の置き場だけ');
    for (const i of issues) assert.ok(i.fix.length > 0, `${i.title} に一手が無い`);
  });
});

describe('nvidia-smi の読み取り', () => {
  const header = (line: string) => `Tue Aug 30 12:00:00 2026
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 580.88                 Driver Version: 580.88       ${line} |
+-----------------------------------------------------------------------------+`;

  test('CUDA Version 形式を読む', () => {
    assert.equal(parseCudaVersion(header('CUDA Version: 13.0')), '13.0');
  });

  test('CUDA UMD Version 形式も読む', () => {
    assert.equal(parseCudaVersion(header('CUDA UMD Version: 580.88')), '580.88');
  });

  test('書いていなければ分からないとする', () => {
    assert.equal(parseCudaVersion('Driver Version: 580.88'), undefined);
  });
});
