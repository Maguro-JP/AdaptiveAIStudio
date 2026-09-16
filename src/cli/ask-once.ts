/**
 * 一度だけ送って、返るところまで見る。
 *
 * **在ることで確かめない。**保存先に GGUF が在ること・立ち上がることは、
 * 答えることを言わない。ここまで、いちばん知りたいこと（**この機械で、
 * このモデルで、本当に答えるか**）を確かめる口がどこにも無く、
 * 「画面で 1+1= と打って、返ってきたものを教えてください」と頼んでいた。
 * **確かめる仕事を、使う人へ渡していた。**
 *
 * 通す道は、画面と端末の入口と同じ（`buildRuntime` → `readyLocalModel` →
 * 候補 → 送る）。別の道で通しても、使う道が通る証明にならない。
 *
 * ここは `selftest` と `scripts/real-model.mjs` の両方から呼ぶ。
 * 出す言葉（`describeOneTurn`）も一緒に置く。人が読む一行は、
 * 中身と同じ場所で決める（二つに割れると、片方だけ直す）。
 */
import type { AasConfig } from '../config.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { readyLocalModel } from '../core/local-ready.ts';
import { speedOf } from '../core/session.ts';
import { Priority } from '../providers/contract.ts';

/** 待つ上限。数GBを CPU で読むところから始まるので、短くしない。 */
export const ONE_TURN_WAIT = 600_000;

export interface OneTurn {
  /** 返ってきた文字。空なら、答えなかった。 */
  answer: string;
  /** 答えたモデル。途中で移ったら、移った先。 */
  model?: string;
  /** モデルを読むのにかかった秒。 */
  loadSeconds: number;
  /** 送ってから返り切るまでの秒。 */
  answerSeconds: number;
  tps?: number;
  /** 送れなかった・返らなかった理由。 */
  why?: string;
}

export interface AskOnceOptions {
  /** 進み具合を流す先。数分かかるので、何も出ないと固まったように見える。 */
  log?: (line: string) => void;
  waitMs?: number;
  /** 訊く言葉。既定は足し算（答えを見れば、通ったかどうかが人にも分かる）。 */
  ask?: string;
}

export async function askOnce(config: AasConfig, opts: AskOnceOptions = {}): Promise<OneTurn> {
  const began = Date.now();
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);
  const pilot = await setupAutopilot(config, registry);
  const runtime = await buildRuntime(config, pilot.machine);
  try {
    const ready = await readyLocalModel(config, runtime, opts.log);
    const picked = resolveCandidates(ready.config, pilot);
    const candidates = picked.candidates;
    const loadSeconds = (Date.now() - began) / 1000;
    if (candidates.length === 0) {
      return {
        answer: '', loadSeconds, answerSeconds: 0,
        why: ready.why ?? picked.note ?? '送る先が決まりません',
      };
    }
    const sending = Date.now();
    const ac = new AbortController();
    const giveUp = setTimeout(() => ac.abort(), opts.waitMs ?? ONE_TURN_WAIT);
    giveUp.unref?.();
    let answer = '';
    let model = candidates[0]!;
    let why: string | undefined;
    try {
      for await (const ev of orchestrator.run({
        candidates,
        system: '短く答えてください。',
        messages: [{ role: 'user', content: opts.ask ?? '1+1=' }],
        temperature: 0,
        maxTokens: 32,
        priority: Priority.top,
      }, ac.signal)) {
        if (ev.type === 'text') answer += ev.delta;
        // 途中で別のモデルへ移ったら、答えたのはそちら。
        else if (ev.type === 'fallback') model = ev.to;
        else if (ev.type === 'failed') why = ev.error.message;
      }
    } catch (e) {
      why = (e as Error).message;
    } finally {
      clearTimeout(giveUp);
    }
    const answerSeconds = (Date.now() - sending) / 1000;
    const speed = speedOf(model, answer.length, answerSeconds);
    return {
      answer: answer.trim(), model, loadSeconds, answerSeconds,
      ...(speed.tps === undefined ? {} : { tps: speed.tps }),
      ...(why === undefined ? {} : { why }),
    };
  } finally {
    // 読み込んだモデルを抱えたまま残さない。
    await runtime.shutdown().catch(() => undefined);
  }
}

/**
 * 人が読む一行にする。
 *
 * **答えの中身は、道の良し悪しではない。**小さいモデルは平気で間違える。
 * 道が通っていること（返ってきたこと）と、中身が合っていることを分けて書く。
 */
export function describeOneTurn(got: OneTurn): { ok: boolean; detail: string } {
  const load = got.loadSeconds.toFixed(1);
  if (got.answer.length === 0) {
    return {
      ok: false,
      detail: `答えが返りませんでした（読み込み ${load}秒、待ち ${got.answerSeconds.toFixed(1)}秒`
        + `${got.why === undefined ? '' : `、${got.why}`}）`,
    };
  }
  const shown = got.answer.replace(/\s+/g, ' ').slice(0, 60);
  return {
    ok: true,
    detail: `${got.model ?? '(不明)'} / 読み込み ${load}秒 / 答え「${shown}」`
      + `${got.tps === undefined ? '' : ` / ${got.tps} tok/s`}`
      + ` / 2 を${/2/.test(got.answer) ? '含む' : '含まない（モデルの出来。道は通っています）'}`,
  };
}
