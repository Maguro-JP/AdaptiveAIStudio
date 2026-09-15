/**
 * 入口（scripts/run.mjs）は、止める合図を本体へ渡す。
 *
 * 合図は入口に来る。入口だけが死んで、本体が親無しで生き続けていた。
 * check:bundle で画面を止めたつもりが、画面は答え続け、確かめ自体が
 * 終わらなかった（ps に親 1 の node が並んだ）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { forwardSignals } from '../scripts/run.mjs';

describe('止める合図を子へ渡す', () => {
  test('SIGTERM も SIGINT も、そのまま子へ', () => {
    const got: string[] = [];
    const child = { kill: (sig: string) => { got.push(sig); return true; } };
    const proc = new EventEmitter();
    forwardSignals(child, proc);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    assert.deepEqual(got, ['SIGTERM', 'SIGINT']);
  });

  test('入口の本体は、合図を受けても自分では終わらない（子の exit で終わる）', () => {
    // 自分で process.exit すると、子が残る。
    const proc = new EventEmitter();
    let exited = false;
    (proc as unknown as { exit: () => void }).exit = () => { exited = true; };
    forwardSignals({ kill: () => true }, proc);
    proc.emit('SIGTERM');
    assert.equal(exited, false);
  });
});
