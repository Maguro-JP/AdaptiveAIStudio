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
import { mkdir, writeFile, chmod, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickAsset, PINNED_TAG, RELEASES_API, type Target } from './llama-release.ts';
import { unzip } from './unzip.ts';
import { runtimeEnv } from './llama-env.ts';

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
  signal?: AbortSignal;
}

export interface Installed {
  /** llama-server の場所 */
  command: string;
  tag: string;
  /** 取ってきた配布物 */
  asset: string;
  why: string;
}

export function defaultBinDir(): string {
  return process.env.AAS_BIN_DIR ?? join(homedir(), '.aas', 'bin');
}

/** すでに用意してあるか。あればその場所。 */
export async function findInstalled(binDir = defaultBinDir(), tag = PINNED_TAG): Promise<string | undefined> {
  for (const name of ['llama-server', 'llama-server.exe']) {
    const p = join(binDir, tag, name);
    try {
      await stat(p);
      return p;
    } catch { /* 無い */ }
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

  const already = await findInstalled(binDir, tag);
  if (already) {
    log(`すでにあります: ${already}`);
    return { command: already, tag, asset: '(取得済み)', why: '既に用意されています' };
  }

  log(`リリースを調べます (${tag})`);
  // 合言葉があれば使う。無くても動くが、回数制限が緩くなる。
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetchImpl(`${RELEASES_API}/tags/${tag}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    // 403/429 は回数制限。「ネットワークを確認」と言われても、
    // 繋がっているので何をすればいいか分からない。
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        'GitHub の問い合わせ回数の上限に当たりました（1時間あたり60回）。'
        + '\n少し待つか、GITHUB_TOKEN を設定してから、もう一度実行してください。',
      );
    }
    throw new Error(`リリースを調べられませんでした (${res.status})。ネットワークを確認してください。`);
  }
  const release = await res.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
  const assets = release.assets ?? [];

  const choice = pickAsset(assets.map((a) => a.name), opts.target);
  if (!choice) {
    throw new Error(
      `この環境（${opts.target.platform}/${opts.target.arch}）に合う配布物が見つかりません。`
      + `\n候補: ${assets.map((a) => a.name).join(', ') || '(なし)'}`,
    );
  }
  const asset = assets.find((a) => a.name === choice.name)!;
  log(`選びました: ${choice.name}（${choice.why}）`);

  log('取ってきます（数分かかることがあります）');
  const dl = await fetchImpl(asset.browser_download_url, { signal: opts.signal });
  if (!dl.ok) throw new Error(`取ってこられませんでした (${dl.status})`);
  const buf = Buffer.from(await dl.arrayBuffer());
  log(`取得しました: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);

  try {
    log('展開します');
    const entries = unzip(buf);
    // 配布物は build/bin/ の下に入っている。階層は捨てて平らに置く。
    // 実行ファイルは同じ場所にある共有ライブラリを見に行くため、
    // 散らかすと動かない。
    await mkdir(dest, { recursive: true });
    let found = false;
    for (const e of entries) {
      const name = e.path.split('/').at(-1)!;
      if (!name) continue;
      const out = join(dest, name);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, e.data);
      if (e.executable || /\.(exe|sh)$/i.test(name) || !name.includes('.')) {
        await chmod(out, 0o755).catch(() => { /* Windows では意味を持たない */ });
      }
      if (name === 'llama-server' || name === 'llama-server.exe') found = true;
    }

    if (!found) {
      const names = entries.map((e) => e.path).slice(0, 20).join(', ');
      throw new Error(`配布物に llama-server が入っていません。中身: ${names}`);
    }

    const command = (await findInstalled(binDir, tag))!;

    // 置けたことと動くことは別。実際に一度動かして確かめる。
    // 共有ライブラリを見つけられずに落ちる状態で「用意できました」と
    // 言ってしまうと、次に困るのは使う人になる。
    log('動くか確かめます');
    const check = await tryRun(command, opts.signal);
    if (!check.ok) {
      throw new Error(`置きましたが動きませんでした:\n${check.detail}`);
    }

    log(`置きました: ${command}`);
    return { command, tag, asset: choice.name, why: choice.why };
  } catch (e) {
    // 半分だけ置かれた状態を残さない。
    await rm(dest, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    throw e;
  }
}

/** 一度だけ起動して、動くかを見る。 */
async function tryRun(command: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, ['--version'], { env: runtimeEnv(command), signal });
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    // --version は版によって終了コードが違う。番号ではなく、
    // 「起動できて何か言えたか」で見る。
    child.on('close', () => {
      const failed = /error while loading shared libraries|cannot open shared object|not a valid|is not recognized/i.test(out);
      resolve({ ok: !failed && out.trim().length > 0, detail: out.trim() || '何も出力しませんでした' });
    });
  });
}

/** 置き場に何が入っているか。doctor から見せるため。 */
export async function listInstalled(binDir = defaultBinDir()): Promise<string[]> {
  try {
    return (await readdir(binDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
