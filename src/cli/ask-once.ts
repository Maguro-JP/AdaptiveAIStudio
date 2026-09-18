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
 * 「1+1=」への答えが、本物の文字で 2 と言っているか。落ちる理由を返す（通れば undefined）。
 *
 * 最初は `/2/.test(answer)` だけだった。乱数の重みの模型が「Фt2�Y�g…」を返し、
 * その中に 2 が在ったので**通ってしまった**。偶然通る確かめは、確かめではない。
 *
 * 次に「問いの 1+1= を除いた最初の数字が 2」にしたが、別の役割の読み直しで
 * 「1 plus 1 equals 2」「The sum of 1 and 1 is 2.」「２」（全角）を落とすと分かった。
 * 問いを言い直した 1 が先に来る。**正しい答えを落とすと、有料の回が無駄になる。**
 *
 * 見るのは四つ。考えごと（<think>）を除いた本文が空でない・壊れた文字（U+FFFD）と
 * 制御文字が無い・文字の九割が普通の文字（ASCII か日本語・漢字）・全角を半角にそろえ、
 * 問いに含まれる数字（単独の 1）を除いた残りの数字の並びが、一つ以上あって全部 2。
 * 「2」「1+1=2」「1 plus 1 equals 2」「答えは 2 です」は通る。
 * 「22」「2.5」「2 + 2 = 4」「2 is wrong; the answer is 3」は通らない。
 */
export function judgeAnswer(answer: string): string | undefined {
  const body = answer.normalize('NFKC').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (body.length === 0) return '本文が空です（考えごとだけで終わったか、何も返っていません）';
  if (/\uFFFD/.test(body)) return '壊れた文字（U+FFFD）を含みます';
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body)) return '制御文字を含みます';
  const chars = [...body];
  const plain = chars.filter((c) => /[\x20-\x7E\s\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/.test(c)).length;
  if (plain / chars.length < 0.9) return '普通の文字（ASCII・日本語）が九割に届きません';
  // 問いに在る数字は 1 だけ。単独の 1 は問いの写しと見なして除く（12 や 21 は残る）。
  const rest = body.replace(/(?<!\d)1(?!\d)/g, '');
  const runs = rest.match(/\d+/g) ?? [];
  if (runs.length === 0) return '数字がありません';
  const other = runs.find((r) => r !== '2');
  if (other !== undefined) return `2 でない数字があります（${other}）`;
  return undefined;
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
  const judged = judgeAnswer(got.answer);
  return {
    ok: true,
    detail: `${got.model ?? '(不明)'} / 読み込み ${load}秒 / 答え「${shown}」`
      + `${got.tps === undefined ? '' : ` / ${got.tps} tok/s`}`
      + ` / ${judged === undefined ? '2 と答えています' : `2 と答えていません（${judged}。モデルの出来。道は通っています）`}`,
  };
}
