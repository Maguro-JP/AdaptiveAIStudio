/**
 * 先読み — 利用者が考えている間に、状況把握を済ませておく。
 *
 * ローカルは計算が無料なので、待機中に何もしないのは損失。
 * 依頼が来てからファイル一覧を取り、gitを見て、テストの流し方を調べるのでは、
 * 最初の数ターンが「調査」で消える。
 *
 * それを起動直後から裏で走らせ、依頼が来た瞬間には
 * 「このプロジェクトはこうなっている」を渡せる状態にしておく。
 */
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectGit, type GitState } from './git.ts';
import { toDisplayPath } from './tools/paths.ts';

export interface ProjectSnapshot {
  /** ファイル一覧（作業ディレクトリからの相対パス） */
  files: string[];
  /** 直近に更新されたファイル。着手点の手がかりになる。 */
  recentFiles: Array<{ path: string; modifiedAt: number }>;
  git?: GitState;
  /** package.json 等から推定したテスト/ビルドコマンド */
  commands: { test?: string; build?: string; lint?: string };
  /** 検出したプロジェクト種別 */
  kind?: string;
  builtAt: number;
  /** 完了した項目 */
  ready: string[];
}

export type PrefetchEvent =
  | { type: 'start'; task: string }
  | { type: 'done'; task: string; ms: number }
  | { type: 'failed'; task: string; error: string };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);
const MAX_FILES = 3000;

export class Prefetcher {
  readonly #root: string;
  readonly #onEvent?: (e: PrefetchEvent) => void;
  #inFlight?: Promise<ProjectSnapshot>;
  #snapshot?: ProjectSnapshot;

  constructor(root: string, onEvent?: (e: PrefetchEvent) => void) {
    this.#root = root;
    this.#onEvent = onEvent;
  }

  /** 裏で走らせる。待たない。 */
  start(signal?: AbortSignal): void {
    if (this.#inFlight) return;
    this.#inFlight = this.#build(signal).then(
      (s) => { this.#snapshot = s; return s; },
      // 先読みの失敗で本体を止めない。無いなら無いで作業は始められる。
      () => ({
        files: [], recentFiles: [], commands: {},
        builtAt: Date.now(), ready: [],
      } satisfies ProjectSnapshot),
    );
  }

  /** 完了していれば即座に、途中なら完了を待って返す。 */
  async snapshot(): Promise<ProjectSnapshot | undefined> {
    if (this.#snapshot) return this.#snapshot;
    if (!this.#inFlight) return undefined;
    return this.#inFlight;
  }

  /** 今できている分だけ返す。待たない。 */
  peek(): ProjectSnapshot | undefined {
    return this.#snapshot;
  }

  /**
   * 上限つきで待つ。
   *
   * 依頼が来た時点でまだ構築中なら、少しだけ待つ。
   * 数百ミリ秒待つ方が、モデルが数ターンかけて調べ直すより遥かに速い。
   * 上限を超えたら諦めて先へ進む（構築自体は裏で続く）。
   */
  async snapshotWithin(ms: number): Promise<ProjectSnapshot | undefined> {
    if (this.#snapshot) return this.#snapshot;
    if (!this.#inFlight) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([this.#inFlight, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** ファイルを書き換えた後など、作り直す。 */
  invalidate(signal?: AbortSignal): void {
    this.#snapshot = undefined;
    this.#inFlight = undefined;
    this.start(signal);
  }

  async #build(signal?: AbortSignal): Promise<ProjectSnapshot> {
    const ready: string[] = [];

    const [index, git, project] = await Promise.all([
      this.#run('index', () => this.#buildIndex(signal), ready),
      this.#run('git', () => inspectGit(this.#root), ready),
      this.#run('commands', () => this.#detectProject(), ready),
    ]);

    return {
      files: index?.files ?? [],
      recentFiles: index?.recent ?? [],
      git,
      commands: project?.commands ?? {},
      kind: project?.kind,
      builtAt: Date.now(),
      ready,
    };
  }

  async #run<T>(task: string, fn: () => Promise<T>, ready: string[]): Promise<T | undefined> {
    const at = Date.now();
    this.#onEvent?.({ type: 'start', task });
    try {
      const result = await fn();
      ready.push(task);
      this.#onEvent?.({ type: 'done', task, ms: Date.now() - at });
      return result;
    } catch (e) {
      this.#onEvent?.({
        type: 'failed', task,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
  }

  async #buildIndex(signal?: AbortSignal) {
    const files: string[] = [];
    const stamps: Array<{ path: string; modifiedAt: number }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 12 || files.length >= MAX_FILES || signal?.aborted) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        if (SKIP_DIRS.has(e.name)) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs, depth + 1);
        else if (e.isFile()) {
          const rel = toDisplayPath(this.#root, abs);
          files.push(rel);
          const info = await stat(abs).catch(() => undefined);
          if (info) stamps.push({ path: rel, modifiedAt: info.mtimeMs });
        }
      }
    };

    await walk(this.#root, 0);
    stamps.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { files, recent: stamps.slice(0, 15) };
  }

  /** package.json などから、このプロジェクトの動かし方を推定する。 */
  async #detectProject(): Promise<{ kind?: string; commands: ProjectSnapshot['commands'] }> {
    const pkgRaw = await readFile(join(this.#root, 'package.json'), 'utf8').catch(() => undefined);
    if (pkgRaw) {
      let scripts: Record<string, unknown> = {};
      try {
        scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {};
      } catch { /* 壊れた package.json でも他の検出は続ける */ }
      const has = (name: string) => typeof scripts[name] === 'string';
      return {
        kind: 'Node.js',
        commands: {
          ...(has('test') ? { test: 'npm test' } : {}),
          ...(has('build') ? { build: 'npm run build' } : {}),
          ...(has('lint') ? { lint: 'npm run lint' } : {}),
        },
      };
    }

    const exists = async (name: string) =>
      (await stat(join(this.#root, name)).catch(() => undefined)) !== undefined;

    if (await exists('pyproject.toml')) return { kind: 'Python', commands: { test: 'pytest' } };
    if (await exists('Cargo.toml')) return { kind: 'Rust', commands: { test: 'cargo test', build: 'cargo build' } };
    if (await exists('go.mod')) return { kind: 'Go', commands: { test: 'go test ./...', build: 'go build ./...' } };
    return { commands: {} };
  }
}

/**
 * 作業者へ渡す要約。
 * 全ファイルを並べても読ませる意味が薄いので、着手に必要な分だけにする。
 */
export function describeSnapshot(s: ProjectSnapshot): string {
  if (s.ready.length === 0) return '';
  const lines: string[] = ['# 事前に調べたこの作業ディレクトリの状況', ''];

  if (s.kind) lines.push(`種別: ${s.kind}`);
  if (s.git?.kind === 'clean') lines.push(`git: ${s.git.branch}（未コミットの変更なし）`);
  else if (s.git?.kind === 'dirty') {
    lines.push(`git: ${s.git.branch}（未コミットの変更 ${s.git.changed.length} 件）`);
    lines.push(...s.git.changed.slice(0, 10).map((c) => `  ${c}`));
  } else if (s.git?.kind === 'notRepo') lines.push('git: 管理下ではありません');

  const cmds = Object.entries(s.commands).filter(([, v]) => v);
  if (cmds.length > 0) {
    lines.push('', '実行できるコマンド:');
    lines.push(...cmds.map(([k, v]) => `  ${k}: ${v}`));
  }

  if (s.files.length > 0) {
    lines.push('', `ファイル ${s.files.length} 件。直近に更新されたもの:`);
    lines.push(...s.recentFiles.slice(0, 10).map((f) => `  ${f.path}`));
  }

  lines.push('', 'この情報は既に取得済みです。同じことを調べ直す必要はありません。');
  return lines.join('\n');
}
