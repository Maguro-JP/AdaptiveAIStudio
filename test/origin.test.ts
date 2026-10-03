/**
 * 画面の口を、よその頁から叩かせない。
 *
 * 127.0.0.1 にしか開いていなくても、ブラウザは何処の頁からでも届く。
 * 断る側と通す側の両方を置く。片方だけだと「全部断る」で通ってしまい、
 * 画面そのものが動かなくなる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crossSiteReason } from '../src/ui/origin.ts';

describe('よその頁からの要求を断る', () => {
  test('Sec-Fetch-Site が cross-site', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'cross-site' }, 'POST'));
  });
  /**
   * same-site は「同じ登録可能ドメインの、別の生成元」。
   *
   * 別の port も、別の下位ドメインもここに入る。**同じ機械の別の口で
   * 動いている何か**から叩かれる形なので、cross-site と同じく断る。
   * ここを見ていなかったので、条件を cross-site だけに縮めても通った。
   */
  test('Sec-Fetch-Site が same-site（別の口・別の下位ドメイン）', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'same-site' }, 'POST'));
  });
  test('大文字で来ても断る', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'CROSS-SITE' }, 'POST'));
  });
  test('同じ頭が二つ来たら、前のもので決める', () => {
    // 割り込み（header の二重送り）で緩めさせない。
    assert.ok(crossSiteReason({
      host: '127.0.0.1:4174', 'sec-fetch-site': ['cross-site', 'same-origin'],
    }, 'POST'));
  });
  test('Origin がよそ', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'https://evil.example' }, 'POST'));
  });
  test('Origin が null（砂場の iframe など）', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'null' }, 'POST'));
  });
  test('同じ 127.0.0.1 でも、別の port の Origin は断る（preview・同じ機械の別の dev server）', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'http://127.0.0.1:5555' }, 'POST'));
    assert.ok(crossSiteReason({ host: 'localhost:4174', origin: 'http://localhost:3000' }, 'POST'));
  });
  test('よその頁からの GET も断る（GET でも何かを起こす口がある）', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'cross-site' }, 'GET', { guardReads: true }));
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'https://evil.example' }, 'GET', { guardReads: true }));
  });
  test('guardReads を付けない口（preview）は、よそからの GET を通す（画面の iframe・別のタブから読まれる）', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:5555', 'sec-fetch-site': 'same-site' }, 'GET'), undefined);
    assert.equal(crossSiteReason({ host: '127.0.0.1:5555', 'sec-fetch-site': 'cross-site', origin: 'null' }, 'GET'), undefined);
  });
  test('Host が自分でない（DNS の付け替え）は GET でも断る', () => {
    assert.ok(crossSiteReason({ host: 'evil.example' }, 'GET'));
  });
});

describe('自分の頁と、ブラウザでないものは通す（対）', () => {
  test('同じ生成元', () => {
    assert.equal(crossSiteReason({
      host: '127.0.0.1:4174', origin: 'http://127.0.0.1:4174', 'sec-fetch-site': 'same-origin',
    }, 'POST'), undefined);
  });
  test('自分の画面の GET は通す', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'same-origin' }, 'GET', { guardReads: true }), undefined);
  });
  test('同じ port なら、localhost と 127.0.0.1 の綴りの違いは通す', () => {
    assert.equal(crossSiteReason({ host: 'localhost:4174', origin: 'http://127.0.0.1:4174' }, 'POST'), undefined);
  });
  test('localhost で開いていても通す', () => {
    assert.equal(crossSiteReason({ host: 'localhost:4174', origin: 'http://localhost:4174' }, 'POST'), undefined);
  });
  test('何も付いていない（curl・検査）は通す', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:4174' }, 'POST'), undefined);
  });
  test('利用者の入力（アドレス欄）は none で来る', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'none' }, 'POST'), undefined);
  });
  test('IPv6 の自分（[::1]）も自分', () => {
    assert.equal(crossSiteReason({ host: '[::1]:4174', origin: 'http://[::1]:4174' }, 'POST'), undefined);
  });
  test('決めた host で開いているなら、それも自分', () => {
    assert.equal(crossSiteReason({ host: '192.168.1.5:4174', origin: 'http://192.168.1.5:4174' }, 'POST', { ownHosts: ['192.168.1.5'] }), undefined);
  });
});
