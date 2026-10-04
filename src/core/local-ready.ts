/**
 * この中で読む（inproc）道で、送れる状態にする。
 *
 * 画面は保存先の GGUF を選んで読み、**読んだ名前をそのまま候補にする**。
 * 端末（agent / chat / team）には、その道が無かった。端末は HTTP の一覧
 * （`127.0.0.1:4177/v1/models`）だけを見るが、**この口はモデルを読むまで
 * 立たない**ので必ず空になる。そのまま `使えるモデルがありません` で
 * exit 1 する一方、doctor は同じ状態で「動かせます。`npm run agent` で端末」
 * と言う。案内された手が、その場で落ちる。
 *
 * 名前から規模を当てる道（`inferSpec`）も、`probe-tiny.gguf` のように
 * 規模の書いていない名前では当たらない。**読めている以上、使えるかどうかを
 * 名前で決め直さない。**
 */
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { inprocUrl, type AasConfig, type ProviderConfig } from '../config.ts';
import { modelsDir } from './home.ts';
import type { LocalRuntime } from '../runtime/local-runtime.ts';
import { chooseModel, tooBigForRam, looksLikeGguf, CHOICE_WHY } from '../runtime/inproc.ts';

/**
 * この中で読む口（inproc）。有効で、名前が inproc か、繋ぎ先が inproc の番号を向くものだけ。
 * 有効な手元の口なら何でも選んでいたので、無効にした既定の口や、利用者が別に書いた LM Studio などの口に、
 * こちらが読んだ GGUF の名前を付けて候補に固定し、存在しないモデルの名前で送り続けていた。
 */
function inprocProvider(config: AasConfig): ProviderConfig | undefined {
  const url = inprocUrl(config);
  const locals = config.providers.filter((p) => p.kind === 'openai-compatible' && p.locality === 'local' && p.enabled !== false);
  const exact = locals.find((p) => p.id === 'inproc') ?? locals.find((p) => p.baseUrl === url);
  if (exact || config.runtime?.basePort !== 0) return exact;
  // 番号を空いているものに任せた（basePort: 0）ときは、番号では照らせない。この機械を向く口を、この中で読む口とみなす
  return locals.find((p) => {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(p.baseUrl ?? '').hostname); } catch { return false; }
  });
}

/**
 * 読んでいる GGUF を候補にした設定を返す。
 *
 * **候補は `provider名:モデル名`。**名前だけを渡すとどの provider か決まらず、
 * 「全Provider が未登録」で即座に落ちる（画面で実際に踏んだ）。
 * 繋ぎ先の一覧にも入れる。既定の名前のままだと、置いてある GGUF が
 * どこにも無いことになる。
 */
export function withLocalCandidate(
  config: AasConfig,
  ref: string,
  window?: number,
): AasConfig {
  const local = inprocProvider(config);
  if (!local) return config;
  const providers = config.providers.map((p) => (p === local ? { ...p, models: [ref] } : p));
  // **実際に開いたコンテキストウィンドウを渡す。**設定から見積もらせない。
  // 狭められたときは溢れ（返事が来なくなる）、広げたときは刈りすぎる。
  const runtime = window
    ? { ...config.runtime, kind: 'inproc' as const, contextSize: window }
    : config.runtime;
  return { ...config, providers, candidates: [`${local.id}:${ref}`], runtime };
}

export interface LocalReady {
  /** 候補を入れ直した設定。何もできなかったときは渡されたものをそのまま返す。 */
  config: AasConfig;
  /** 読めなかった理由。読めたときは undefined。 */
  why?: string;
  /**
   * なぜその名前になったか。
   *
   * **`設定で固定` と言わせないために持つ。**候補を入れると
   * `resolveCandidates` は「設定で固定」と答えるが、利用者は何も固定していない。
   * こちらが保存先から選んだのなら、そう言う。
   */
  note?: string;
}

/**
 * 保存先の GGUF を選んで読み、候補に入れた設定を返す。
 *
 * 選び方は画面と同じ（`chooseModel`）。**片方だけが直る形にしない。**
 */
export async function readyLocalModel(
  config: AasConfig,
  runtime: LocalRuntime,
  log?: (text: string) => void,
): Promise<LocalReady> {
  // 設定で固定してあるなら、そちらが優先。こちらから上書きしない。
  if (config.candidates && config.candidates.length > 0) return { config };
  // 別に立てたもの（ollama / llama-server）は、相手が一覧を返す。ここは要らない。
  if (runtime.id !== 'inproc') return { config };
  // この中で読む口が無い（クラウドだけで使う・手元の口を無効にした・別の手元の口だけを書いた）なら、数 GB のモデルを読み込まない
  if (!inprocProvider(config)) return { config };

  const loaded = runtime.loaded();
  const ref0 = loaded[0];
  if (ref0) {
    return {
      config: withLocalCandidate(config, ref0, runtime.windowOf?.(ref0)),
      note: `読み込んでいる ${ref0} を使います`,
    };
  }

  const models = await runtime.list().catch(() => []);
  // 一つも無いのは、呼んだ側の言葉（「.gguf があるか見てください」）で言う。
  if (models.length === 0) return { config };

  const backend = await runtime.backend?.().catch(() => undefined);
  const picked = chooseModel(models, totalmem(), config.runtime?.model, {
    ...(backend ? { hasGpu: backend.gpu !== false } : {}),
    ...(backend?.vramBytes ? { vramBytes: backend.vramBytes } : {}),
  });
  if (!picked) return { config };
  const ref = picked.chosen.ref;

  // 記憶に載らないものを読みに行かない。落ちるか、何十分も固まる。
  if (!picked.fits) {
    const big = tooBigForRam(picked.chosen.sizeBytes, totalmem());
    const others = models.length > 1
      ? `\nこの保存先には ${models.length} 個ありますが、どれも載りません。`
      : '';
    return { config, why: `${ref}: ${big ?? '記憶に載りません。'}${others}` };
  }
  // 名前だけ .gguf で中身が別物（配布元の HTML の案内など）を、読みに行かない。
  const dir = config.runtime?.modelsDir ?? modelsDir();
  if (!(await looksLikeGguf(join(dir, ref)))) {
    return {
      config,
      why: `${ref} は GGUF として読めません（中身が GGUF ではありません）。`
        + '配布元の同意頁の HTML を落としてしまった形が多いです。',
    };
  }

  const gb = ((picked.chosen.sizeBytes ?? 0) / 1024 ** 3).toFixed(1);
  log?.(`モデルを読み込んでいます: ${ref}（${gb}GB・${CHOICE_WHY[picked.why]}）`);
  try {
    await runtime.ensureLoaded(ref);
  } catch (e) {
    return { config, why: `読み込めませんでした: ${ref}（${e instanceof Error ? e.message : String(e)}）` };
  }
  return {
    config: withLocalCandidate(config, ref, runtime.windowOf?.(ref)),
    note: `保存先の ${ref} を読みました（${CHOICE_WHY[picked.why]}）`,
  };
}
