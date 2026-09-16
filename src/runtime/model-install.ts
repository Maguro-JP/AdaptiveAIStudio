/**
 * モデル（GGUF）を取ってくる。
 *
 * llama-server と同じ考え方で、**この道具が自分で用意する**。
 * 違うのは大きさで、数GB になる。だから途中経過を出し、
 * 中断されたものを「置いてある」と誤認しない作りにする。
 *
 * ファイル名は決め打ちにしない。配布側の名前は変わるし、
 * 大きいものは分割されている。取ってくるときに一覧から選ぶ。
 */
import { mkdir, rename, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { describeNet } from './net-why.ts';
import { readGguf } from './gguf.ts';
import { modelsDir } from '../core/home.ts';
import type { CatalogEntry } from './model-catalog.ts';

/**
 * GGUF の既定の置き場。
 *
 * **一箇所に置く。** 同じ既定値を三箇所に書いていたため、
 * doctor は「設定されていれば見る」形になり、設定していない人
 * （＝ほとんどの人）の既定の置き場を検査から外していた。
 * 既定こそ検査されるべきなので、名前を付けて共有する。
 */
export function defaultModelsDir(): string {
  return modelsDir();
}

const HF_API = 'https://huggingface.co/api/models';
const HF_FILES = 'https://huggingface.co';

/** 取ってきている最中の、いまの状態。数字のまま渡す（画面が並べ替えて出す）。 */
export interface FetchStatus {
  /** 0〜100。全体の大きさが分からなければ無い。 */
  pct?: number;
  doneBytes: number;
  totalBytes?: number;
  bytesPerSec: number;
  etaSec?: number;
}

export interface ModelInstallOptions {
  entry: CatalogEntry;
  modelsDir: string;
  /** 節目の一言（一覧を調べる・選んだ・置いた など）。 */
  onProgress?: (line: string) => void;
  /**
   * 進み具合。**渡されたら、進み具合は onProgress に流さない。**
   *
   * 1.5 秒ごとの行が記録に流れ、記録が埋まって読めなかった（実機）。
   * 画面は最新の状態だけを出せばよい。端末（CLI）は渡さないので、今までどおり行で出る。
   */
  onStatus?: (status: FetchStatus) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface InstalledModel {
  /** 置いた場所 */
  path: string;
  /** 取ってきたファイル名 */
  file: string;
  bytes: number;
}

/**
 * 量子化に合うファイルを選ぶ。
 *
 * 分割されているもの（-00001-of-00003 など）は、この道具では扱わない。
 * 扱えるふりをして半分だけ落とすより、扱えないと言う方がよい。
 */
export function pickModelFile(files: string[], quant: string): string | undefined {
  const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf'));
  const matched = ggufs.filter((f) => f.toLowerCase().includes(quant.toLowerCase()));
  const single = matched.filter((f) => !/-\d{5}-of-\d{5}\./i.test(f));
  // 同じ量子化が複数あるなら、名前の短い方を採る（余計な派生を避ける）
  return single.sort((a, b) => a.length - b.length)[0];
}

/** すでに置いてあるか。 */
export async function findModel(modelsDir: string, quant: string, repo: string): Promise<string | undefined> {
  const stem = repo.split('/').at(-1)!.toLowerCase().replace(/-gguf$/, '');
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(modelsDir);
    const hit = names.find((n) => {
      const lower = n.toLowerCase();
      return lower.endsWith('.gguf') && lower.includes(quant.toLowerCase())
        && stem.split('-').every((part) => lower.includes(part));
    });
    return hit ? join(modelsDir, hit) : undefined;
  } catch {
    return undefined;
  }
}

export async function installModel(opts: ModelInstallOptions): Promise<InstalledModel> {
  const { entry, modelsDir } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onProgress ?? (() => {});

  const already = await findModel(modelsDir, entry.quant, entry.repo);
  if (already) {
    const s = await stat(already);
    log(`すでにあります: ${already}`);
    return { path: already, file: already.split(/[\\/]/).at(-1)!, bytes: s.size };
  }

  // **URL を直に渡せる。**配布元の名前の付け方は変わるし、こちらが書いた
  // 見当は外れる。外れた時点で利用者が詰むのがいちばん悪い。
  // ブラウザで見つけた .gguf の場所を、そのまま貼れるようにする。
  const directUrl = /^https?:\/\//i.test(entry.repo) ? entry.repo : undefined;
  if (directUrl) {
    let leaf = '';
    try {
      leaf = decodeURIComponent(new URL(directUrl).pathname.split('/').at(-1) ?? '');
    } catch {
      throw new Error(`場所として読めません: ${directUrl}`);
    }
    if (!leaf.toLowerCase().endsWith('.gguf')) {
      throw new Error(
        `.gguf を指していません: ${leaf || directUrl}\n`
        + '配布元の頁ではなく、ファイルそのものの場所を貼ってください\n'
        + '（HuggingFace なら、ファイル名の横の download の先）。',
      );
    }
    return await fetchInto({
      url: directUrl, leaf, modelsDir, entry, fetchImpl, log,
      ...(opts.onStatus ? { status: opts.onStatus } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  log(`一覧を調べます: ${entry.repo}`);
  let meta: Response;
  try {
    meta = await fetchImpl(`${HF_API}/${entry.repo}`, { signal: opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    // ここから先は届かない。**ブラウザなら届く**機械がある（会社の PC。
    // 中継を通すのはブラウザだけ）。取れないと言って終わらず、手で取る道を出す。
    /*
     * **人の言葉に直してから出す。**`describeNet` はそのために書いてあるのに、
     * ここでは生の文をそのまま出していた。会社の回線で最初に当たるのはここで、
     * 出るのは `fetch failed` の一語。**何が起きたのかも、次に何をすればいい
     * のかも分からない。**証明書で断られたのか、名前が引けないのかで、
     * 打つ手はまるで違う。
     */
    throw new Error(
      `配布元に繋がりません（${describeNet(e)}）。\n`
      + byHand(entry, modelsDir),
    );
  }
  if (!meta.ok) {
    if (meta.status === 404) {
      // **名前が違うだけのことが多い。**次の一手を出さないと、そこで終わる。
      throw new Error(
        `配布元が見つかりません: ${entry.repo}\n`
        + '名前が変わっているか、消えています。\n'
        + `  1. ブラウザで探す: ${HF_FILES}/models?search=gguf\n`
        + '  2. 見つけた置き場の名前（例 unsloth/Qwen2.5-7B-Instruct-GGUF）を\n'
        + '     「取ってくる先」に打つ。.gguf の URL をそのまま貼っても取れます。\n'
        // **いちばん確実な逃げ道を、必ず添える。**ブラウザで落として置くだけで動く。
        // 会社の PC はこの道しかないうえ、名前が変わっているときも同じ道で済む。
        + `  3. それが面倒なら、.gguf をブラウザで落として ${modelsDir} に置き、\n`
        + '     「置いたものを読み直す」を押すだけでも使えます。',
      );
    }
    // 403 は理由が複数ある。番号だけ出しても、次に何をすればいいか分からない。
    if (meta.status === 401 || meta.status === 403) {
      throw new Error(
        `配布元に断られました (${meta.status})。次のどれかです。\n`
        + '  ・そのモデルが利用同意を求めている（配布元のページで同意すると取れます）\n'
        + '  ・回線側で huggingface.co が塞がれている\n'
        + '  ・問い合わせ回数の上限（少し待つと戻ります）\n'
        + byHand(entry, modelsDir),
      );
    }
    throw new Error(`一覧を調べられませんでした (${meta.status})\n${byHand(entry, modelsDir)}`);
  }
  const json = await meta.json() as { siblings?: Array<{ rfilename: string }> };
  const files = (json.siblings ?? []).map((s) => s.rfilename);

  const file = pickModelFile(files, entry.quant);
  if (!file) {
    const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf'));
    throw new Error(
      `${entry.quant} に合うファイルがありません。\n`
      + `あるもの: ${ggufs.slice(0, 10).join(', ') || '(GGUF なし)'}`
      + (ggufs.some((f) => /-\d{5}-of-\d{5}\./.test(f)) ? '\n（分割されたものは、この道具では扱えません）' : ''),
    );
  }
  log(`選びました: ${file}`);

  // 配布元の一覧から来た名前。区切りは / だけでなく \\ も見る（Windows では
  // \\ が道として解釈され、置き場の外へ出る）。点だけの名前は置かない。
  const leaf = file.split(/[\\/]/).at(-1) ?? '';
  if (!leaf || leaf === '.' || leaf === '..') throw new Error(`置ける名前ではありません: ${file}`);

  return await fetchInto({
    url: `${HF_FILES}/${entry.repo}/resolve/main/${file}`,
    leaf, modelsDir, entry, fetchImpl, log,
    ...(opts.onStatus ? { status: opts.onStatus } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** 落とす本体。一覧から選んだときも、URL を直に渡されたときも、ここを通す。 */
async function fetchInto(a: {
  url: string; leaf: string; modelsDir: string; entry: CatalogEntry;
  fetchImpl: typeof fetch; log: (l: string) => void; status?: (s: FetchStatus) => void; signal?: AbortSignal;
}): Promise<InstalledModel> {
  const { url, leaf, modelsDir, entry, fetchImpl, log, status } = a;
  const opts = { signal: a.signal };
  const dest = join(modelsDir, leaf);
  const tmp = `${dest}.part`;
  await mkdir(modelsDir, { recursive: true });

  // すでに途中まで取れているなら、**その続きから**。
  // 数GBを落とす途中で切れることは普通にある。毎回ゼロからやり直させると、
  // 回線の細い家では永久に終わらない。実際、切れると .part が残ったまま
  // 次もゼロから始めていた（残骸だけが増える）。
  const had = await stat(tmp).then((st) => st.size).catch(() => 0);
  if (had > 0) log(`途中まで取れています（${human(had)}）。続きから取ります。`);

  // 置き場に入るか、先に見る。数GB落とし切ってから「入りません」は遅い。
  await checkRoom(modelsDir, entry.approxGB, log);

  log(`取ってきます（約${entry.approxGB}GB。回線によっては数十分かかります）`);

  // **黙り込んだら打ち切る。**相手が繋いだまま何も送らないことがある。
  // 打ち切りが無かったので、そのまま永久に固まっていた（画面も止まったまま）。
  const stallMs = 60_000;
  const guard = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; guard.abort(); }, stallMs);
  };

  let res: Response;
  const signals = opts.signal ? [opts.signal, guard.signal] : [guard.signal];
  arm();
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.any(signals),
      ...(had > 0 ? { headers: { range: `bytes=${had}-` } } : {}),
    });
  } catch (e) {
    clearTimeout(timer);
    if (opts.signal?.aborted) throw e;
    throw new Error(
      stalled
        ? `配布元が ${stallMs / 1000} 秒だまったままです。回線を確かめて、もう一度実行してください。\n`
          + `（途中までは残してあります。続きから取ります）\n${byHand(entry, modelsDir, url)}`
        : `取ってこられませんでした（${describeNet(e)}）。\n${byHand(entry, modelsDir, url)}`,
    );
  }
  // 206 なら続き、200 なら相手が続きに応じなかった（最初から取り直す）。
  const resuming = had > 0 && res.status === 206;
  if (had > 0 && res.status === 200) log('配布元が続きに応じないので、最初から取り直します。');
  if (res.status === 416) {
    // すでに全部取れている。中身を確かめる段へ進む。
    log('すでに全部取れていました。');
  } else if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`取ってこられませんでした (${res.status})\n${byHand(entry, modelsDir, url)}`);
  }

  /*
   * **すでに全部取れているとき、取れているものを切り詰めない。**
   *
   * 416（範囲外）は「もう全部ある」の返事なのに、`open(tmp, 'w')` を通っていた。
   * `w` は開いた時点で 0 バイトにする。**数GB取れていた .part が、
   * 「すでに全部取れていました」と言いながら消える。**そのあと中身の確かめで
   * 落ちて、残骸まで消される。取り直しに何十分もかかる回線では、これが一番重い。
   */
  const done = res.status === 416;

  /*
   * **長さを言わない相手を、0 と数えない。**
   *
   * `content-length` を返さない相手（chunked）が居る。`?? 0` にしていたので
   * `total` が `had` になり、続きを取り切っても `written !== total` で
   * **「途中で切れました」**と言って .part のまま放り出していた。
   * 取り切っているのに、何度やっても終わらない。
   */
  const lenHeader = res.headers.get('content-length');
  const part = lenHeader === null ? undefined : Number(lenHeader);
  const total = done
    ? had
    : part === undefined || Number.isNaN(part)
      // 分からないものは 0（＝分からない）。下の突き合わせは total > 0 のときだけ。
      ? 0
      : resuming ? had + part : part;
  const handle = await open(tmp, resuming || done ? 'r+' : 'w');
  let written = resuming || done ? had : 0;
  let lastAt = 0;
  const began = Date.now();
  const from = written;

  try {
    if (res.status !== 416) {
      if (resuming) await handle.truncate(had);
      for await (const chunk of streamOf(res)) {
        await handle.write(chunk, 0, chunk.byteLength, written);
        written += chunk.byteLength;
        arm(); // 進んでいる。待ち直す
        // **時計で出す。**10% ごとだと、5GB では 500MB ごと＝数十秒に一度しか
        // 動かない。止まったようにしか見えない。
        const now = Date.now();
        if (now - lastAt >= 1500) {
          lastAt = now;
          const sec = (now - began) / 1000;
          const rate = sec > 0 ? (written - from) / sec : 0;
          const left = total > 0 && rate > 0 ? (total - written) / rate : 0;
          const now_: FetchStatus = {
            ...(total > 0 ? { pct: Math.floor((written / total) * 100), totalBytes: total } : {}),
            doneBytes: written, bytesPerSec: rate, ...(left > 0 ? { etaSec: left } : {}),
          };
          // 状態を受ける側が居れば、そちらだけ。行として流すと記録が埋まる。
          if (status) status(now_);
          else log(`  ${describeFetch(now_)}`);
        }
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    // **残しておく。**次は続きから取れる。消すと、また最初からになる。
    throw new Error(
      stalled
        ? `配布元が ${stallMs / 1000} 秒だまったままです（${human(written)} まで取れています）。\n`
          + 'もう一度実行すると、続きから取ります。'
        : `途中で切れました（${human(written)} まで取れています）。\n`
          + 'もう一度実行すると、続きから取ります。',
    );
  } finally {
    clearTimeout(timer);
    await handle.close();
  }

  if (total > 0 && written !== total) {
    // **消さない。**続きから取れる。
    throw new Error(
      `途中で切れました（${human(written)} / ${human(total)}）。\n`
      + 'もう一度実行すると、続きから取ります。',
    );
  }

  // 本物の GGUF か確かめてから、正式な名前にする。
  // 取れたことと使えることは別で、配布元が HTML の案内を返すこともある。
  log('中身を確かめます');
  try {
    const info = await readGguf(tmp, { headBytes: 1024 * 1024 });
    log(`  ${info.metadata.get('general.architecture') ?? '(種別不明)'} として読めました`);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`GGUF として読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }

  await rename(tmp, dest);
  log(`置きました: ${dest}`);
  return { path: dest, file: dest.split(/[\\/]/).at(-1)!, bytes: written };
}

/**
 * 手で取る道。
 *
 * この道具から届かなくても、ブラウザからなら届く機械がある。
 * 「取れませんでした」で終わらせると、そこで止まる。開く先と置く先を、
 * そのまま貼れる形で言う。直リンクが分かっていればそれを、
 * 分かっていなければ一覧の頁と、探す目印（量子化の名前）を出す。
 */
export function byHand(entry: { repo: string; quant: string }, modelsDir: string, direct?: string): string {
  const open = direct ?? `${HF_FILES}/${entry.repo}/tree/main`;
  return [
    '手で取るなら:',
    `  1. ブラウザで開く: ${open}`,
    direct
      ? '  2. 落とす'
      : `  2. 名前に ${entry.quant} が付く .gguf を1つ落とす（分割されたものは扱えません）`,
    `  3. ここに置く: ${modelsDir}`,
    '  置いたら、モデルの画面で「置いたものを読み直す」を押してください。',
  ].join('\n');
}

/** 応答を塊で読む。 */
async function* streamOf(res: Response): AsyncGenerator<Buffer> {
  const body = res.body;
  if (!body) throw new Error('中身がありません');
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield Buffer.from(value);
  }
}

/** 人が読む大きさ。0.0GB とだけ出ていたので、桁に合わせる。 */
/** 進み具合を一行にする。端末の行と、画面の最新の一言で、同じ形。 */
export function describeFetch(s: FetchStatus): string {
  return `${s.pct !== undefined ? `${s.pct}%  ` : ''}`
    + `${human(s.doneBytes)}${s.totalBytes !== undefined ? ` / ${human(s.totalBytes)}` : ''}`
    + `  ${human(s.bytesPerSec)}/秒${s.etaSec !== undefined ? `  残り ${mmss(s.etaSec)}` : ''}`;
}

export function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes)}B`;
}

/** 残り時間。 */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
  if (s >= 60) return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
  return `${s}秒`;
}


/**
 * 置き場に入るか。
 *
 * 数GB を落とし切ってから「入りません」では遅い。**先に見る。**
 * 見られない機械（statfs が無い等）では、黙って通す。
 */
async function checkRoom(dir: string, approxGB: number, log: (l: string) => void): Promise<void> {
  if (!approxGB) return;
  try {
    const { statfs } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const fs = await statfs(dir);
    const free = fs.bavail * fs.bsize;
    const need = approxGB * 1024 ** 3 * 1.1; // 少し余裕を見る
    if (free < need) {
      throw new Error(
        `置き場が足りません: ${dir}\n`
        + `  空き ${human(free)} / 要る ${human(need)}\n`
        + '別の置き場を選ぶか、空けてから、もう一度実行してください。',
      );
    }
    log(`置き場の空き: ${human(free)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('置き場が足りません')) throw e;
    // 見られないなら、黙って通す。見られないことは、止める理由にならない。
  }
}
