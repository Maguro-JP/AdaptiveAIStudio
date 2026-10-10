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
import { mkdir, rename, rm, stat, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeNet } from './net-why.ts';
import { readGguf } from './gguf.ts';
import { modelsDir } from '../core/home.ts';
import type { CatalogEntry } from './model-catalog.ts';
import { isAbsent } from '../harness/put-back.ts';

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

/**
 * 命令行の `--quant <名前>` を読む。無ければ q4_k_m。
 * `argv[indexOf('--quant') + 1]` だと、無いときに argv[0]（node の場所）を量子化の名前として読んでいた。
 */
export function quantFrom(argv: readonly string[]): string {
  const at = argv.indexOf('--quant');
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : 'q4_k_m';
}

/** すでに置いてあるか。 */
export async function findModel(modelsDir: string, quant: string, repo: string): Promise<string | undefined> {
  const stem = repo.split('/').at(-1)!.toLowerCase().replace(/-gguf$/, '');
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(modelsDir);
    // 語ごとに見る。文字列として含むかで見ていたので、`4b` が `14b` に、`qwen3` が `qwen3.5` に当たり、
    // 別のモデルを「もうある」として取らなかった
    const wanted = stem.split(/[-_]/).filter((w) => w.length > 0);
    const q = quant.toLowerCase();
    const hit = names.find((n) => {
      const lower = n.toLowerCase();
      if (!lower.endsWith('.gguf') || !lower.includes(q)) return false;
      // 量子化の名前は先に外す（`mistral-7b-instruct-v0.2.q4_k_m` のように . で繋がると、`v0.2.q4` が一語になる）
      const words = new Set(lower.replace(/\.gguf$/, '').replace(q, '').replace(/[-_.]+$/, '').split(/[-_]/));
      return wanted.every((w) => words.has(w));
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

  // URL を直に渡されたときは、ファイルの名前（URL の最後）そのもので見る（下）。配布元の名前から探す見当は当てない
  const direct = /^https?:\/\//i.test(entry.repo);
  const already = direct ? undefined : await findModel(modelsDir, entry.quant, entry.repo);
  if (already) {
    const s = await stat(already);
    log(`すでにあります: ${already}`);
    return { path: already, file: already.split(/[\\/]/).at(-1)!, bytes: s.size };
  }

  // **URL を直に渡せる。**配布元の名前の付け方は変わるし、こちらが書いた
  // 見当は外れる。外れた時点で利用者が詰むのがいちばん悪い。
  // ブラウザで見つけた .gguf の場所を、そのまま貼れるようにする。
  // HuggingFace のファイルの頁（`/blob/`）は、ブラウザのアドレス欄からいちばん貼られる形。中身は HTML なので、ファイルそのもの（`/resolve/`）へ直して取る
  const directUrl = /^https?:\/\//i.test(entry.repo) ? hfFileUrl(entry.repo) : undefined;
  if (directUrl) {
    let leaf = '';
    try {
      leaf = decodeURIComponent(new URL(directUrl).pathname.split('/').at(-1) ?? '');
    } catch {
      throw new Error(`場所として読めません: ${directUrl}`);
    }
    /*
     * **名前に区切りを残さない。**URL の段階では `%2F` `%5C` は区切りでないので一つの名前として残り、decode した後で `../../x.gguf` になって、
     * フォルダの外へ書いていた（配布元の一覧から選ぶ道は区切りで切ってから断っている）。区切り・ドライブの `:`・点と空白だけの名前は断る
     */
    // Windows で使えない字（`< > " | ? *`・制御文字）と予約名（`CON.gguf`・`NUL.gguf` など）も断る。通すと書く段で何のことか分からない失敗になる
    if (/[\\/:<>"|?*\x00-\x1f]/.test(leaf) || /^[. ]+$/.test(leaf.replace(/\.gguf$/i, ''))
      || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(leaf)) {
      throw new Error(`ファイル名に区切りや使えない文字が入っています: ${leaf}`);
    }
    if (!leaf.toLowerCase().endsWith('.gguf')) {
      throw new Error(
        `.gguf を指していません: ${leaf || directUrl}\n`
        + '配布元の頁ではなく、ファイルそのものの場所を貼ってください\n'
        + '（HuggingFace なら、ファイル名の横の download の先）。',
      );
    }
    // 同じ名前が置いてあれば取らない（取り直して、数GBを上書きしていた）
    const here = join(modelsDir, leaf);
    // 無いときだけ取りに行く。読めない（権限など）なら、取り直して上書きする前に言う
    const had = await stat(here).catch((e: unknown) => { if (isAbsent(e)) return undefined; throw e; });
    if (had?.isFile()) {
      log(`すでにあります: ${here}`);
      return { path: here, file: leaf, bytes: had.size };
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
    // ここから先は届かない。**ブラウザなら届く**機械がある（管理された PC など。
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
        // この道しか無い環境もあるうえ、名前が変わっているときも同じ道で済む。
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
  /** 途中の分を捨てて取り直している回（取り直しをもう一度繰り返さない） */
  restarted?: boolean;
}): Promise<InstalledModel> {
  const { url, leaf, modelsDir, entry, fetchImpl, log, status } = a;
  const opts = { signal: a.signal };
  const dest = join(modelsDir, leaf);
  const tmp = `${dest}.part`;
  /*
   * 途中の分がどの版のファイルか（配布元の ETag か Last-Modified）。続きを頼むときに If-Range で添える。
   * 添えなかったので、途中で配布元のファイルが差し替わると、古い頭に新しい続きを継いだものを「置きました」としていた
   * （頭の 1MB しか確かめないので、通ってしまう）。
   */
  const tagFile = `${tmp}.tag`;
  const startOver = async (why: string): Promise<InstalledModel> => {
    if (a.restarted) throw new Error(`${why}。取り直しても合わないので止めます\n${byHand(entry, modelsDir, url)}`);
    log(`${why}。途中の分を捨てて、最初から取り直します。`);
    await rm(tmp, { force: true });
    await rm(tagFile, { force: true });
    return fetchInto({ ...a, restarted: true });
  };
  await mkdir(modelsDir, { recursive: true });

  // すでに途中まで取れているなら、**その続きから**。
  // 数GBを落とす途中で切れることは普通にある。毎回ゼロからやり直させると、
  // 回線の細い家では永久に終わらない。実際、切れると .part が残ったまま
  // 次もゼロから始めていた（残骸だけが増える）。
  // 見られない（掴まれている）のを「無い」と読まない。読むと、取れていた数 GB を空にしてゼロから取り直していた
  const had = await stat(tmp).then((st) => st.size).catch((e: unknown) => {
    if (isAbsent(e)) return 0;
    // 理由は符丁（EBUSY 等）で言う。stat の文は同じ道をもう一度含む長い英文になる
    throw new Error(`途中まで取ったファイル（${tmp}）を見られません（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）。消さずに残してあります。少し置いてからもう一度取ってください`);
  });
  if (had > 0) log(`途中まで取れています（${human(had)}）。続きから取ります。`);
  // ETag・Last-Modified の記録が無い（前の版が残した途中の分）なら、確かめられないまま続きを取る（捨てると数GBを取り直させる）
  const tag = had > 0 ? (await readFile(tagFile, 'utf8').catch((e: unknown) => { if (isAbsent(e)) return ''; throw e; })).trim() : '';

  // 置き場に入るか、先に見る。数GB落とし切ってから「入りません」は遅い。
  await checkRoom(modelsDir, entry.approxGB, log, had);

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
      ...(had > 0 ? { headers: { range: `bytes=${had}-`, ...(tag ? { 'if-range': tag } : {}) } } : {}),
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
  // 続きの始まりが、手元の長さと合わない。継ぐと中身がずれる
  if (had > 0 && res.status === 206) {
    const range = /^bytes (\d+)-/i.exec(res.headers.get('content-range') ?? '');
    if (range && Number(range[1]) !== had) {
      clearTimeout(timer);
      void res.body?.cancel().catch(() => undefined);
      return startOver(`配布元が返した続きの始まり（${range[1]}）が、取れている長さ（${had}）と合いません`);
    }
    // If-Range を無視して続きを返す相手も居る。返ってきた版が記録と違えば、継がない
    const now = markOf(res);
    if (tag && now && now !== tag) {
      clearTimeout(timer);
      void res.body?.cancel().catch(() => undefined);
      return startOver('配布元のファイルが、途中まで取ったときと別の版になっています');
    }
  }
  // 416 は「その位置から先は無い」。本当の長さが手元と同じときだけ「全部取れている」。違えば、配布元のファイルが変わっている
  if (res.status === 416) {
    const size = /\*\/(\d+)/.exec(res.headers.get('content-range') ?? '');
    /*
     * 本当の長さを言わない 416（中継が見出しを落とす、など）は、「全部ある」とも「違う」とも言えない。前は「同じ」と同じに扱い、
     * 途中までのファイルを正式な名前にして「置きました」と言っていた（頭の 1MB しか確かめないので通る）。途中の分は残したまま止めて、そう言う
     */
    if (!size) {
      clearTimeout(timer);
      void res.body?.cancel().catch(() => undefined);
      // 途中の分を残して止めると、次も同じ 416 で止まり、利用者が手で消すまで抜けられない。全部あると確かめられないので、最初から取り直す
      return startOver('配布元が、全部取れているかを確かめられる長さを返しませんでした（416・Content-Range が無い）');
    }
    if (Number(size[1]) !== had) {
      clearTimeout(timer);
      void res.body?.cancel().catch(() => undefined);
      return startOver(`配布元のファイル（${human(Number(size[1]))}）と、取れている長さ（${human(had)}）が合いません`);
    }
  }
  // 206 なら続き、200 なら相手が続きに応じなかった（最初から取り直す。If-Range が合わないときも 200 で全体が来る）。
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
  // 最初から取るときに、どの版を取っているかを残す。開く前に書く（書けずに落ちたとき、開いたものと見張りを残さない）
  if (!resuming && !done) {
    const mark = markOf(res);
    try {
      if (mark) await writeFile(tagFile, mark, 'utf8');
      else await rm(tagFile, { force: true });
    } catch (e) {
      clearTimeout(timer);
      void res.body?.cancel().catch(() => undefined);
      throw e;
    }
  }
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
    await rm(tagFile, { force: true });
    throw new Error(`GGUF として読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }

  await rename(tmp, dest);
  await rm(tagFile, { force: true });
  log(`置きました: ${dest}`);
  return { path: dest, file: dest.split(/[\\/]/).at(-1)!, bytes: written };
}

/** 配布元が返した版。強い ETag、無ければ Last-Modified（弱い ETag は If-Range に使えない）。 */
function markOf(res: Response): string | undefined {
  const etag = res.headers.get('etag');
  return (etag && !etag.startsWith('W/') ? etag : res.headers.get('last-modified')) ?? undefined;
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
 * 続きから取るときに要る空き。取れている分（`had`）は保存先に在るので差し引く（全体の大きさで見ていたので、残り 2GB でも「足りません」と止まり続けた）。少し余裕を見る。
 */
export function roomNeeded(approxGB: number, had = 0): number {
  return Math.max(0, approxGB * 1024 ** 3 - had) * 1.1;
}

/**
 * 置き場に入るか。
 *
 * 数GB を落とし切ってから「入りません」では遅い。**先に見る。**
 * 見られない機械（statfs が無い等）では、黙って通す。
 */
async function checkRoom(dir: string, approxGB: number, log: (l: string) => void, had = 0): Promise<void> {
  if (!approxGB) return;
  try {
    const { statfs } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const fs = await statfs(dir);
    const free = fs.bavail * fs.bsize;
    const need = roomNeeded(approxGB, had);
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

/** HuggingFace のファイルの頁の場所（`…/blob/<版>/x.gguf`）を、ファイルそのものの場所（`…/resolve/<版>/x.gguf`）へ直す。ほかの場所はそのまま。 */
export function hfFileUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)huggingface\.co$/i.test(u.hostname)) return url;
    const parts = u.pathname.split('/');
    // `/<owner>/<repo>/blob/...`（datasets などの頭が付いても、最初の blob だけ直す）
    const at = parts.indexOf('blob');
    if (at < 3) return url;
    parts[at] = 'resolve';
    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return url;
  }
}
