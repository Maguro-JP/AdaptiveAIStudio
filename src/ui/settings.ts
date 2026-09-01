/**
 * 画面から変えてよい設定。
 *
 * **設定ファイル全部を書けるようにしない。**画面から任意の JSON を
 * 書き込めると、設定という顔をして道具の振る舞いを丸ごと差し替えられる。
 * 変えたい理由がはっきりしているものだけを、ここに挙げる。
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { configPath } from '../config.ts';

export const RUNTIME_KINDS = ['ollama', 'llamacpp', 'inproc'] as const;

export type RuntimeKind = typeof RUNTIME_KINDS[number];

export const KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama — 別に立てたものへ繋ぐ',
  llamacpp: 'llama.cpp — llama-server を起こす（実行ファイルが1つ増える）',
  inproc: 'この中で読む — GGUF を置くだけ（実行ファイルは増えない）',
};

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === 'string' && (RUNTIME_KINDS as readonly string[]).includes(value);
}

/** 保存してある設定の runtime だけを読む。無ければ空。 */
export async function readSavedRuntime(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
    return (raw.runtime as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * 触ると決めたところだけを書き換える。
 *
 * 丸ごと書き直すと、**画面から見えない設定を消してしまう。**
 * 既にあるものを読んでから、決めた2つだけを差し替える。
 */
export async function saveRuntime(
  kind: RuntimeKind,
  modelsDir: string,
): Promise<string> {
  const at = configPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
  } catch { /* まだ無い */ }
  const runtime = { ...(current.runtime as Record<string, unknown> ?? {}), kind };
  if (modelsDir) runtime.modelsDir = modelsDir;
  else delete runtime.modelsDir;
  await writeFile(at, `${JSON.stringify({ ...current, runtime }, null, 2)}\n`, 'utf8');
  return at;
}

/** 置き場そのものの状態。語形の変わらない符丁で返し、表示のときに引き直す。 */
export type DirState = 'OK' | 'MISSING' | 'NOT_A_DIR' | 'UNREADABLE';

/**
 * 置き場を、保存する前に見る。
 *
 * **打ち間違えた置き場を、黙って受け取らない。**保存はできてしまうので、
 * 立ち上げ直すまで誰も気づかず、モデルが出ないことだけが残る。
 * 拒みはしない（後から作る人がいる）。**言う。**
 */
export async function inspectModelsDir(dir: string): Promise<DirState> {
  if (!dir) return 'OK'; // 既定の置き場を使う、という意味。見るところが無い
  try {
    const s = await stat(dir);
    return s.isDirectory() ? 'OK' : 'NOT_A_DIR';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'UNREADABLE';
  }
}

export const DIR_NOTES: Record<DirState, string> = {
  OK: '',
  MISSING: 'その置き場はまだありません。作ってから .gguf を入れてください。',
  NOT_A_DIR: 'それはフォルダではなくファイルです。フォルダを指してください。',
  UNREADABLE: 'その置き場は読めませんでした（権限か、繋がっていないドライブ）。',
};
