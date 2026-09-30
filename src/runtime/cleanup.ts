/**
 * 溜まったものを片づける。
 *
 * 使っているうちに、要らないものが確実に増える。
 *
 *   ・llama-server の古い版（1つ 150MB〜、cudart を含めると 500MB 超）
 *   ・取得の途中で切れたファイル（.part）
 *   ・古い記録
 *
 * 放っておくと、**気づいたときには数GB**になる。しかも増えているものが
 * 何なのか利用者からは見えない。だから、何をどれだけ消すのかを先に見せ、
 * 消した量を必ず言う。
 *
 * **黙って消さない。**消す物を決めるのはこちらだが、
 * 消したことを隠すと、次に何かが無くなったときに疑う先が増える。
 */
import { readdir, stat, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { binDir, modelsDir, stateDir } from '../core/home.ts';

/**
 * 同じ名前の記録を、これだけ残す。
 *
 * **押すたびに一つ増えて、減るものが無かった。**作業場に
 * doctor-20260912-1126.txt が 37 個並び、横の一覧がそれで埋まった（実機）。
 * 押した人が欲しいのは直前の一つで、半年前のものではない。
 */
export const KEEP_REPORTS = 10;

/** 記録の名前の形。`<名前>-YYYYMMDD-HHMM.txt`（report-file.ts が付ける）。 */
const REPORT_NAME = /^([a-z][a-z0-9-]*)-\d{8}-\d{4}\.txt$/;

export interface Removable {
  path: string;
  bytes: number;
  /** なぜ要らないのか。人に見せる。 */
  why: string;
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path).catch(() => undefined);
  if (!s) return 0;
  if (s.isFile()) return s.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) {
    total += await sizeOf(join(path, name));
  }
  return total;
}

/**
 * 消せるものを挙げる。**消さない。**
 *
 * 挙げるのと消すのを分けておくと、「何が消えるのか」だけを先に見せられる。
 */
export async function findRemovable(opts: {
  keepTag: string;
  maxLogAgeMs?: number;
  maxAttachmentAgeMs?: number;
  now?: number;
} ): Promise<Removable[]> {
  const found: Removable[] = [];
  const now = opts.now ?? Date.now();
  const maxLogAge = opts.maxLogAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxAttachmentAge = opts.maxAttachmentAgeMs ?? 24 * 60 * 60 * 1000;

  // 古い llama-server。使っている版だけ残す。
  for (const name of await readdir(binDir()).catch(() => [])) {
    if (name === opts.keepTag) continue;
    // b で始まる版の形だけを対象にする。知らない名前は触らない。
    if (!/^b\d+$/.test(name)) continue;
    const path = join(binDir(), name);
    found.push({ path, bytes: await sizeOf(path), why: `古い llama-server（いまは ${opts.keepTag}）` });
  }

  // 途中で切れた取得。**捨てると、続きから取れなくなる**（もう一度実行すれば
  // 続きから取る作りにしてある）。それでも要らないなら片づけられるよう、
  // 何を捨てることになるかを添える。
  for (const dir of [modelsDir(), binDir()]) {
    for (const name of await readdir(dir).catch(() => [])) {
      // .part.tag は途中の分がどの版かの記録。途中の分と一緒に片づける
      if (!/\.(part|partial|tmp)(\.tag)?$/i.test(name)) continue;
      const path = join(dir, name);
      // いま取っている最中のものは消さない（書き続けているので新しい）。1 時間より古いものだけ
      const s = await stat(path).catch(() => undefined);
      if (!s || now - s.mtimeMs < 60 * 60 * 1000) continue;
      found.push({
        path, bytes: await sizeOf(path),
        why: '取得の途中で切れたもの（消すと、続きからではなく最初から取り直しになります）',
      });
    }
  }

  /*
   * 会話の見出しを書き戻すときの一時ファイル（`<id>.jsonl.<pid>.<番号>.tmp`）。置き換えられずに残ったもの。
   * 書いている最中のものを消さないよう、1 時間より古いものだけ。
   */
  const talks = join(stateDir(), 'conversations');
  for (const name of await readdir(talks).catch(() => [])) {
    if (!/\.jsonl\.\d+\.\d+\.tmp$/.test(name)) continue;
    const path = join(talks, name);
    const s = await stat(path).catch(() => undefined);
    if (!s || now - s.mtimeMs < 60 * 60 * 1000) continue;
    found.push({ path, bytes: s.size, why: '会話の見出しを書き換えたときに残った一時ファイル' });
  }

  /*
   * 状態のファイル（記憶・やり残し・段取り・了解・ハーネスの記録・戻り先）を置き換えるときの一時ファイル。置き換えられずに
   * 残ったもの。名前は `<元の名前>.<pid>.<番号か英数字（一つ以上）>.tmp`。会話と同じく、書いている最中のものを消さないよう 1 時間より古いものだけ。
   */
  const STATE_TMP = /^(?:(?:memory|unfinished|goals)\.jsonl|(?:acks|harness-metrics|metrics|idle|duties|stride|layout|theme|roles-ledger|aas\.config)\.json)\.\d+(?:\.[a-z0-9]+)+\.tmp$/;
  const UNDO_TMP = /\.json\.\d+\.\d+\.tmp$/;
  const undoDir = join(stateDir(), 'undo');
  for (const [dir, shape] of [[stateDir(), STATE_TMP], [undoDir, UNDO_TMP]] as const) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!shape.test(name)) continue;
      const path = join(dir, name);
      const s = await stat(path).catch(() => undefined);
      if (!s || !s.isFile() || now - s.mtimeMs < 60 * 60 * 1000) continue;
      found.push({ path, bytes: s.size, why: '覚えておくファイルを書き換えたときに残った一時ファイル' });
    }
  }

  /*
   * 壊れていたので脇へ移した写し（`<名前>.broken-<時刻>`、`src/core/journal-file.ts` と提案の記録が作る）。
   * 中身を手で拾うためのものなので、すぐには消さない。**古いものだけ**（記録と同じ 30 日）。ここに載せるまで、壊れるたびに
   * 溜まって誰も片づけなかった。
   */
  const BROKEN = /\.broken-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
  for (const name of await readdir(stateDir()).catch(() => [])) {
    const m = BROKEN.exec(name);
    if (!m) continue;
    const path = join(stateDir(), name);
    const s = await stat(path).catch(() => undefined);
    if (!s || !s.isFile()) continue;
    /*
     * **古さは、名前に入れた移した時刻で数える。**写しは名前の付け替えで作るので、最終更新は元のファイルを最後に書いた
     * 時刻のまま。長く書き換えていなかった設定（並び・見た目）が壊れると、移したその日に「40日前の写し」として挙がり、
     * `--yes` で消えた（画面では「元のファイルは残しています」と言っているのに）。読めない時刻なら最終更新に戻す。
     */
    const movedAt = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    const since = Number.isFinite(movedAt) ? movedAt : s.mtimeMs;
    if (now - since < maxLogAge) continue;
    found.push({ path, bytes: s.size, why: `壊れていたので脇へ移した ${Math.floor((now - since) / 86_400_000)}日前の写し（中身を手で拾うためのもの）` });
  }

  /*
   * どの作業場のものか分からない古い戻り先（作業場の根を持たない）。
   * どの作業場の「戻す」にも出ないので、戻す手にならないまま残り続ける。**根を持つものは消さない**
   * （今の作業場のものでなくても、その作業場へ戻れば使う）。読めないもの・形の違うものも触らない。
   *
   * **古いものだけ**（記録と同じ 30 日）。根を持たせる前の版がまだ動いていれば、根の無い戻り先を今も書き、
   * その版の画面では使える。中身は利用者のファイルの前の姿で、ほかに写しは無い。
   */
  for (const name of await readdir(undoDir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const path = join(undoDir, name);
    const s = await stat(path).catch(() => undefined);
    if (!s || !s.isFile() || now - s.mtimeMs < maxLogAge) continue;
    let point: unknown;
    try { point = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (typeof point !== 'object' || point === null || typeof (point as { id?: unknown }).id !== 'string') continue;
    if ((point as { root?: unknown }).root !== undefined) continue;
    found.push({ path, bytes: s.size, why: `どの作業場のものか分からない ${Math.floor((now - s.mtimeMs) / 86_400_000)}日前の戻り先（どの作業場の「戻す」にも出ません。消すと、その前の姿には戻せません）` });
  }

  // 古い記録。新しいものは残す（直近の様子は見たいことがある）。
  const logs = join(stateDir(), 'logs');
  for (const name of await readdir(logs).catch(() => [])) {
    const path = join(logs, name);
    const s = await stat(path).catch(() => undefined);
    // フォルダは記録ではない（消すと中身ごと消える。更新時刻もフォルダ自身のもので、中身の古さではない）
    if (!s || !s.isFile() || now - s.mtimeMs < maxLogAge) continue;
    const days = Math.floor((now - s.mtimeMs) / 86_400_000);
    found.push({ path, bytes: s.size, why: `${days}日前の記録` });
  }

  // 渡された添付。その依頼が終われば要らない。**ここに載せるまで、誰も
  // 消していなかった**（sweep は書いてあったが、呼ぶ所が無かった）。
  const attachments = join(stateDir(), 'attachments');
  for (const name of await readdir(attachments).catch(() => [])) {
    const path = join(attachments, name);
    const s = await stat(path).catch(() => undefined);
    // 添付は一つずつのファイル。フォルダは添付ではない（attachments.ts の sweep と同じ）
    if (!s || !s.isFile() || now - s.mtimeMs < maxAttachmentAge) continue;
    found.push({ path, bytes: s.size, why: '前に渡した添付（1日以上前）' });
  }

  /*
   * 古い記録（doctor-…・test-…・report-… の txt）。
   *
   * **出す仕組みだけ在って、減らす仕組みが無かった。**同じ名前の新しい方から
   * KEEP_REPORTS 件を残し、それより古いものを挙げる。
   *
   * 見るのは記録の保存先だけ。**作業場（productRoot）は見ない。**
   * 利用者のコードが置いてある場所なので、こちらの判断でファイルを消す場所
   * ではない。記録の置き先を保存先へ移したので、ここから先は溜まらない。
   */
  for (const dir of [join(stateDir(), 'reports'), stateDir()]) {
    const byName = new Map<string, string[]>();
    for (const name of await readdir(dir).catch(() => [])) {
      const m = REPORT_NAME.exec(name);
      if (!m) continue;
      const list = byName.get(m[1]!) ?? [];
      list.push(name);
      byName.set(m[1]!, list);
    }
    for (const [prefix, names] of byName) {
      // 名前は `-YYYYMMDD-HHMM` で終わるので、**名前の順が時刻の順**。
      names.sort();
      for (const name of names.slice(0, Math.max(0, names.length - KEEP_REPORTS))) {
        const path = join(dir, name);
        const s = await stat(path).catch(() => undefined);
        if (!s) continue;
        found.push({ path, bytes: s.size, why: `古い ${prefix} の記録（新しい ${KEEP_REPORTS} 件は残します）` });
      }
    }
  }

  return found.sort((a, b) => b.bytes - a.bytes);
}

/** 実際に消す。消せなかったものは、消せなかったと言う。 */
export async function remove(items: Removable[]): Promise<{ freed: number; failed: string[] }> {
  let freed = 0;
  const failed: string[] = [];
  for (const item of items) {
    try {
      await rm(item.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      freed += item.bytes;
    } catch {
      // 使用中で消せないことがある（Windows）。黙らない。
      failed.push(item.path);
    }
  }
  return { freed, failed };
}

export function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}GB`
    : `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 人に見せる形。消す前に必ず出す。 */
export function describe(items: Removable[]): string {
  if (items.length === 0) return '片づけるものはありません。';
  const total = items.reduce((n, i) => n + i.bytes, 0);
  const lines = [`片づけると ${mb(total)} 空きます`, ''];
  for (const i of items.slice(0, 20)) {
    lines.push(`  ${mb(i.bytes).padStart(7)}  ${i.path}`);
    lines.push(`           ${i.why}`);
  }
  if (items.length > 20) lines.push(`  …ほか ${items.length - 20} 件`);
  return lines.join('\n');
}
