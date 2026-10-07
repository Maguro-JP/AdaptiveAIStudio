/**
 * 点検を回す。
 *
 * cmd の窓は入口であって、道具ではない。立ち上げたあとに窓が塞がると、
 * 見たいものが見られなくなる。だから回すのも読むのも画面側でやる。
 *
 * ここに書いた名前だけを受け取る。**package.json の scripts を
 * そのまま実行できる作りにしない。**書き換えた者が何でも走らせられる
 * 口になるため。殻にも渡さない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chunkReader } from '../core/text.ts';
import { needsStripFlag } from '../core/node-flags.ts';
import { stamp, writeFresh } from '../cli/report-file.ts';
import { setPriority } from 'node:os';
import { killTree } from '../agent/shell-exec.ts';

/** 点検を一群として起こすか（POSIX だけ。Windows は taskkill /T で子孫を辿る） */
const OWN_GROUP = process.platform !== 'win32';

export const TASKS: Record<string, string> = {
  doctor: 'この環境を見てもらう',
  test: '検査を回す',
  selftest: 'この機械で確かめる',
  clean: '溜まったものを片づける',
  models: '手元のモデルを見る',
};

/**
 * 点検の子プロセスを、後ろに下げる。
 *
 * 診断（テスト・doctor）は CPU を全部使う。同じ機械でモデルが答えている
 * 最中に回すと、モデルの側が止まって「返事が来ない」になる（CPU は一つ）。
 * 点検は待てるが、返事は待てない。**点検の側が譲る。**
 *
 * 10 は Windows では BELOW_NORMAL、linux/mac では nice 10。
 * 下げられない環境（権限）でも点検は回す。下げたかどうかだけ返す。
 */
export function lowerPriority(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    setPriority(pid, 10);
    return true;
  } catch {
    return false;
  }
}

/** 出力を残す上限。テストは数千行になるが、それでも数 MB には届かない。 */
const KEEP_BYTES = 8 * 1024 * 1024;

/**
 * これ以下の行数しか出していない回は、残さない。
 * 「— 片づける —」「片づけるものはありません。」の 2〜3 行だけの回を弾く。
 */
const REPORT_MIN_LINES = 4;

/**
 * 端末むけの色指定を落とす。
 *
 * cli 側は端末に色を付ける。画面へそのまま流すと `[36m` が並んで読めない。
 * 出す側を全部直して回るより、**受ける側で一度だけ落とす**。
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface TaskEvent {
  name: string;
  /** 出てきたもの。終わったときは undefined。 */
  text?: string;
  /** 終わったときの終了コード。 */
  code?: number;
}

export interface TaskRunnerOptions {
  /** 中身のある場所（app/ に当たる）。ここから src/cli や scripts を見る。 */
  root: string;
  onEvent: (event: TaskEvent) => void;
  /** 起こし方。試験では差し替える。 */
  spawnFn?: typeof spawn;
  /** 判断に使う Node の版。試験で差し替える。既定は動いている Node */
  nodeVersion?: string;
  /**
   * 出力を残すフォルダ。渡せば、回すたびに `<名前>-<時刻>.txt` を置く。
   * 画面は古い行を捨てるし、閉じれば消える。困ったときに送るものは、ここから拾う。
   */
  reportsDir?: string;
}

/**
 * 点検を回す。**同じものは二重に回さない。別のものは並べて回す。**
 *
 * ここまで子は一つだけで、doctor を回している間は test も回せなかった。
 * 診断は CPU を分け合うので速くはならないが、**片方が終わるまで待たされない**。
 * 出てくるものはどれも `name` を添えて流すので、画面は名前で仕分けられる。
 *
 * **同じ名前を二度**は断る（同じ点検を二本走らせても、出力が混ざるだけで
 * 何も得しない）。名前ごとに一本まで。
 */
export class TaskRunner {
  readonly #opts: TaskRunnerOptions;
  /** 名前 → 動いている子。名前ごとに一本まで。 */
  readonly #children = new Map<string, ChildProcess>();
  /** 名前 → 始めた時刻。裏の仕事の一覧で「何秒経った」を出すため。 */
  readonly #startedAt = new Map<string, number>();
  /**
   * 子は閉じたが、報告を書き終えて終わりを知らせるまでの名前。終わりを知らせるまでは「動いている」と答える。
   * 閉じた時点で外すと、その間の「止める」は「動いていない」と答え、同じ名前の新しい回が始まって、古い回の終わりの知らせが
   * 新しい回を終わったことにした（知らせにどの回のものかを持たない）。
   */
  readonly #finishing = new Set<string>();

  constructor(opts: TaskRunnerOptions) {
    this.#opts = opts;
  }

  /** いま回しているものの名前。無ければ空。 */
  get running(): string[] {
    return [...this.#children.keys(), ...this.#finishing];
  }

  /** その点検が動いているか。 */
  isRunning(name: string): boolean {
    return this.#children.has(name) || this.#finishing.has(name);
  }

  /** いつ始めたか（ms）。動いていなければ undefined。 */
  startedAt(name: string): number | undefined {
    return this.isRunning(name) ? this.#startedAt.get(name) : undefined;
  }

  /** 一覧。画面に並べるためのもの。 */
  static list(): { id: string; name: string }[] {
    return Object.entries(TASKS).map(([id, name]) => ({ id, name }));
  }

  /**
   * 回す。受け取れない名前と、**同じ名前の二重**は、理由を返して何もしない。
   * 別の名前は、動いていても並べて始める。戻り値が undefined なら始まった。
   */
  start(name: string): string | undefined {
    // `in` は継いだ名前（constructor・toString・__proto__）も通すので、自分で持つ名前だけを見る
    if (!Object.hasOwn(TASKS, name)) return 'そういう点検はありません';
    if (this.isRunning(name)) return `${name} は既に回しています`;

    // 決めた名前を、そのまま src/cli/<名前>.ts として起こす。
    // 検査だけは走らせ役が別にいる（環境ごとの差をそこへ閉じ込めてある）。
    const file = name === 'test'
      ? join(this.#opts.root, 'scripts', 'run-tests.mjs')
      : join(this.#opts.root, 'src', 'cli', `${name}.ts`);

    const start = this.#opts.spawnFn ?? spawn;
    // 旗が要る Node（22.6〜22.17 など）では、付けないと .ts を起こせない。
    // 画面の点検が「文法の誤り」で落ちて、何も分からない。
    const flags = needsStripFlag(this.#opts.nodeVersion ?? process.versions.node)
      ? ['--experimental-strip-types'] : [];
    const child = start(process.execPath, [...flags, '--no-warnings', file], {
      cwd: this.#opts.root,
      // POSIX では一群として起こし、止めるときに子孫ごと止める（`run-tests.mjs` の下の `node --test` が管を持ったまま残り、
      // 止めても終わりの知らせが来ず、もう一度押すと「既に回しています」と断られ、孫は走り続けた）
      detached: OWN_GROUP,
      // doctor / selftest は自分で報告を置く。置き先を state/reports に揃えると、
      // サポート用レポートが直近の doctor を使い回せる（毎回 1〜2 分回さない）。
      env: {
        ...process.env,
        NO_COLOR: '1',
        ...(this.#opts.reportsDir ? { AAS_REPORT_DIR: this.#opts.reportsDir } : {}),
      },
    });
    this.#children.set(name, child);
    this.#startedAt.set(name, Date.now());
    // モデルが答えている最中に回しても、モデルの側を止めない。
    // 二本並べても、どちらも譲る（CPU をモデルに残す）。
    lowerPriority(child.pid);

    this.#opts.onEvent({ name, text: `— ${TASKS[name]} —\n` });
    const kept: string[] = [];
    let keptBytes = 0;
    const keep = (text: string) => {
      if (keptBytes > KEEP_BYTES) return;
      kept.push(text);
      keptBytes += text.length;
    };
    // 二つの流れに一つの読み手を使い回さない。持ち越しが混ざって両方化ける。
    const on = (read: (c: Buffer) => string) => (b: Buffer) => {
      const text = stripAnsi(read(b));
      keep(text);
      this.#opts.onEvent({ name, text });
    };
    child.stdout?.on('data', on(chunkReader()));
    child.stderr?.on('data', on(chunkReader()));
    child.on('error', (e) => this.#opts.onEvent({ name, text: `${e.message}\n` }));
    child.on('close', (code) => {
      this.#children.delete(name);
      this.#finishing.add(name);
      const finish = () => {
        this.#finishing.delete(name);
        this.#opts.onEvent({ name, code: code ?? 1 });
      };
      const dir = this.#opts.reportsDir;
      // 自分の報告は自分で置く（doctor / selftest）。ここで二重に置かない。
      if (!dir || name === 'doctor' || name === 'selftest') { finish(); return; }
      /*
       * **何も起きていない回の報告は、残さない。**
       *
       * 「片づけるものはありません」の一行のために txt を置いていた。押すたびに
       * 増えるので、片づけるためのツールが片づける対象を作る形になっていた。
       * 残すのは、うまくいかなかった回（終了コードが立った）と、
       * 読むだけの中身がある回だけ。
       */
      const meat = kept.join('');
      const worth = (code ?? 1) !== 0 || meat.split('\n').filter((l) => l.trim()).length > REPORT_MIN_LINES;
      if (!worth) { finish(); return; }
      const base = `${name}-${stamp()}`;
      const body = `${meat}${keptBytes > KEEP_BYTES ? '\n（長すぎるので途中までです）\n' : ''}\n— 終了コード ${code ?? 1} —\n`;
      void this.#save(name, dir, base, body).catch(() => undefined).finally(finish);
    });
    return undefined;
  }

  /** 出力を置く。置けたか置けなかったかを、流れに言う。 */
  async #save(name: string, dir: string, base: string, body: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      // 同じ名前が在れば `-2` を足す（名前は分までなので、同じ分に二度回すと前の報告を黙って上書きしていた。端末の報告と同じ書き方）
      const at = await writeFresh(dir, base, body);
      this.#opts.onEvent({ name, text: `\n残しました: ${at}\n` });
    } catch (e) {
      this.#opts.onEvent({ name, text: `\n（残せませんでした: ${(e as Error).message}）\n` });
    }
  }

  /**
   * 止める。名前を渡せばそれだけ、渡さなければ全部。
   * 止めたものの名前を返す（回していなければ空）。
   */
  stop(name?: string): string[] {
    if (name !== undefined) {
      // 閉じて報告を書いている最中のものは、もう止まっている。終わりの知らせはこの後に来る
      if (this.#finishing.has(name)) return [name];
      const child = this.#children.get(name);
      if (!child) return [];
      this.#kill(child);
      return [name];
    }
    const was = this.running;
    for (const child of this.#children.values()) this.#kill(child);
    return was;
  }

  /** 子孫ごと止める（Windows では taskkill /T）。試験から渡した起こし方（偽物）は、その子だけを止める */
  #kill(child: ChildProcess): void {
    if (this.#opts.spawnFn) child.kill();
    else killTree(child);
  }
}
