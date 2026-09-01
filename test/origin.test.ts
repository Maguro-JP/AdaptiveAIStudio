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
  test('Origin がよそ', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'https://evil.example' }, 'POST'));
  });
  test('Origin が null（砂場の iframe など）', () => {
    assert.ok(crossSiteReason({ host: '127.0.0.1:4174', origin: 'null' }, 'POST'));
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
  test('localhost で開いていても通す', () => {
    assert.equal(crossSiteReason({ host: 'localhost:4174', origin: 'http://localhost:4174' }, 'POST'), undefined);
  });
  test('何も付いていない（curl・検査）は通す', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:4174' }, 'POST'), undefined);
  });
  test('利用者の入力（アドレス欄）は none で来る', () => {
    assert.equal(crossSiteReason({ host: '127.0.0.1:4174', 'sec-fetch-site': 'none' }, 'POST'), undefined);
  });
  test('決めた host で開いているなら、それも自分', () => {
    assert.equal(crossSiteReason({ host: '192.168.1.5:4174', origin: 'http://192.168.1.5:4174' }, 'POST', { ownHosts: ['192.168.1.5'] }), undefined);
  });
});
