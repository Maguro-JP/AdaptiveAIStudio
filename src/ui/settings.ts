/**
 * 画面から変えてよい設定。
 *
 * **設定ファイル全部を書けるようにしない。**画面から任意の JSON を
 * 書き込めると、設定という顔をして道具の振る舞いを丸ごと差し替えられる。
 * 変えたい理由がはっきりしているものだけを、ここに挙げる。
 */
import { readFile, stat, mkdir } from 'node:fs/promises';
import { writeWhole } from '../core/journal-file.ts';
import { inOrder } from '../core/in-order.ts';
import { withFileLock } from '../core/file-lock.ts';
import { dirname, resolve } from 'node:path';
import { configPath } from '../config.ts';
import { modelsDir, modelsDir as defaultModelsDir } from '../core/home.ts';
import { isAbsent } from '../harness/put-back.ts';

/**
 * 動かし方。**先頭が既定。**
 *
 * 「この中で読む」は、何も入れずに GGUF を一つ置くだけで動く。初めて開いた人は
 * これで使い始める。Ollama と llama.cpp は速さを取りたい人が自分で選ぶもの
 * （別のものを入れる手間と引き換え。いまはそちらの方が速く、安定している）。
 * 最後には「この中で読む」も同じだけ安定させて、負荷も下げる。
 */
export const RUNTIME_KINDS = ['inproc', 'ollama', 'llamacpp'] as const;

export type RuntimeKind = typeof RUNTIME_KINDS[number];

export const KIND_LABELS: Record<string, string> = {
  inproc: 'この中で読む（既定） — GGUF を置くだけ。何も入れなくて動く',
  ollama: 'Ollama（速さ重視） — 別に入れた Ollama へ繋ぐ',
  llamacpp: 'llama.cpp（速さ重視） — llama-server を起こす。実行ファイルが1つ増える',
};

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === 'string' && (RUNTIME_KINDS as readonly string[]).includes(value);
}

/**
 * 書き換える前に、今の設定を読む。**無いときだけ空から始める。**
 *
 * ここは読めなければ何であれ `{}` から始めていたので、手で書き損じた設定（カンマ一つ）や、一瞬掴まれて読めなかった
 * 設定を、画面で一つ変えただけで丸ごと上書きして消した。設定は利用者が書くファイルなので、脇へ移しもしない。
 * 壊れている・読めない・入れ物でないときは、書き換えずに理由を投げる（画面に出る）。先頭の BOM は外して読む。
 */
async function configForEdit(at: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(at, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`設定（${at}）が読めないので、書き換えませんでした（${(e as NodeJS.ErrnoException).code ?? String(e)}）。少し待ってからもう一度押してください`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`設定（${at}）の JSON が壊れているので、書き換えませんでした（${(e as Error).message}）。ファイルを直してから、もう一度押してください`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`設定（${at}）が { } で囲んだ形ではないので、書き換えませんでした。ファイルを直してから、もう一度押してください`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * 読んでから書くまでを、設定ファイルごとに一列に並べる。並べないと、ランタイムの保存と繋ぎ先の保存が同時に走ったとき、
 * 後から書いた方が、先に書いた変更を知らない古い中身で上書きして消す。`change` が `next` を返さなければ書かない。
 */
function editConfig<T>(change: (current: Record<string, unknown>, at: string) => { next?: Record<string, unknown>; result: T }): Promise<T> {
  const at = configPath();
  // 書く側（writeWhole）も同じファイルの名前で並ぶので、別の名前で並べる（同じ名前だと、自分の書き込みを待ち続ける）
  // 別のプロセス（端末の `aas agent` の connect_service など）とも並ぶ。並ばないと、後から書いた方が先の変更を知らずに上書きして消す
  return inOrder(`${at}#edit`, () => withFileLock(at, async () => {
    const { next, result } = change(await configForEdit(at), at);
    if (next) await writeConfig(at, next);
    return result;
  }));
}

/** 書く。一時ファイルから付け替える（途中で落ちても、前の設定が残る）。 */
async function writeConfig(at: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(at), { recursive: true });
  if (!await writeWhole(at, `${JSON.stringify(value, null, 2)}\n`)) {
    throw new Error(`設定（${at}）を書けませんでした。少し待ってからもう一度押してください`);
  }
}

/**
 * 保存してある設定の runtime だけを読む。無ければ空。**読めなければ投げる。**
 *
 * 読めないのを空と読むと、画面に既定の保存先を見せ、画面はモデルを切り替えるたびにそれを送り返すので、
 * 利用者が決めた保存先（D:\models など）を黙って既定へ書き戻していた（立ち上げ直すと「モデルが無い」になる）。
 * 形の壊れた設定は空とする（書く側は厳しく読み直して断るので、上書きはしない）。
 */
export async function readSavedRuntime(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath(), 'utf8');
  } catch (e) {
    if (isAbsent(e)) return {};
    throw new Error(`設定（${configPath()}）を読めません（${(e as Error).message}）。少し待ってから開き直してください`);
  }
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
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
  return editConfig((current, at) => {
    const runtime: Record<string, unknown> = { ...objectOr(current.runtime), kind };
    // 既定の保存先と同じ道は書かない（消す）。画面は既定の道を絶対の道で見せてそのまま送り返すので、書くと既定が固定され、
    // portable のフォルダを移す・名前を変えると、古い場所を指したまま「GGUF がありません」になっていた（AAS_MODELS_DIR で立てた値も同じ）
    if (modelsDir && !sameDir(modelsDir, defaultModelsDir())) runtime.modelsDir = modelsDir;
    else delete runtime.modelsDir;
    if (model !== undefined) {
      if (model) runtime.model = model;
      else delete runtime.model;
    }
    return { next: { ...current, runtime }, result: at };
  });
}

/** 二つの道が同じ場所を指すか（区切りと末尾の区切りの違い、Windows では大小の違いを見ない）。中身は見ない。 */
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    const r = resolve(p.trim());
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * 貼った道の前後の引用符を外す。Windows の「パスのコピー」は `"C:\Users\me\proj"` の形で取るので、そのまま保存すると
 * 引用符ごと道になり、「そこは見つかりません」の原因が分からなかった（作業場の「無ければ作る」では、引用符で始まる名前のフォルダを作った）
 */
export function unquotePath(p: string): string {
  const t = p.trim();
  const m = /^(["'])(.*)\1$/s.exec(t);
  return m ? m[2]!.trim() : t;
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
  MISSING: 'そのフォルダはまだありません。作ってから .gguf を入れてください。',
  NOT_A_DIR: 'それはフォルダではなくファイルです。フォルダを指してください。',
  UNREADABLE: 'そのフォルダは読めませんでした（権限か、繋がっていないドライブ）。',
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
    // ファイルの下にフォルダは作れない。linux は ENOTDIR で分かるが、Windows は
    // ENOENT で返すので「無い」に見える。親を遡って、ファイルに当たれば NOT_A_DIR。
    let at = dirname(dir);
    for (let i = 0; i < 64 && at !== dirname(at); i++) {
      const st = await stat(at).catch(() => undefined);
      if (st) { if (!st.isDirectory()) return 'NOT_A_DIR'; break; }
      at = dirname(at);
    }
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
  return editConfig((current, at) => { // 無ければ、これが最初の一つ
    const mcp = objectOr(current.mcp) as { servers?: Record<string, unknown> };
    // 画面から触らない項目（startupTimeoutMs など、手で足したもの）は引き継ぐ。丸ごと置き換えて消していた
    const { command: _c, args: _a, url: _u, envFrom: _e, headersFrom: _h, enabled: _n, ...kept } = objectOr(objectOr(mcp.servers)[name]);
    const servers = { ...objectOr(mcp.servers), [name]: { ...kept, ...spec } };
    return { next: { ...current, mcp: { ...mcp, servers } }, result: at };
  });
}

/**
 * 繋いだものを外す。
 *
 * **合言葉は消さない。**繋ぎ直すたびに打ち直させることになる。
 * 消したいときは置き場の .env を直に触ってもらう（そこに在ると言ってある）。
 */
/**
 * 設定から一つ外す。**在ったかどうかを返す。**
 *
 * ここは `delete` して必ず成功を返していた。**一度も繋いでいない id でも
 * 「外しました」**になる。打ち間違いが、外れた事実として返ってくる。
 */
export async function removeMcpServer(name: string): Promise<{ path: string; removed: boolean }> {
  return editConfig<{ path: string; removed: boolean }>((current, at) => {
    const mcp = objectOr(current.mcp) as { servers?: Record<string, unknown> };
    const servers = { ...objectOr(mcp.servers) };
    if (!Object.prototype.hasOwnProperty.call(servers, name)) return { result: { path: at, removed: false } };
    delete servers[name];
    return { next: { ...current, mcp: { ...mcp, servers } }, result: { path: at, removed: true } };
  });
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
  return editConfig((current, at) => {
    const agent: Record<string, unknown> = { ...objectOr(current.agent) };
    if (root) agent.root = root;
    else delete agent.root;
    return { next: { ...current, agent }, result: at };
  });
}

/**
 * 設定に書いてある外のツール（MCP）。名前 → 書いてある形。
 * ファイルが無い・読めない・一覧の項目が無いときは undefined（「一つも無い」とは分ける。書いていないものを空で上書きしない）。
 */
export async function readSavedMcpServers(): Promise<Record<string, Record<string, unknown>> | undefined> {
  try {
    const raw = JSON.parse((await readFile(configPath(), 'utf8')).replace(/^\uFEFF/, '')) as { mcp?: { servers?: unknown } };
    if (raw.mcp?.servers === undefined) return undefined;
    const servers = objectOr(raw.mcp.servers);
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(servers)) out[k] = objectOr(v);
    return out;
  } catch {
    return undefined;
  }
}

/** 設定に書いてある外のツール（MCP）。読めなければ空。 */
export async function savedMcpServers(): Promise<Record<string, Record<string, unknown>>> {
  return (await readSavedMcpServers()) ?? {};
}

/** 書いてある作業場。無ければ空。 */
export async function savedWorkRoot(): Promise<string> {
  try {
    const raw = JSON.parse((await readFile(configPath(), 'utf8')).replace(/^\uFEFF/, '')) as { agent?: { root?: unknown } };
    return typeof raw.agent?.root === 'string' ? raw.agent.root : '';
  } catch {
    return '';
  }
}

/** 入れ物ならそれ、違えば空（`null` の項目を広げて止まらない）。 */
function objectOr(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** 保存してある繋ぎ先の形（無い・読めないなら undefined）。繋ぎ直すときに、前の形（手元か遠くか）を保つために見る。 */
export async function savedMcpServer(name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const current = await configForEdit(configPath());
    const servers = objectOr(objectOr(current.mcp).servers);
    const spec = servers[name];
    return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
