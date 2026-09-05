/**
 * 画面から変えてよい設定。
 *
 * **設定ファイル全部を書けるようにしない。**画面から任意の JSON を
 * 書き込めると、設定という顔をして道具の振る舞いを丸ごと差し替えられる。
 * 変えたい理由がはっきりしているものだけを、ここに挙げる。
 */
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath } from '../config.ts';
import { modelsDir } from '../core/home.ts';

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
  /** 使う GGUF の名前。undefined なら触らない、空文字なら消す。 */
  model?: string,
): Promise<string> {
  const at = configPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
  } catch { /* まだ無い */ }
  const runtime: Record<string, unknown> = { ...(current.runtime as Record<string, unknown> ?? {}), kind };
  if (modelsDir) runtime.modelsDir = modelsDir;
  else delete runtime.modelsDir;
  if (model !== undefined) {
    if (model) runtime.model = model;
    else delete runtime.model;
  }
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
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'MISSING';
    // 途中にファイルが挟まっている（C:\a.txt\models のような形）。
    // 「読めません」ではなく「フォルダではない」が正しい。
    if (code === 'ENOTDIR') return 'NOT_A_DIR';
    return 'UNREADABLE';
  }
}

export const DIR_NOTES: Record<DirState, string> = {
  OK: '',
  MISSING: 'その置き場はまだありません。作ってから .gguf を入れてください。',
  NOT_A_DIR: 'それはフォルダではなくファイルです。フォルダを指してください。',
  UNREADABLE: 'その置き場は読めませんでした（権限か、繋がっていないドライブ）。',
};

/**
 * 既定の置き場だけは、無ければ作る。
 *
 * 「GGUF を置くだけ」と言っておいて、**置く場所が無い**のはおかしい。
 * ただし作るのは**こちらが決めた場所だけ**。利用者が打った場所は作らない
 * （打ち間違いをそのまま作ると、間違ったフォルダが増えていく）。
 * 作れなくても止めない。言うだけにする。
 */
export async function ensureDefaultModelsDir(dir: string): Promise<DirState> {
  try {
    await mkdir(dir, { recursive: true });
    return 'OK';
  } catch {
    return inspectModelsDir(dir);
  }
}

/**
 * いま「置き場」として見せている場所。
 *
 * 画面の一覧は**保存してある**置き場を読む。取ってくる先も同じでないと、
 * 保存した直後に取ってきたものが古い置き場に落ち、「置いたのに出ない」になる。
 * 見せる場所と落とす場所は、ここ一つで決める。
 */
export async function savedModelsDir(): Promise<string> {
  const saved = await readSavedRuntime();
  const dir = typeof saved.modelsDir === 'string' ? saved.modelsDir.trim() : '';
  return dir || modelsDir();
}

/**
 * 外の道具（MCP）を1つ、設定に書き足す。
 *
 * **触ると決めたところだけを書き換える。**丸ごと書き直すと、
 * 画面から見えない設定を消してしまう（runtime のときと同じ）。
 * 合言葉は名前だけを書く。値は置き場の `.env` にある。
 *
 * @returns 書いた場所
 */
export async function saveMcpServer(
  name: string,
  spec: {
    command?: string; args?: string[]; url?: string;
    envFrom?: Record<string, string>; headersFrom?: Record<string, string>; enabled?: boolean;
  },
): Promise<string> {
  const at = configPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
  } catch { /* 無ければ、これが最初の一つ */ }
  const mcp = (current.mcp ?? {}) as { servers?: Record<string, unknown> };
  const servers = { ...(mcp.servers ?? {}), [name]: spec };
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, `${JSON.stringify({ ...current, mcp: { ...mcp, servers } }, null, 2)}\n`, 'utf8');
  return at;
}

/**
 * 繋いだものを外す。
 *
 * **合言葉は消さない。**繋ぎ直すたびに打ち直させることになる。
 * 消したいときは置き場の .env を直に触ってもらう（そこに在ると言ってある）。
 */
export async function removeMcpServer(name: string): Promise<string> {
  const at = configPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
  } catch { return at; }
  const mcp = (current.mcp ?? {}) as { servers?: Record<string, unknown> };
  const servers = { ...(mcp.servers ?? {}) };
  delete servers[name];
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, `${JSON.stringify({ ...current, mcp: { ...mcp, servers } }, null, 2)}\n`, 'utf8');
  return at;
}

/**
 * 作業場を書く。**入れた版では、これが無いと何も始まらない。**
 *
 * 入れて開くと、作業場は根の下の `work`（空）になる。そこで正しいのだが、
 * **自分の仕事場を開く道が画面に無かった。**入れた人は `aas.config.json`
 * を手で書くしかなく、それは「押せばいい入口」を用意した意味を消す。
 *
 * 空文字で消す（既定に戻る）。
 */
export async function saveWorkRoot(root: string): Promise<string> {
  const at = configPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
  } catch { /* まだ無い */ }
  const agent: Record<string, unknown> = { ...(current.agent as Record<string, unknown> ?? {}) };
  if (root) agent.root = root;
  else delete agent.root;
  await writeFile(at, `${JSON.stringify({ ...current, agent }, null, 2)}\n`, 'utf8');
  return at;
}

/** 書いてある作業場。無ければ空。 */
export async function savedWorkRoot(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as { agent?: { root?: unknown } };
    return typeof raw.agent?.root === 'string' ? raw.agent.root : '';
  } catch {
    return '';
  }
}
