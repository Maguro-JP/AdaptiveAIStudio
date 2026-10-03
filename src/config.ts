/**
 * 設定。モデル名・URL・APIキーはすべてここに集約し、コードには一切書かない。
 * 探索順: 環境変数 AAS_CONFIG > ./aas.config.json（在れば） > 置き場（AAS_HOME）の aas.config.json > 既定値（この中で読む）
 */
import { readFileSync, existsSync } from 'node:fs';
import { INPROC_PORT } from './runtime/inproc.ts';
import { basename, resolve } from 'node:path';
import { loadEnvFile } from './core/env.ts';
import { aasHome } from './core/home.ts';

export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  /** openai-compatible のみ必須 */
  baseUrl?: string;
  locality: 'local' | 'cloud';
  /** 環境変数名。値そのものは書かない。 */
  apiKeyEnv?: string;
  models?: string[];
  /**
   * モデル一覧・生存確認の上限。既定2秒。
   *
   * ここは「相手が居るか」を見るだけの呼び出しで、生成とは違う。
   * 5秒で固定していたので、**繋ぎ先が黙って落とす形（LAN の向こう、
   * 塞がれた口）だと、セッションを作るたびに必ず5秒待った。**拒否が返る
   * 相手なら即返るので、待つのは繋がらないときだけ。
   * 遅い経路で足りなければ、ここを上げる。
   */
  listTimeoutMs?: number;
  /**
   * false なら登録も接続もしない。**省くと有効**（`enabledProviders`）。最初に書き出す設定では、クラウドの項目に
   * `enabled: false` を明示して「口だけ用意しておく」。自分で項目を足すなら、使わない間は false を書く。
   */
  enabled?: boolean;
}

export interface AasConfig {
  providers: ProviderConfig[];
  /**
   * 使用モデルを固定したい場合のみ指定する。
   * 省略すると自動操縦が、入っているモデルから最良を選び、
   * 実測に応じて裏で乗り換える。既定はこちら。
   *
   * 明示指定は検証・比較目的のための機能であり、通常運用では不要。
   */
  candidates?: string[];
  system?: string;
  /** 訊かれただけのときの決まり。作業者の決まりを問いに載せないため。 */
  chatSystem?: string;
  temperature?: number;
  maxTokens?: number;
  agent?: AgentConfig;
  runtime?: RuntimeConfig;
  /** ハーネス規則。モデルの誤りを実行前に止める。 */
  harness?: HarnessConfig;
  /** 自発的な調査と提案 */
  initiative?: InitiativeConfig;
  /**
   * 人員。役職ごとの気質・権限を上書き・追加できる。
   * 「こういう気質の担当がいたら拾えるはず」と思いついたときに、
   * コードを触らず配属するための入口。
   */
  roles?: RoleOverrideConfig[];
  /** 合議に参加させる役職 */
  panel?: PanelConfig;
  /** 外部情報の取得。 */
  network?: NetworkConfig;
  /** 外の道具（MCP）。GitHub もここに一つ足すだけで繋がる。 */
  mcp?: McpConfig;
}

export interface McpConfig {
  /** 既定は有効。servers が空なら、そもそも何も立ち上がらない。 */
  enabled?: boolean;
  /**
   * 繋ぐ相手。名前をこちらで決めて、道具の名前の頭に付ける。
   *
   * 合言葉は **envFrom で名前を書く**。設定ファイルに値そのものを書かせない。
   *
   *   "github": {
   *     "command": "npx",
   *     "args": ["-y", "@modelcontextprotocol/server-github"],
   *     "envFrom": { "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN" }
   *   }
   */
  servers?: Record<string, {
    /** 手元で立ち上げるとき。 */
    command?: string;
    args?: string[];
    /**
     * 遠くに繋ぐとき（Streamable HTTP）。
     * いま主要なところは、ほとんどこちら。
     */
    url?: string;
    envFrom?: Record<string, string>;
    /** 付ける見出し。**値ではなく名前で書く。** */
    headersFrom?: Record<string, string>;
    startupTimeoutMs?: number;
    /** false にすると、設定を消さずに切っておける。 */
    enabled?: boolean;
  }>;
  /** 1回の呼び出しの上限。既定60秒 */
  timeoutMs?: number;
}

export interface RoleOverrideConfig {
  id: string;
  extends?: string;
  name?: string;
  responsibility?: string;
  disposition?: string;
  access?: Array<'read' | 'write' | 'execute' | 'network' | 'mcp'>;
  instructions?: string[];
  outputContract?: string;
  prefers?: 'strong' | 'fast' | 'any';
}

export interface NetworkConfig {
  /**
   * 既定は有効。ただし行き先は許可リストに限られ、繋がらなくても作業は止まらない。
   * 完全に閉じたい場合のみ false にする。
   */
  enabled?: boolean;
  /** 行き先の許可リスト。省略時は開発の判断に必要な公開情報のみ。 */
  allowedHosts?: string[];
  /** 1回の取得で読む上限（文字数） */
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * 関所に立つ検査官（二段目）。
   * 当てはめ（一段目）で止まらなかったものを、道具を持たないモデルが検める。
   */
  inspector?: InspectorConfig;
}

export interface InspectorConfig {
  /** 既定で有効。使えるモデルが無ければ自動で置かれない。 */
  enabled?: boolean;
  /** 検査官として使うモデル。省略時は候補の中で速いものを使う。 */
  candidates?: string[];
  /** 一件にかけてよい時間。既定8秒 */
  timeoutMs?: number;
  /** 検査官に渡す最大文字数。越えたら頭と尻を見る。既定12000 */
  maxChars?: number;
}

export interface PanelConfig {
  /** 既定で参加させる役職。省略時は検査・破壊・安全の3名 */
  roles?: string[];
  /** 同時に走らせる人数。inproc の口は優先度「中」で借りるので、取り分（本数 − 半分切り上げ）を超えた分は口を待つ。既定の 2 本なら一人ずつ。 */
  parallel?: number;
}

export interface HarnessConfig {
  enabled?: boolean;
  /** 書き込みを禁じるパス（グロブ） */
  protectedPaths?: string[];
  /** 1つの依頼で書き換えられるファイル数の上限 */
  maxFilesPerTask?: number;
  /** これ以上のファイル数を書き換えるなら協議を通す。既定 8 */
  wideChangeFiles?: number;
  /** 既存ファイルを読まずに上書きするのを禁じる。既定 true */
  readBeforeWrite?: boolean;
  /** 監査ログの出力先 */
  auditLog?: string;
  /** 検証を打ち切ったとき変更を巻き戻す。既定 false（gitが本来の安全網のため） */
  rollbackOnGiveUp?: boolean;
}

export interface InitiativeConfig {
  /**
   * 自発的な思考。待機中に自分で考え、提案を溜める。
   * 提案は溜めるだけで、実行はしない。既定は有効。
   */
  enabled?: boolean;
  /** 入力が無いまま何秒経ったら考え始めるか。既定30秒 */
  idleSeconds?: number;
  /** 1回の調査で扱う手がかりの数 */
  leadsPerCycle?: number;
  /** 溜まった未処理の提案がこの数に達したら、それ以上は考えない */
  maxOpen?: number;
  /**
   * 1時間に使ってよい思考の総コスト。
   * 計算は無料でも、読む側の集中力は有限なので上限を置く。
   */
  budgetPerHour?: number;
  /**
   * 前の思考から、次の思考までに空ける最短の間隔（分）。既定10分。
   *
   * 予算だけでは「1時間ぶんを続けざまに使い切る」を止められない。
   * 読む側にとっては、1時間に6回より、数分で6回の方がずっとうるさい。
   */
  minGapMinutes?: number;
  /**
   * 同じ変更について、変更をきっかけに考えてよい回数。既定2回。
   * 一つの変更は見回り・巡回検査・振り返りの前提を同時に満たすため。
   */
  maxPerChange?: number;
  /** 使う思考モード。省略時は全部 */
  modes?: string[];
}

export interface RuntimeConfig {
  /**
   * ローカル推論の実行基盤。
   *   ollama   : 安定。日常運用（既定）
   *   llamacpp : 自前。オフロード層数を自分で決める。限界を攻める用途
   * 両方を並存させ、片方が壊ってももう片方で動くようにする。
   */
  /**
   * どうやってモデルを動かすか。
   *   ollama    別に立てたものへ繋ぐ
   *   llamacpp  llama-server を起こす（実行ファイルが一つ増える）
   *   inproc    このプログラムの中で読む（増えるのはライブラリだけ）
   *
   * 実行ファイルを置けない機械では inproc だけが道になる。
   */
  kind?: 'ollama' | 'llamacpp' | 'inproc';
  /** llamacpp: llama-server の実行パス */
  command?: string;
  /** llamacpp: command の直後に付ける固定引数（ラッパースクリプト経由の起動用） */
  commandArgs?: string[];
  /** llamacpp: GGUFファイルを置くディレクトリ */
  modelsDir?: string;
  /** llamacpp: 使用ポートの開始番号 */
  basePort?: number;
  /** 文脈の大きさ（トークン）。inproc のみ。既定 8192。広げるほど記憶を食う */
  contextSize?: number;
  /**
   * GPU を使うか。inproc のみ。既定 auto（cuda → vulkan → CPU の順に、動くものを使う）。
   * off は CPU だけ。GPU の道で落ちるときの逃げ道。使ったものは記録の
   * 「GPU で読みます / CPU で読みます」の行と doctor に出る。
   */
  gpu?: 'auto' | 'cuda' | 'vulkan' | 'off';
  /** 使う GGUF の名前（置き場の中の名前）。無ければ最初の一つ */
  model?: string;
  /**
   * 同時に何本の生成を並べるか。
   * - inproc: 会話ごとに一本貸す sequence の本数（既定 `DEFAULT_SEQUENCES`）。
   *   増やすほどコンテキストウィンドウ（一会話が覚えていられる長さ）は狭くなる（KV を分け合うため）。
   *   速さのための数ではない。CPU は分け合うので、増やすと一人あたりは遅くなる。
   *   2 本以上なら、半分（切り上げ）は最優先・優先のために空けておく（高・中・低は残りを使う）。
   * - llamacpp: レーンの並列度に合わせる。
   */
  parallel?: number;
  desiredContext?: number;
  /**
   * 常時ロード。使う見込みのモデルを起動時に温めておき、
   * 作業開始時の待ちをゼロにする。既定は有効。
   * 空いているVRAMは節約ではなく損失なので、既定で使い切る。
   */
  warm?: WarmConfig;
}

export interface WarmConfig {
  enabled?: boolean;
  /** 起動時に温めるモデル。省略時は自動選択の上位を温める。 */
  preload?: string[];
  /** 同時常駐数の上限 */
  maxResident?: number;
  /** 常駐に使ってよいVRAM比率(0〜1)。既定 0.95 */
  vramFraction?: number;
}

export interface AgentConfig {
  /** 作業ディレクトリ。ここより外へは触らせない。既定はカレント。 */
  root?: string;
  /**
   * 承認の求め方。
   *   ask      : 毎回聞く
   *   autoEdit : ファイル書き込みは自動承認、コマンド実行のみ聞く（既定）
   *   auto     : 全部自動（長時間の自律実行向け。gitでの巻き戻し前提）
   *
   * 自律実行が本題なので既定は autoEdit。
   * 安全網は git であり、開始前に未コミット変更を警告する。
   */
  approval?: 'ask' | 'autoEdit' | 'auto';
  /** run_command で許可するコマンドの先頭語 */
  allowedCommands?: string[];
  maxTurns?: number;
  /**
   * レーン。同時にロードしておくモデルの単位。
   * 並列度は「同時ロード数」ではなく「レーン内の同時タスク数」で稼ぐ。
   */
  lanes?: LaneSetting[];
  /** 全レーン合計の同時実行上限。CPU/メモリの保護用。 */
  maxTotalParallel?: number;
  /**
   * 自己検証ループ。作業後にテストを流し、失敗したら自分で直させる。
   * ローカルは計算が無料なので、時間で品質を買える。既定は有効。
   */
  verify?: VerifyConfig;
}

export interface VerifyConfig {
  enabled?: boolean;
  /** 検証コマンド。省略時は先読みが検出したテストコマンドを使う。 */
  command?: string;
  /** 最大の往復回数。既定5 */
  maxRounds?: number;
  /** ループ全体の時間上限(ms)。既定60分 */
  timeBudgetMs?: number;
  /** 1回のテスト実行の上限(ms)。既定10分 */
  commandTimeoutMs?: number;
  /**
   * 作業前にも検証を1回流し、元から壊れていたかを確かめる。既定は有効。
   * これが無いと、既存の失敗をこの作業のせいにして無駄に回すことになる。
   * テストが重い場合のみ false にする。
   *
   * 有効でも、同じ命令なら一度しか流さない（作業前の状態は作業では変わらない）。
   */
  baseline?: boolean;
  /**
   * ベースラインだけの時間上限(ms)。既定2分。
   * 全件が長い場合はここで切り上げ、「分からない」として扱う。
   */
  baselineTimeoutMs?: number;
  /** ベースラインの結果を覚えておく時間(ms)。既定30分。 */
  baselineMaxAgeMs?: number;
}

export interface LaneSetting {
  id: string;
  candidates: string[];
  parallel: number;
}

export const DEFAULT_CONFIG: AasConfig = {
  providers: [
    {
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      locality: 'local',
      // ローカルには単価が無いので、節約のために弱いモデルを既定にしない。
      // MoE は 30B級の質を 7B 並みの速度で出せるため、この環境の最適解。
      models: ['qwen3.6:35b-a3b-coding-nvfp4', 'qwen3.5:9b'],
      enabled: true,
    },
    // クラウドは既定で無効。使いたいときだけ enabled を true にする。
    {
      id: 'claude',
      kind: 'anthropic',
      locality: 'cloud',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude-opus-5'],
      enabled: false,
    },
  ],
  // candidates は既定で未指定。自動操縦に任せる。
  system: 'あなたは日本語で応答する開発支援アシスタントです。簡潔に、根拠とともに答えてください。',
  temperature: 0.2,
  maxTokens: 4096,
};

/**
 * 設定ファイルの場所。読むときと書くときで違う場所を見ないようにする。
 *
 * 画面から設定を変えられるようにしたので、**読んだ場所へ書き戻す**必要がある。
 * ここを二箇所に散らすと、書いたのに効かない、が起きる。
 */
export function configPath(cwd = process.cwd()): string {
  if (process.env.AAS_CONFIG) return process.env.AAS_CONFIG;
  // 開発の場所（リポジトリ）には隣に置いてある。それを先に見る。
  const beside = resolve(cwd, 'aas.config.json');
  if (existsSync(beside)) return beside;
  // 製品の形では、起動時の場所は app\ で、そこには置かない（更新で消える。
  // インストール先は書けない）。**データの置き場**に置く。画面からの保存も同じ所へ。
  return resolve(aasHome(), 'aas.config.json');
}

/**
 * runtime の空欄を、無いものとして扱う。
 *
 * 画面や見本から `"modelsDir": ""` が入ることがある。空文字は nullish では
 * ないので `?? 既定` を素通りし、置き場が「（空）」になる。
 */
function normalizeRuntime(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = { ...(raw as Record<string, unknown>) };
  if (typeof r.modelsDir === 'string' && r.modelsDir.trim() === '') delete r.modelsDir;
  return r as RuntimeConfig;
}

/*
 * 動かし方を書いていないときは、**設定が無いときと同じ道にする。**
 *
 * 設定ファイルが無ければ「この中で読む（inproc）」が既定。ところが、
 * ファイルは在るのに `runtime` を書いていないときは `{}` になり、以後
 * `?? 'ollama'` で Ollama 扱いになっていた。**同じ「書いていない」なのに、
 * ファイルの有無で行き先が変わる。**
 *
 * Ollama 扱いになると、モデルを取ってくる所も `ollama pull` へ行く。
 * 入れていない機械では必ず「Ollama に繋がりません」で終わり、
 * **GGUF を1つ置けば動く道があることに辿り着けない。**（実際にそうなった）
 *
 * ここで決めるのは、**読んだ設定の中身**だけ。土台を組む側
 * （`buildRuntime`）は触らない。渡された設定をそのまま使う所が多く、
 * そこを変えると「書いていない＝Ollama」を前提にした道まで巻き込む。
 */
function withDefaultKind(runtime: RuntimeConfig): RuntimeConfig {
  return runtime.kind ? runtime : { ...runtime, kind: 'inproc' };
}

/**
 * 設定の中身を読む。**壊れていたら、どこがどう壊れているかを言う。**
 *
 * ここは `JSON.parse` を直に呼んでいた。設定は手で書ける（`aas.config.json`）
 * ので、閉じ忘れや末尾のコンマは普通に起きる。そのとき出ていたのは
 *
 *   SyntaxError: Expected double-quoted property name in JSON at position 33
 *     at JSON.parse (<anonymous>) ...
 *
 * という Node のスタックだけ。**どのファイルの話かも書いていない。**
 * しかも落ちるのは、設定を読むところ——つまり `doctor`（困ったときに見る
 * もの）も、画面も、同じ所で死ぬ。**直しに行く手段まで一緒に塞がる。**
 * 「モデルが一つ無いだけで画面じゅうが 500 になる」と同じ形。
 *
 * ファイルの場所・何行目・その行そのもの・次の一手を出す。
 */
export class ConfigBroken extends Error {}

export function parseConfigText(raw: string, path: string): Partial<AasConfig> {
  try {
    // 先頭の BOM は外す（メモ帳などが付ける。付いたままだと、正しい設定でも起動時に「壊れている」と断っていた）
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AasConfig>;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const at = /position (\d+)/.exec(why);
    const lines = raw.slice(0, at ? Number(at[1]) : raw.length).split('\n');
    const lineNo = lines.length;
    const line = raw.split('\n')[lineNo - 1] ?? '';
    throw new ConfigBroken(
      `設定を読めません: ${path}\n`
      + `  ${lineNo} 行目のあたり: ${line.trim().slice(0, 80)}\n`
      + `  （${why}）\n`
      + '  よくあるのは、末尾のコンマと、閉じ忘れです。\n'
      // 消させない。名前を変えれば既定で動き、中身は残る（案内どおりに消した設定は戻らない）
      + `  直せないときは、このファイルの名前を変えれば（例: ${basename(path)}.bak）既定で動きます。中身は残るので、あとで直して戻せます。`,
    );
  }
}

export function loadConfig(cwd = process.cwd()): { config: AasConfig; source: string } {
  // 合言葉は置き場の .env から。設定には名前しか書かないので、値はここで揃える。
  // 設定を読む所は一つなので、ここに置けばどの入口（画面・doctor・cli）でも同じ。
  loadEnvFile(resolve(aasHome(), '.env'));
  const path = configPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    // **在るのに読めないのを「無い」と読まない。**読むと、利用者が書いた守り（protectedPaths・roles・mcp）と作業場を外した
    // 既定で黙って動く。壊れているときと同じく止めて言う（取り込みの循環を避けて、符丁をここで見る）
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new ConfigBroken(
        `設定を読めません: ${path}（${code ?? (e as Error).message}）\n`
        + '  ほかのプログラム（ウイルス対策・同期ソフト）が掴んでいるなら、少し置いてから立ち上げ直してください。\n'
        + '  読めるようになるまで、書いておいた守り・作業場・役職は効きません（黙って既定で動かさないため、ここで言います）。',
      );
    }
    // 設定が無いときは、この中で読む。二つ目の実行ファイルも Ollama も要らない道が既定。
    // （既定を Ollama にしていたので、製品の形で何もしないと「Provider が起動しているか」で止まっていた）
    const config: AasConfig = { ...structuredClone(DEFAULT_CONFIG), runtime: { kind: 'inproc' } };
    wireInProc(config);
    return { config, source: `既定値 (aas.config.json なし。書くなら ${path})` };
  }

  const parsed = parseConfigText(raw, path);
  const config: AasConfig = {
    /*
     * **書いてある項目は全部渡す（下で既定を埋める項目だけ上書きする）。**項目を一つずつ拾っていたので、拾い忘れた
     * `network`（外へ出る道を閉じる・行き先を足す）と `chatSystem` は、書いても黙って捨てていた。`network.enabled: false` と
     * 書いても外へ出る道は開いたままで、承認が自動なら訊かずに外へ取りに行っていた
     */
    ...parsed,
    // **既定をそのまま渡さない。**同じ物を返すと、あとで書き換えたときに
    // 既定そのものが書き換わり、次に読んだ設定にも残る（実際に起きた。
    // inproc の繋ぎ先を入れたら、別の設定を読んでも 4177 のままになった）。
    providers: parsed.providers ?? structuredClone(DEFAULT_CONFIG.providers),
    ...(parsed.candidates ? { candidates: parsed.candidates } : {}),
    system: parsed.system ?? DEFAULT_CONFIG.system,
    temperature: parsed.temperature ?? DEFAULT_CONFIG.temperature,
    maxTokens: parsed.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    agent: parsed.agent ?? {},
    runtime: withDefaultKind(normalizeRuntime(parsed.runtime)),
    harness: parsed.harness ?? {},
    initiative: parsed.initiative ?? {},
    roles: parsed.roles ?? [],
    panel: parsed.panel ?? {},
    mcp: parsed.mcp ?? {},
  };
  if (config.agent?.lanes) validateLanes(config);
  wireInProc(config);
  validate(config);
  return { config, source: path };
}

/**
 * この中で読む（inproc）ときの繋ぎ先を、こちらで埋める。
 *
 * 口はこのプログラムの中に立つので、**利用者が繋ぎ先を書く必要は無い**。
 * 書かせると、番号を間違えたときに「繋がりません」とだけ出て終わる。
 * 決め打ちの番号（INPROC_PORT）を、ここで入れておく。
 */
export function wireInProc(c: AasConfig): void {
  if (c.runtime?.kind !== 'inproc') return;
  const url = `http://127.0.0.1:${c.runtime.basePort ?? INPROC_PORT}/v1`;
  const at = c.providers.findIndex((p) => p.kind === 'openai-compatible' && p.locality === 'local');
  if (at < 0) {
    c.providers.push({
      id: 'inproc', kind: 'openai-compatible', locality: 'local', baseUrl: url, enabled: true,
    });
    return;
  }
  const local = c.providers[at]!;
  local.baseUrl = url;
  /*
   * **名前も付け替える。**
   *
   * ここは URL だけ書き換えていた。既定でそこに居るのは `id: 'ollama'` なので、
   * **中身は inproc なのに名前は ollama のまま**になる。
   *
   * 名前は下流のすべてに出る。モデルの名前は `ollama:...` になり、
   * 失敗したときは「ollama への接続に失敗しました」と出る。Ollama を
   * 使っていない人が、Ollama を疑うことになる。実際にそうなった。
   *
   * 利用者が自分で名前を付けているなら、それは触らない。
   * 付け替えるのは、こちらが既定として置いた `ollama` のときだけ。
   */
  if (local.id === 'ollama') {
    local.id = 'inproc';
    /*
     * **Ollama 向けのモデル名を持ち越さない。**
     *
     * 既定の項目には `qwen3.6:35b-a3b-coding-nvfp4` と `qwen3.5:9b` が
     * 書いてある。これは Ollama の名前で、この中で読む道には存在しない。
     *
     * `listModels()` は一覧が取れないとき、**設定に書いてある名前で続行する。**
     * 口がまだ立っていない一瞬にそれが起きると、実在しないモデルが候補になり、
     * 送るたびに繋がらない相手を叩き続けることになる。
     * 実際に、画面にはこの2つが候補として出ていた。
     *
     * この中で読む道では、口が自分の保存先の .gguf を答える。
     * **こちらで名前を書いておく必要は無い。**
     */
    delete local.models;
  }
}

/*
 * **直せる形で断る。**
 *
 * ここで普通の `Error` を投げていたので、`aas.config.json` の中身が一つでも
 * 食い違うと**画面がそもそも立ち上がらなかった**（理由は端末にだけ出る）。
 * 書き間違い（JSON の形）は `ConfigBroken` として画面を開ける作りにしてあるのに、
 * 中身の食い違いだけ、直しに行く手段ごと塞いでいた。同じ形で投げる。
 */
function validate(c: AasConfig): void {
  if (c.providers.length === 0) throw new ConfigBroken('providers が空です。');
  if (c.candidates && c.candidates.length === 0) {
    throw new ConfigBroken('candidates を空配列にはできません。自動選択に任せるなら項目ごと省いてください。');
  }
  for (const p of c.providers) {
    if (p.kind === 'openai-compatible') {
      if (!p.baseUrl) throw new ConfigBroken(`baseUrl が未設定です: ${p.id}`);
      // 利用者名・パスワード付きの URL は受けない（fetch が断り、その URL ごと失敗の文として画面と記録に出る）。API キーは apiKeyEnv で渡す
      if (hasUrlCredentials(p.baseUrl)) {
        throw new ConfigBroken(`baseUrl に利用者名やパスワードを書けません: ${p.id}（API キーは apiKeyEnv に環境変数の名前を書いて渡してください）`);
      }
    } else if (p.kind !== 'anthropic') {
      throw new ConfigBroken(`未対応の provider kind です: ${p.kind} (${p.id})`);
    }
  }
  const ids = new Set(enabledProviders(c).map((p) => p.id));
  for (const cand of c.candidates ?? []) {
    const providerId = cand.slice(0, cand.indexOf(':'));
    if (!ids.has(providerId)) {
      throw new ConfigBroken(
        `candidates の "${cand}" に対応する provider "${providerId}" が有効になっていません。` +
        ' 設定で enabled: true にしてください。',
      );
    }
  }
}

function validateLanes(c: AasConfig): void {
  const ids = new Set(enabledProviders(c).map((p) => p.id));
  for (const lane of c.agent?.lanes ?? []) {
    if (lane.parallel < 1) throw new ConfigBroken(`lane "${lane.id}" の parallel は1以上にしてください。`);
    if (lane.candidates.length === 0) throw new ConfigBroken(`lane "${lane.id}" に candidates がありません。`);
    for (const cand of lane.candidates) {
      const providerId = cand.slice(0, cand.indexOf(':'));
      if (!ids.has(providerId)) {
        throw new ConfigBroken(`lane "${lane.id}" の "${cand}" に対応する provider が有効ではありません。`);
      }
    }
  }
}

/** 有効なProviderだけを返す。enabled を省略した場合は有効とみなす。 */
export function enabledProviders(c: AasConfig): ProviderConfig[] {
  return c.providers.filter((p) => p.enabled !== false);
}

/** URL に利用者名かパスワードが入っているか（URL として読む。読めない文字列は、ここでは断らない）。 */
function hasUrlCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}
