/**
 * OneDrive の中に置いてあることを、doctor が言う。
 *
 * 遅い理由がフォルダの場所にあるとき、モデルや機械のせいにしてしまう。
 * 名前で分かることは、名前で言う。実際に遅いかどうかまでは言わない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insideOneDrive, modelsDirNote, programDirNote } from '../src/cli/doctor-paths.ts';

describe('OneDrive の中か', () => {
  test('Windows の道（会社の OneDrive の名前）', () => {
    assert.equal(insideOneDrive('Z:\\maguro\\OneDrive - Business1\\Documents\\AdaptiveAIStudio\\data\\models'), true);
  });
  test('区切りが / でも、大文字小文字が違っても', () => {
    assert.equal(insideOneDrive('/home/x/onedrive/models'), true);
    assert.equal(insideOneDrive('C:/Users/x/OneDrive/Desktop'), true);
  });
  test('普通のフォルダは言わない（対）', () => {
    assert.equal(insideOneDrive('C:\\Users\\x\\AppData\\Local\\Programs\\AdaptiveAIStudio\\data\\models'), false);
    assert.equal(insideOneDrive('/home/user/AdaptiveAIStudio'), false);
    // 名前の一部に紛れていても、フォルダ名そのものでなければ言わない。
    assert.equal(insideOneDrive('/srv/one-drive-notes'), false);
  });
});

describe('言うこと', () => {
  test('モデルのフォルダなら、常に保持する直し方を添える', () => {
    const n = modelsDirNote('Z:\\maguro\\OneDrive - Business1\\models');
    assert.ok(n);
    assert.match(n.text, /OneDrive の中にあります/);
    assert.match(n.hint, /このデバイス上に常に保持する/);
    assert.match(n.hint, /ことがあります/, '実際に遅いと言い切っている');
  });
  test('プログラムのフォルダも同じ形で、理由は別', () => {
    const n = programDirNote('Z:\\maguro\\OneDrive - Business1\\AdaptiveAIStudio');
    assert.ok(n);
    assert.match(n.hint, /小さいファイル/);
  });
  test('外なら何も言わない（対）', () => {
    assert.equal(modelsDirNote('D:\\models'), undefined);
    assert.equal(programDirNote('D:\\AdaptiveAIStudio'), undefined);
  });
});
