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

export const TASKS: Record<string, string> = {
  doctor: 'この環境を見てもらう',
  test: '検査を回す',
  selftest: 'この機械で確かめる',
  clean: '溜まったものを片づける',
  models: '手元のモデルを見る',
};

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
}

/**
 * 一度に一つだけ回す。
 *
 * 並べて回すと、どちらの出力か分からなくなる。分けて見せる作りにするより、
 * 一つに絞るほうが、読む側の負担が小さい。
 */
export class TaskRunner {
  readonly #opts: TaskRunnerOptions;
  #child?: ChildProcess;
  #name = '';

  constructor(opts: TaskRunnerOptions) {
    this.#opts = opts;
  }

  /** いま回しているものの名前。回していなければ undefined。 */
  get running(): string | undefined {
    return this.#child ? this.#name : undefined;
  }

  /** 一覧。画面に並べるためのもの。 */
  static list(): { id: string; name: string }[] {
    return Object.entries(TASKS).map(([id, name]) => ({ id, name }));
  }

  /**
   * 回す。受け取れない名前と、二重の呼び出しは、理由を返して何もしない。
   * 戻り値が undefined なら始まった。
   */
  start(name: string): string | undefined {
    if (!(name in TASKS)) return 'そういう点検はありません';
    if (this.#child) return `${this.#name} を回しています`;

    // 決めた名前を、そのまま src/cli/<名前>.ts として起こす。
    // 検査だけは走らせ役が別にいる（環境ごとの差をそこへ閉じ込めてある）。
    const file = name === 'test'
      ? join(this.#opts.root, 'scripts', 'run-tests.mjs')
      : join(this.#opts.root, 'src', 'cli', `${name}.ts`);

    const start = this.#opts.spawnFn ?? spawn;
    const child = start(process.execPath, ['--no-warnings', file], {
      cwd: this.#opts.root,
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.#child = child;
    this.#name = name;

    this.#opts.onEvent({ name, text: `— ${TASKS[name]} —\n` });
    const on = (b: Buffer) => this.#opts.onEvent({ name, text: stripAnsi(b.toString()) });
    child.stdout?.on('data', on);
    child.stderr?.on('data', on);
    child.on('error', (e) => this.#opts.onEvent({ name, text: `${e.message}\n` }));
    child.on('close', (code) => {
      this.#child = undefined;
      this.#name = '';
      this.#opts.onEvent({ name, code: code ?? 1 });
    });
    return undefined;
  }

  /** 止める。回していなければ何もしない。 */
  stop(): string | undefined {
    const was = this.running;
    this.#child?.kill();
    return was;
  }
}
