/**
 * llama-server を自前で用意する。
 *
 * これまでは PATH にある `llama-server` を呼んでいた。
 * つまり実体は LM Studio などが入れたもので、**それを消されたら動かない**。
 * 他人の同梱物に相乗りする作りは、道具として成立しない。
 *
 * リポジトリに実体を入れる手もあるが、CUDA 版まで含めると数百MBになる。
 * 取ってくる先は公式のリリースだけにして、置き場は ~/.aas/bin に固定する。
 * 一度取ってくれば、あとは手元だけで動く。
 */
import { mkdir, writeFile, chmod, readdir, stat, rm, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pickAsset, pickCudart, PINNED_TAG, RELEASES_API, type Target } from './llama-release.ts';
import { explainExitCode } from './llama-diagnosis.ts';
import { binDir } from '../core/home.ts';
import { unzip } from './unzip.ts';
import { runtimeEnv } from './llama-env.ts';
import { chunkReader } from '../core/text.ts';
import { describeNet } from './net-why.ts';
import { isAbsent } from '../harness/put-back.ts';

/**
 * `llama-server --version` の出力が、版を答えているか。
 *
 * 出力に「version」が在るかで見ていた。動かなかったときの出力には、実行ファイルの場所（`app-version2/` のような名前）や、
 * GLIBC が合わないときの `` version `GLIBC_2.38' not found `` が入るので、動かないのに「動く」と言っていた。
 * 版の行（`version: 4585 (f0d4b29e)`）そのものを見る。
 */
export function answeredVersion(out: string): boolean {
  return /^version:\s*\d+/m.test(out);
}

export interface InstallOptions {
  /** 置き場。既定は ~/.aas/bin */
  binDir?: string;
  /** 取ってくる版。既定は固定した版 */
  tag?: string;
  target: Target;
  /** 進み具合。取得は分単位で待たせるので、黙らない。 */
  onProgress?: (line: string) => void;
  /** 取得の口。試験では差し替える。 */
  fetchImpl?: typeof fetch;
  /** GitHub の合言葉。無ければ環境（GITHUB_TOKEN / GH_TOKEN）。試験で差し替える */
  token?: string;
  /**
   * 動くかの確かめ方。既定は実際に一度起動する。
   *
   * 試験では差し替える。本物の llama-server をbundle として用意できないので、
   * 中身がただの文字列になる。Linux では execvp が ENOEXEC のとき /bin/sh へ
   * 落ちるため偶然動いていたが、Windows にその救済は無く ENOENT になる。
   * **偶然通っていたものは、通っていたとは言わない。**
   */
  verify?: (command: string, signal?: AbortSignal) => Promise<{ ok: boolean; detail: string }>;
  signal?: AbortSignal;
  /** 同じ版が在っても取り直す（在るのに動かないとき）。動く版は、新しい版が動くと確かめてから入れ替える。 */
  force?: boolean;
}

export interface Installed {
  /** llama-server の場所 */
  command: string;
  tag: string;
  /** 取ってきたbundle */
  asset: string;
  why: string;
}

export function defaultBinDir(): string {
  return binDir();
}

/**
 * 探す名前。
 *
 * `.bin` を入れてあるのは、会社のクラウドドライブが **名前を見て** .exe を
 * 落とすため（Z: で実測）。中身は同じで、名前だけが違う。
 * 名前で動かない道具にしない。
 */
export const SERVER_NAMES = ['llama-server', 'llama-server.exe', 'llama-server.bin'] as const;

/**
 * すでに用意してあるか。あればその場所。
 *
 * `strict` のときは、在るのに見られない（EACCES・EPERM 等）を「無い」と読まずに投げる。入れ直す道で使う。
 * 「無い」と読むと入れ直しに進み、それが途中で落ちると、後始末が元から在った同じ版のフォルダごと消す（動いていたものが消える）。
 * 表示（doctor・画面の状態）は今までどおり「無い」と読む。
 */
export async function findInstalled(binDir = defaultBinDir(), tag = PINNED_TAG, opts: { strict?: boolean } = {}): Promise<string | undefined> {
  // 見られないものがあっても、ほかの名前で見つかればそれを使う。どれも見つからず、見られないものがあったときだけ投げる
  let unseen: { path: string; e: unknown } | undefined;
  for (const name of SERVER_NAMES) {
    const p = join(binDir, tag, name);
    try {
      await stat(p);
      return p;
    } catch (e) {
      if (!isAbsent(e)) unseen ??= { path: p, e };
    }
  }
  if (opts.strict && unseen) {
    throw new Error(`置いてある llama-server（${unseen.path}）を見られません（${(unseen.e as NodeJS.ErrnoException).code ?? (unseen.e as Error).message}）。消さずに残してあります。少し置いてからもう一度試してください`);
  }
  return undefined;
}

/**
 * 用意する。すでにあれば、取りに行かない。
 *
 * 途中で失敗したら、中途半端に置いたものを片づける。
 * 半分だけ置かれた実行ファイルは、無いより悪い。
 */
export async function install(opts: InstallOptions): Promise<Installed> {
  const binDir = opts.binDir ?? defaultBinDir();
  const tag = opts.tag ?? PINNED_TAG;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const dest = join(binDir, tag);

  const already = await findInstalled(binDir, tag, { strict: true });
  if (already && !opts.force) {
    log(`すでにあります: ${already}`);
    return { command: already, tag, asset: '(取得済み)', why: '既に用意されています' };
  }

  log(`リリースを調べます (${tag})`);
  // 合言葉があれば使う。無くても動くが、回数制限が緩くなる。
  // 試験では差し替える。環境のものが勝つのは元のまま（外から渡されたものが先）。
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const ask = (withToken: boolean) => fetchImpl(`${RELEASES_API}/tags/${tag}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'AdaptiveAIStudio',
      ...(withToken && token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: opts.signal,
  });
  let assets: Array<{ name: string; browser_download_url: string }> = [];
  let listed: string | undefined;
  let missing = false;
  try {
    let res = await ask(true);
    // 合言葉が通らない（期限切れ・別物）なら、無しで取り直す。リリースは
    // 誰でも読めるので、壊れた合言葉のせいで取れない、をなくす。実際に起きた。
    if (res.status === 401 && token) {
      log('GITHUB_TOKEN が通らないので（401）、無しで取り直します');
      res = await ask(false);
    }
    if (res.ok) {
      const release = await res.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
      assets = release.assets ?? [];
    } else if (res.status === 404) {
      // 版そのものが無い。名前を当てても外れるだけなので、ここで止める。
      missing = true;
    } else {
      listed = `一覧を取れませんでした (${res.status})`;
      assets = [];
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    listed = `一覧に繋がりません（${describeNet(e)}）`;
    assets = [];
  }
  if (missing) throw new Error(`リリースを調べられませんでした (404)。版 ${tag} は無いようです`);
  if (listed) {
    // api.github.com は塞がれていても、github.com のbundleそのものは通る回線がある
    // （この場所がそう。実測: 一覧は 403、bundle は 200）。名前の形は決まっている
    // ので、一覧なしに当てて取りに行く。
    log(`${listed}。名前を当てて取りに行きます`);
    assets = guessAssets(tag);
  }

  const choice = pickAsset(assets.map((a) => a.name), opts.target);
  if (!choice) {
    throw new Error(
      `この環境（${opts.target.platform}/${opts.target.arch}）に合うものが見つかりません。`
      + `\n候補: ${assets.map((a) => a.name).join(', ') || '(なし)'}`,
    );
  }
  const asset = assets.find((a) => a.name === choice.name)!;
  log(`選びました: ${choice.name}（${choice.why}）`);

  log('取ってきます（数分かかることがあります）');
  const dl = await fetchImpl(asset.browser_download_url, { signal: opts.signal }).catch((e: unknown) => {
    throw new Error(`取ってこられませんでした（${describeNet(e)}）。\n${llamaByHand(tag, binDir)}`);
  });
  if (!dl.ok) throw new Error(`取ってこられませんでした (${dl.status})。\n${llamaByHand(tag, binDir)}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  log(`取得しました: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);

  // CUDA 版は、それ単体では起動しない。実行時ライブラリを隣に置く。
  // ここを省くと、置いた実行ファイルが何も言わずに終わる（Windows は
  // DLL を解決できないと、標準エラーに何も出さずに落ちるため）。
  const cudartName = pickCudart(assets.map((a) => a.name), choice.name);
  let cudartBuf: Buffer | undefined;
  if (cudartName) {
    const ca = assets.find((a) => a.name === cudartName)!;
    log(`CUDA の実行時ライブラリも取ってきます: ${cudartName}`);
    const cd = await fetchImpl(ca.browser_download_url, { signal: opts.signal });
    if (!cd.ok) throw new Error(`CUDA の実行時ライブラリを取ってこられませんでした (${cd.status})`);
    cudartBuf = Buffer.from(await cd.arrayBuffer());
    log(`取得しました: ${(cudartBuf.length / 1024 / 1024).toFixed(1)}MB`);
  }

  /*
   * 一時フォルダへ展開し、動くと確かめてから版の名前へ付け替える。正式な場所へ直接書いていたので、展開の途中で止める
   * （Ctrl+C・強制終了）と、DLL の欠けた半端な版が「用意できています」になり、`--force` でも取り直せなかった。
   * 名前の末尾を `.tmp` にしておくと、残っても `clean` が拾う（1 時間より古いもの）。
   */
  const work = `${tag}.${process.pid}.tmp`;
  const staging = join(binDir, work);
  // 脇へ移した前の版は `.tmp` にしない。戻せずに残ったとき、clean が「取得の途中で切れたもの」として消す候補にするため
  const retired = join(binDir, `${tag}.${process.pid}.prev`);
  let moved = false;
  try {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
    log('展開します');
    const entries = unzip(buf);
    // bundle は build/bin/ の下に入っている。階層は捨てて平らに置く。
    // 実行ファイルは同じ場所にある共有ライブラリを見に行くため、
    // 散らかすと動かない。
    await mkdir(staging, { recursive: true });
    let found = false;
    for (const e of entries) {
      const name = entryFileName(e.path);
      if (!name) continue;
      let out = join(staging, name);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, e.data);
      // 置いたのに無いことがある。会社のクラウドドライブは .exe を
      // **黙って落とす**（書けたように見えて、実際には残らない）。
      // 名前を変えて置き直す。中身は同じなので、これで動く。
      if (/\.exe$/i.test(name) && !(await stat(out).catch(() => undefined))) {
        out = join(staging, name.replace(/\.exe$/i, '.bin'));
        await writeFile(out, e.data);
      }
      if (e.executable || /\.(exe|bin|sh)$/i.test(name) || !name.includes('.')) {
        await chmod(out, 0o755).catch(() => { /* Windows では意味を持たない */ });
      }
      if (/^llama-server(\.(exe|bin))?$/i.test(basename(out))) found = true;
    }

    if (!found) {
      const names = entries.map((e) => e.path).slice(0, 20).join(', ');
      throw new Error(`取ってきたものに llama-server が入っていません。中身: ${names}`);
    }

    // 実行時ライブラリも同じ場所へ平らに置く。実行ファイルは隣しか見ない。
    if (cudartBuf) {
      for (const e of unzip(cudartBuf)) {
        // 本体と同じ切り方にする。`/` だけで切ると、`\` 区切りの名前（Windows で作られた zip）が丸ごと名前になり、
        // Windows の join は `\` を区切りと読むので、`..\x.dll` が入れ先のフォルダの外へ出る
        const name = entryFileName(e.path);
        if (!name) continue;
        await writeFile(join(staging, name), e.data);
      }
    }

    const trial = (await findInstalled(binDir, work))!;

    // 置けたことと動くことは別。実際に一度動かして確かめる。
    // 共有ライブラリを見つけられずに落ちる状態で「用意できました」と
    // 言ってしまうと、次に困るのは使う人になる。
    log('動くか確かめます');
    const check = await (opts.verify ?? tryRun)(trial, opts.signal);
    if (!check.ok) {
      throw new Error(`置きましたが動きませんでした:\n${check.detail}`);
    }

    // 取り直し（`force`）なら、前の版を脇へ移してから付け替える。付け替えに失敗したら戻す
    if (await exists(dest)) { await renameRetry(dest, retired); moved = true; }
    await renameRetry(staging, dest);
    if (moved) await rm(retired, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    const command = (await findInstalled(binDir, tag))!;
    log(`置きました: ${command}`);
    return { command, tag, asset: choice.name, why: choice.why };
  } catch (e) {
    // 半分だけ置かれた状態を残さない。脇へ移した前の版は戻す
    await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    if (moved && !(await exists(dest).catch(() => true))) {
      const back = await renameRetry(retired, dest).then(() => true, () => false);
      if (!back) throw new Error(`${(e as Error).message}\n前の版を ${retired} から戻せませんでした。フォルダの名前を ${tag} に戻してください`);
    }
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (e: unknown) => {
    if (isAbsent(e)) return false;
    throw e;
  });
}

/** Windows では、ウイルス対策や索引作りが一瞬掴むと EPERM・EBUSY になる。少し待って付け替え直す */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try { await rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (tries >= 5 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 200 * (tries + 1)));
    }
  }
}

/** 一度だけ起動して、動くかを見る。 */
export async function tryRun(command: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = '';
    // 返らない版に備えて時間を区切る（区切らないと `llama` が終わらない）
    const child = spawn(command, ['--version'], { env: runtimeEnv(command), signal, timeout: 30_000 });
    // 流れごとに別の読み手。持ち越しを混ぜると、両方が化ける。
    const readOut = chunkReader();
    const readErr = chunkReader();
    child.stdout?.on('data', (b: Buffer) => { out += readOut(b); });
    child.stderr?.on('data', (b: Buffer) => { out += readErr(b); });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    // --version は版によって終了コードが違う。番号ではなく、版を言えたかで見る（doctor・selftest と同じ `answeredVersion`）。
    // 「何か言えたか」で見ていたので、`GLIBC_2.38' not found` のような起動の失敗も「動く」になっていた
    child.on('close', (code) => {
      const text = out.trim();
      resolve({
        ok: answeredVersion(out),
        // 「何も出力しませんでした」だけでは、次に何をすればいいか分からない。
        // Windows は必要な DLL が無いと、何も言わずに特定の番号で落ちる。
        // 番号を添えて、そこまで見分けられるようにする。
        detail: text || `何も出力せず、終了コード ${code ?? '不明'} で終わりました${explainExitCode(code)}`,
      });
    });
  });
}

/** 置き場に何が入っているか。doctor から見せるため。 */
export async function listInstalled(binDir = defaultBinDir()): Promise<string[]> {
  try {
    return (await readdir(binDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !/\.(tmp|prev)$/.test(d.name)) // 取得の途中・入れ替えの途中のものは版ではない
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}


/**
 * 一覧が取れないときに当てる名前。
 *
 * llama.cpp のbundle の名前は `llama-<版>-bin-<os>-<変種>-<cpu>.zip` で決まっている
 * （b4585 で実測: win-avx2-x64 / win-cuda-cu12.4-x64 / ubuntu-x64 / macos-arm64 が 200）。
 * 無い名前は 404 で返るだけなので、当てて外れても害は無い。
 */
export function guessAssets(tag: string): Array<{ name: string; browser_download_url: string }> {
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/`;
  const names = [
    `llama-${tag}-bin-win-avx2-x64.zip`,
    `llama-${tag}-bin-win-cuda-cu12.4-x64.zip`,
    'cudart-llama-bin-win-cu12.4-x64.zip',
    `llama-${tag}-bin-ubuntu-x64.zip`,
    `llama-${tag}-bin-ubuntu-arm64.zip`,
    `llama-${tag}-bin-macos-arm64.zip`,
    `llama-${tag}-bin-macos-x64.zip`,
  ];
  return names.map((name) => ({ name, browser_download_url: base + name }));
}

/**
 * 手で取る道。
 *
 * この道具から届かなくても、ブラウザからなら届く機械がある。
 * 開く先（リリースの頁）と、置く先（bin\\<版>\\）を、そのまま貼れる形で言う。
 */
export function llamaByHand(tag: string, binDir: string): string {
  return [
    '手で取るなら:',
    `  1. ブラウザで開く: https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,
    '  2. この機械に合う zip を落とす（Windows なら llama-bin-win-avx2-x64.zip、NVIDIA なら cuda 付き）',
    `  3. 展開した中身をここに置く: ${join(binDir, tag)}`,
    '  （.exe が置けない場所では、llama-server.exe を llama-server.bin に名前を変えて置く）',
  ].join('\n');
}

/**
 * 書庫の項目名から、置く名前だけを取り出す。
 *
 * 散らかさないよう、どの階層にあっても平らに置く。区切りは `/` だけで
 * なく `\\` も見る。`a\\..\\..\\x` という名前を `/` で切ると丸ごと一語になり、
 * Windows ではそれが道として解釈されて、置き場の外へ出る。
 * 点だけの名前（`.` `..`）は置かない。
 */
export function entryFileName(entryPath: string): string | undefined {
  const name = entryPath.split(/[\\/]/).at(-1) ?? '';
  // 点と空白だけの名前（`..` `...` `.. `）も置かない。Windows は名前の末尾の点と空白を落とすので、`...` は `..` になりうる
  if (!name || /^[. ]+$/.test(name)) return undefined;
  return name;
}
