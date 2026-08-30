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
import { readGguf } from './gguf.ts';
import type { CatalogEntry } from './model-catalog.ts';

const HF_API = 'https://huggingface.co/api/models';
const HF_FILES = 'https://huggingface.co';

export interface ModelInstallOptions {
  entry: CatalogEntry;
  modelsDir: string;
  onProgress?: (line: string) => void;
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

  log(`一覧を調べます: ${entry.repo}`);
  const meta = await fetchImpl(`${HF_API}/${entry.repo}`, { signal: opts.signal });
  if (!meta.ok) {
    if (meta.status === 404) throw new Error(`配布元が見つかりません: ${entry.repo}`);
    // 403 は理由が複数ある。番号だけ出しても、次に何をすればいいか分からない。
    if (meta.status === 401 || meta.status === 403) {
      throw new Error(
        `配布元に断られました (${meta.status})。次のどれかです。\n`
        + '  ・そのモデルが利用同意を求めている（配布元のページで同意すると取れます）\n'
        + '  ・回線側で huggingface.co が塞がれている\n'
        + '  ・問い合わせ回数の上限（少し待つと戻ります）',
      );
    }
    throw new Error(`一覧を調べられませんでした (${meta.status})`);
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

  await mkdir(modelsDir, { recursive: true });
  const dest = join(modelsDir, file.split('/').at(-1)!);
  // 途中のものは別名で置く。中断されたものを「ある」と数えないため。
  const tmp = `${dest}.part`;

  log(`取ってきます（約${entry.approxGB}GB。回線によっては数十分かかります）`);
  const res = await fetchImpl(`${HF_FILES}/${entry.repo}/resolve/main/${file}`, {
    redirect: 'follow', signal: opts.signal,
  });
  if (!res.ok) throw new Error(`取ってこられませんでした (${res.status})`);

  const total = Number(res.headers.get('content-length') ?? 0);
  const handle = await open(tmp, 'w');
  let written = 0;
  let lastShown = 0;

  try {
    // 全部をメモリに載せない。数GB を抱えると、それだけで動かなくなる機械がある。
    for await (const chunk of streamOf(res)) {
      await handle.write(chunk);
      written += chunk.byteLength;
      const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
      if (total > 0 && pct >= lastShown + 10) {
        lastShown = pct;
        log(`  ${pct}%（${(written / 1024 ** 3).toFixed(1)}GB / ${(total / 1024 ** 3).toFixed(1)}GB）`);
      }
    }
  } finally {
    await handle.close();
  }

  if (total > 0 && written !== total) {
    await rm(tmp, { force: true });
    throw new Error(`途中で切れました（${written} / ${total} バイト）。もう一度実行してください。`);
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
