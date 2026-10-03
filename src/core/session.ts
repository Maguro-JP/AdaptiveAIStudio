/**
 * 対話の核 — 入口から切り離した本体。
 *
 * これまで対話の手順は CLI の中に書かれていた。
 * 動きはするが、画面から同じことをしようとすると、
 * 同じ手順をもう一度書くことになる。書けば必ずずれる。
 *
 * だから核を外に出す。入口（CLI・画面・その先の何か）は
 * 出来事を受け取って見せるだけにして、何が起きるかはここだけが決める。
 *
 * 承認もここでは決めない。呼ぶ側に訊く。
 * 端末なら「y/N」、画面なら押しボタンになるが、
 * **訊かずに進めない**という一点だけは、ここが守る。
 */
import { Priority } from '../providers/contract.ts';
import { findCodeTool, findSymbolTool } from '../agent/tools/find.ts';
import {
  listServicesTool, createConnectServiceTool, createDisconnectServiceTool, type ServiceHooks,
} from '../agent/tools/services.ts';
import { defaultWorkRoot } from './home.ts';
import { isWriteTool, mayChangeFiles, isExternalTool } from '../agent/tools/write-kind.ts';
import { resolve, join } from 'node:path';
import type { AasConfig } from '../config.ts';
import { buildRegistry } from './build.ts';
import { ChatOrchestrator } from './orchestrator.ts';
import { setupAutopilot, resolveCandidates, stateDir, type AutopilotBundle } from './autopilot-setup.ts';
import { buildHarness } from './harness-setup.ts';
import { Forum } from '../harness/deliberation.ts';
import { Agent } from '../agent/loop.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool, editFileTool } from '../agent/tools/fs.ts';
import { createShowFileTool, type ShowHook } from '../agent/tools/show.ts';
import { createReplaceSelectionTool, type SelectionSource, type PatchHook } from '../agent/tools/patch.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { createFetchUrlTool } from '../agent/tools/network.ts';
import { createDeliberateTool } from '../agent/tools/deliberate.ts';
import { buildInspector } from './inspector-setup.ts';
import { startMcpServers } from './mcp-setup.ts';
import { loadJournals, saveJournals, type Journals } from './journals.ts';
import { McpClient, type McpServerSpec } from '../mcp/client.ts';
import { collectTools } from '../mcp/tools.ts';
import { Prefetcher, describeSnapshot } from '../agent/prefetch.ts';
import { Memory, formatRecall, betterDetail } from '../memory/memory.ts';
import {
  senseDispleasure, DISPLEASURE_LABEL, lessonFrom, displeasureTitle,
  judgePrompt, judgeOutcome, lessonFromUnderstanding,
  type DispleasureCode, type JudgeOutcome,
} from '../memory/displeasure.ts';
import { ProposalQueue, type Proposal } from '../agent/proposals.ts';
import { findLeads, investigationPrompt, parseProposal } from '../agent/initiative.ts';
import { IdleScheduler, type ModeStat } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES, MODE_ROLE, promptFor } from '../harness/idle-modes.ts';
import { DutyRoster, type DutyRecord } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import { readFile as readJson, mkdir } from 'node:fs/promises';
import { RoleRegistry } from '../roles/registry.ts';
import type { Tool, ApprovalRequest, ApprovalAnswer, RequestScope } from '../agent/tools/types.ts';
import { toolsFor } from '../roles/registry.ts';
import { buildSystemPrompt, type Role } from '../roles/role.ts';
import { looksLikeChat } from './intent.ts';
import { decompose, toWorkItems, type WorkPlan } from '../agent/pm.ts';
import { findNewerFor, describeNewer } from '../runtime/model-updates.ts';
import { catalogFamilies } from '../runtime/model-catalog.ts';
import { Team } from '../agent/team.ts';
import { accept, changedBetween, dropCoveredDirs, type AcceptanceReport, type MemberReport } from '../agent/acceptance.ts';
import { runVerification, verifyLoop, digestFailure, type VerifyEvent, type VerifyResult } from '../agent/verify.ts';
import { snapshotTests, compareTests } from '../agent/test-integrity.ts';
import { workspaceStamp, stampChanges } from '../agent/workspace-stamp.ts';
import { BaselineProbe, type BaselineOutcome } from '../agent/baseline.ts';
import { Checkpoint } from '../harness/checkpoint.ts';
import { UndoStore, restoreWarnings } from './undo.ts';
import { OutsideChanges } from '../agent/outside-changes.ts';
import { AckStore, type AckId } from './acks.ts';
import { fitParts } from './prompt-budget.ts';
import { rerankByBody, rerankShare } from '../agent/rerank.ts';
import { rankedEntries, renderMap, seedFrom, covers } from '../agent/repo-map.ts';
import { indexStore } from '../agent/tools/find.ts';
import type { Harness } from '../harness/harness.ts';
import { inspectGit } from '../agent/git.ts';
import { diffStat, unifiedDiff } from '../agent/diff.ts';
import { inspectDependencies, describeDependencies } from '../agent/dependencies.ts';
import { ANY_PATH, type LaneConfig } from './scheduler.ts';
import type { ProviderMessage } from '../providers/contract.ts';
import { Conversation } from './conversation.ts';
import { WorkspaceLock } from './workspace-lock.ts';
import { fitByTokens, estimateTokens } from '../agent/window.ts';
import { ProjectRules } from '../agent/project-rules.ts';
import type { Counter } from '../agent/tokenizer.ts';
import { resolveCounting, type Counting } from './counting.ts';
import { BeforeWork } from '../agent/before-work.ts';
import { describeNet } from '../runtime/net-why.ts';

/**
 * 前置き（決まり・学び・様子・置き場の決まり）に使ってよい、窓の割合。
 *
 * **合計で決める。**載せるものごとに別々に割合を決めると、足したときに
 * 窓の半分が消える（実際にそうなっていた）。
 */
export const SYSTEM_SHARE = 0.25;

/**
 * 嫌がられたことに渡す、前置き予算の上限。
 *
 * 同じ失敗を繰り返すのがいちばん高くつくので多めに取るが、**一人で取り切らせない。**
 */
export const HATED_SHARE = 0.2;

/**
 * 地図のために取り置く割合と、取り置きを始める予算。
 *
 * 置き場の決まりは残りを全部取るので、取り置かないと地図はコンテキストウィンドウ 32768 まで
 * 一度も載らなかった（実測）。ここは**利用者が書いた決まりの末尾を削って、
 * こちらが作った地図を載せる**という取り引きなので、いちばん小さく取る。
 *
 *   取り置き  地図      当たる   決まりの損（窓 16852）
 *   0         0 文字     0%      —
 *   0.05    631 文字   約37%     5%
 *   0.10   1052 文字   約42%    12%
 *   0.15   1428 文字   約46%    19%
 *
 * 0.05 で膝。そこから先は決まりを削る割に伸びない。地図が無いとモデルは
 * 総当たりで探すので、**小さくても在る方が効く**（当たる割合は
 * `scripts/bench.mjs` で測ったもの）。
 *
 * 狭い窓（予算 `MAP_FROM` 未満）では取り置かない。取り置くと決まりの側が落ちる。
 */
export const MAP_SHARE = 0.05;
export const MAP_FROM = 2000;

export const DEFAULT_SYSTEM = `あなたはソフトウェア開発の作業者です。与えられた作業ディレクトリで実際に手を動かします。

守ること:
- 推測でファイルを書かない。まず read_file / list_files / search_text で現状を確認する。
- write_file には必ずファイルの全内容を渡す。一部だけ渡すと残りが消える。
- 変更したら run_command でテストやビルドを実行し、結果を確認する。
- 作業が終わったら、何をしたかを簡潔に日本語で報告する。ツールは呼ばない。
- 分からないことは推測せず、質問して止まる。
- **訊かれただけのときは、ツールを使わずにそのまま答える。**作業として扱わない。
- 知らないことは「分かりません」と言う。天気・ニュース・今日の日付など、
  外で今起きていることは分かりません。調べに行かず、そう答える。

時間はいくらかかっても構わない。正確さを優先すること。`;

/**
 * 訊かれただけのときの決まり。
 *
 * **作業者の決まりを、問いかけに載せない。**「明日の天気は？」に
 * 「まず read_file で現状を確認する」「write_file には全内容を渡す」を
 * 載せていたので、2B の模型は問いをなぞって「完了」と返した（実機）。
 * 問いには、問いの決まりだけを渡す。ツールも渡さない。
 */
export const DEFAULT_CHAT_SYSTEM = `あなたは、この場所に住んでいる相棒です。訊かれたことに日本語で短く答えてください。

守ること:
- 知らないことは「分かりません」と言う。**作り話をしない。**
- 今日の日付、天気、ニュース、株価、外で今起きていることは分かりません。そう言ってください。
- 計算や言葉の問いには、そのまま答える。よけいな説明も言い訳も要りません。
- ファイルを直す・作る・調べるといった作業を頼まれたら、「作業として進めますか」と訊いてください。`;

export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolStart'; name: string; summary: string }
  /** 本文に紛れていた呼び出しを拾ったとき。直したことは黙らない。 */
  | { type: 'salvaged'; name: string }
  /** 合図が無いまま手を止めたので、押し戻した。**黙って押し戻さない。** */
  | { type: 'nudged'; left: number }
  /** 文脈に収まらないので、古い分を減らした。**黙って落とさない。** */
  | { type: 'trimmed'; dropped: number }
  | { type: 'toolEnd'; name: string; ok: boolean; summary: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'recalled'; text: string }
  | { type: 'finished'; reason: string; detail?: string }
  /** 作業前の状態。今回の失敗と、前からの失敗を切り分けるために要る。 */
  | {
      type: 'baseline'; command: string; passed: boolean;
      /** 覚えていた結果を使ったか。毎回流さないことを画面に出すため。 */
      cached?: boolean;
      /** 時間切れなどで切り分けができないとき。passed は false になるが失敗ではない。 */
      unknown?: boolean;
      detail?: string;
    }
  /** 検証ループの様子。書いて終わりにしないための往復。 */
  | { type: 'verify'; event: VerifyEvent }
  | {
      type: 'rolledBack'; paths: string[];
      /** 外のツールが変えたが、前の中身を記録できず（大きすぎる・取れない）、戻せなかった道。 */
      notRestored?: string[];
    }
  /** 書き換えの中身。何がどう変わったかは、文章より差分の方が速い。 */
  | { type: 'diff'; path: string; diff: string; added: number; removed: number; created: boolean }
  /** 検証まで含めた、この依頼の結末。 */
  /**
   * 終わり。
   *
   * `verified` は「**確かめて、通った**」の意味だけに使う。
   * 確かめていないときに true にしていたので、試験の無い作業場では
   * 何もしていなくても「検証済み」になっていた（実際にそうなっていた）。
   * どうだったかは `checked` で言う。
   */
  | {
      type: 'settled'; reason: string; verified: boolean; seconds: number; detail?: string;
      checked: 'passed' | 'failed' | 'preexisting' | 'unsure' | 'notRun';
      /**
       * 訊かれただけの回か。
       *
       * **問いに答えただけの回に「完了（検証していません）」と出していた。**
       * 何も完了していないし、確かめるものも無い。作業の言葉を、会話にも
       * 着せていた（実機の画面で見た）。判じ方は `looksLikeChat`。
       */
      chat?: boolean;
      /** 答えたモデル。切り替わっていれば、切り替わった先。 */
      model: string;
      /** 出した量の見積もり（文字数から。本文だけで、ツールの呼び出しは数えない）。 */
      outputTokens: number;
      /**
       * 実測の速さ（tok/s、見積もり）。**遅い理由を、その場で見せる。**
       * 一言で終わった回は数えない（非現実的な値になる。metrics と同じ線）。
       */
      tps?: number;
    }
  /**
   * 道具が弾かれたまま終わった。
   * 本文が「やりました」でも、作業場は変わっていない。**言葉より結果を出す。**
   */
  | { type: 'toolsFailed'; names: string[] }
  /**
   * 外のツール（MCP）だけで終わった回に、作業場が変わっていた。
   * `paths` が無いのは、比べられなかったとき（git の管理下でない等）。
   * 変わっていれば、このあと一度だけ確かめる（直させはしない）。
   * `beforeBaseline` は、この場所のツールで書く手前で見つけたとき。作業前の成否は
   * 測らず、このあと落ちたものはこの回のものとして直させる。
   */
  | {
      type: 'outsideChanged'; paths: string[] | undefined; beforeBaseline?: true;
      /** 作業前の成否は測らないが、この回より前に測った結果を覚えていて、それを使う。 */
      remembered?: true;
      /** 了解できる警告。了解すると、この作業場では次から出ない（`Session.acks`）。 */
      ackable?: AckId;
      /** 了解を結びつける作業場。会話に残った警告を、作業場を変えた後に押しても、出た作業場に結びつく。 */
      root?: string;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** 分解して並列に働かせるときの出来事。CLI も画面も、これを見て描く。 */
export type PlanEvent =
  | { type: 'recalled'; text: string }
  | { type: 'planRepaired'; detail: string }
  | { type: 'planned'; plan: WorkPlan }
  | { type: 'taskStart'; taskId: string; laneId: string }
  | { type: 'taskEnd'; taskId: string; state: string; ms: number; error?: string }
  | { type: 'taskSkip'; taskId: string; reason: string }
  /** 前の担当の成果を、次の担当へ渡した */
  | { type: 'handoff'; taskId: string; from: string[] }
  | { type: 'running'; taskIds: string[] }
  | { type: 'work'; taskId: string; text: string; ok: boolean }
  | { type: 'diff'; path: string; diff: string; added: number; removed: number; created: boolean }
  | { type: 'verifying'; command: string }
  | { type: 'baselineFailed' }
  | { type: 'accepted'; report: AcceptanceReport }
  /**
   * 確かめて落ちたので、この依頼の変更を巻き戻した（`harness.rollbackOnGiveUp`）。
   * 戻せなかった道（前の中身を記録していない・置き戻しに失敗した）も言う。
   */
  | { type: 'rolledBack'; paths: string[]; notRestored?: string[] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** 暇なときに考えたことの流れ。 */
export type ThinkEvent =
  | { type: 'chose'; modeId: string; codename: string; name: string; roleCodename: string; reason: string; isDuty: boolean }
  | { type: 'noFinding'; codename: string }
  /**
   * 今回は考えなかった。**理由を捨てない。**
   *
   * ここまで、断るときは黙って `false` を返していた。理由（予算切れ・間合い・
   * モデルが無い）はその場に在るのに、一つも渡していない。押した人からは
   * 「押しても何も起きない」としか見えず、壊れているのか効いているのかも
   * 分からないので、何度も押すことになる。
   *
   * **見せるかどうかは、呼ぶ側が決める。**見回り（勝手に動く分）は黙ったまま、
   * 押されたときだけ出す。
   */
  | { type: 'declined'; reason: string }
  /** 選んで試したが、モデルが落ちた・止められた・何も返さなかった。断った（選ぶ前）とは別。見回りでも出す（選んだ一行だけで終わらせない）。 */
  | { type: 'failed'; codename: string; reason: string }
  | { type: 'proposal'; proposal: Proposal; codename: string };

export interface SessionOptions {
  /** 承認の訊き方。入口ごとに違う。 */
  /**
   * `meta.requestKey` はいまの依頼を見分ける札（会話と依頼の番号の組）。画面は「この依頼のあいだは訊かない」を
   * これで覚える（全会話で共通の番号で覚えると、並べて走る別の会話の依頼に漏れる）。
   */
  approve(req: ApprovalRequest, meta?: { requestKey: string }): Promise<ApprovalAnswer>;
  /** 画面や端末へ流したいもの。省略可。 */
  onLog?(level: 'info' | 'warn' | 'error', text: string): void;
  /**
   * 「ここを見てください」を画面で開く受け手。省略可。
   *
   * **画面の無い入口（端末）では置かない。**置かないと `show_file` は
   * 「開く先がありません」と返す。受け手が無いのに開いたことにしない。
   */
  onShow?: ShowHook;
  /**
   * 画面で選んでいる所を教える相手と、そこを書き換える受け手。省略可。
   *
   * **画面の無い入口（端末）では置かない。**置かないと `replace_selection` は
   * 「書き換える先がありません」と返す。範囲は利用者が選んだ所で、AI は文だけを出す。
   */
  editorSelection?: SelectionSource;
  onPatch?: PatchHook;
  /**
   * 暇なときの思考に、外を読むことを許すか。既定は許す。
   * 完全に閉じたいときだけ false にする。
   */
  approveThinking?: boolean;
  /**
   * 溜めておくもの（提案・当番・暇の配分）。
   *
   * **既に読んであるなら渡す。**画面は、これを読むためだけにセッションを
   * 作っていた。渡せば作らずに済み、二つ持って食い違うこともない。
   */
  journals?: Journals;
}

/** 考えごとで、配布元に新しい世代を訊く上限。家族ごとに順に訊くので、短すぎると普段から打ち切って何も分からない。 */
const UPDATE_PROBE_TIMEOUT_MS = 60_000;

export class Session {
  readonly config: AasConfig;
  readonly root: string;
  /**
   * 終わった後に、人が自分の判断で戻すための控え。
   *
   * 一往復の中の巻き戻し（`Checkpoint`）とは別。あちらは確かめて落ちたときに
   * 自動で戻して、終われば捨てる。**間違った直しを当てられたときに、
   * 利用者にできることが「自分で書き戻す」しか無い**のでは任せられない。
   */
  readonly undo: UndoStore;
  /**
   * 作業場の錠。書く依頼は持っている間だけ作業場を変え、「戻す」の記録・巻き戻し・外の変化の比べを持つ。
   * 二つの会話が同時に書くと、互いの書き込みを外の変化と読み違えるため（DECISIONS 09-26）。
   */
  readonly lock = new WorkspaceLock();
  /** 錠の持ち主の札を作る数え。 */
  #lockSeq = 0;
  /** 了解した警告（作業場ごと）。画面の `/api/acks` と CLI の `/ack` が同じものを触る。 */
  readonly acks: AckStore;
  /** なぜいまのモデルなのか。画面に出すために持つ（黙って選ばない）。 */
  readonly modelReason: string;
  /**
   * いま渡している地図。**同じで済むなら作り直さない。**
   * 前置きが変わると、相手は履歴まで計算し直す。
   */
  #map?: { text: string; builtAt: string };
  /** 前置きに入り切らなかったもの。**黙って落とさない**ために持つ。 */
  #lastDropped: string[] = [];
  readonly candidates: string[];

  /**
   * モデルが要る仕事の手前で、無いことを言う。無ければ `undefined`。
   *
   * 土台は候補が空でも作る（作らないと画面が丸ごと 500 になる）。
   * そのぶん、**モデルを実際に使う三箇所（送る・段取る・考えごと）で
   * こちらから断る**。ここを抜くと、候補の先頭を掴む所で
   * `undefined` のまま繋ぎ先を叩きに行く。
   */
  get noModel(): string | undefined {
    if (this.candidates.length > 0) return undefined;
    return `使えるモデルがありません: ${this.modelReason}`;
  }

  readonly memory: Memory;
  /** 溜まった提案。実行はしない。溜めて、人に選ばせる。 */
  readonly proposals: ProposalQueue;
  /** 何を考えるかの配分。無駄に考えないための仕組み。 */
  readonly idle: IdleScheduler;
  /** 日課。変化が無くてもやることを、時間で起こす。 */
  readonly duties: DutyRoster;
  readonly roles: RoleRegistry;
  readonly orchestrator: ChatOrchestrator;
  readonly pilot: AutopilotBundle;

  /**
   * いま渡せるツール。一人で全部やるので、全ての権限を渡す。
   *
   * **その場で組み立てる。**一度作って持っていたので、後から繋がった
   * 外の相手のツールが、立ち上げ直すまで使えなかった。外の相手は
   * 待たずに起こす形にしたので、**繋がるのは必ず後になる。**
   */
  get #tools(): Tool[] {
    return [
      ...this.toolPool.read, ...this.toolPool.write,
      ...this.toolPool.execute, ...this.toolPool.network, ...this.toolPool.mcp,
    ];
  }
  /** 権限ごとのツール。役職に応じて配り分けるために持つ。 */
  readonly toolPool: { read: Tool[]; write: Tool[]; execute: Tool[]; network: Tool[]; mcp: Tool[] };
  /** 外の道具の繋がり具合。画面と doctor に見せるために持つ。 */
  readonly mcpClients: readonly McpClient[];
  /**
   * 外のツールを、**いま動いているこのセッションに**繋ぐ・外す口。
   *
   * 画面の口（`/api/mcp/connect`）はここまで、設定を書いてから
   * **手が空いているときだけ**セッションを畳んでいた。作業中は畳まないので、
   * 繋いだツールはそのセッションの間ずっと立ち上がらず、返事にも一言も無い。
   * 畳まずに足せるようにする。
   */
  readonly services: ServiceHooks;
  readonly #opts: SessionOptions;
  readonly #prefetch: Prefetcher;
  /** ハーネスの規則へ「いま何を頼まれているか」を渡すための箱。 */
  readonly #holder: { instruction: string };
  /**
   * 依頼の通し番号。**依頼のあいだだけ効くものを、持ち越させないための目印。**
   *
   * 「この依頼のあいだは訊かない」を入口ごとに倒していたので、段取り（`plan`）の
   * 入口で倒し忘れていた。一度その押し場所を選んだあとに段取りを送ると、
   * **札を一枚も出さずに全部の書き込みが通る。**番号で見れば、新しい依頼が
   * 始まった時点で外れる（入口を足しても、ここを通らなければ依頼にならない）。
   */
  #requests = 0;
  /** 協議の場。依頼ごとに開き直す。 */
  readonly #forum: Forum;
  readonly #harness: Harness;
  /**
   * いまの会話（履歴・実行中・依頼文・差分）。`src/core/conversation.ts`。
   * いまは一つだけ持つ。画面で会話ごとに走らせる段（DECISIONS 09-26 の 2c）で、呼ぶ側が渡す形にする。
   */
  readonly #conv = (() => {
    const conv = new Conversation();
    // 既定の会話は、共有の harness の依頼（札 ''）で規則の数え（metrics）に数える。
    conv.isDefault = true;
    return conv;
  })();
  /** 走っている会話（既定の会話も、画面が渡したほかの会話も）。暇な思考は、どれかが走っていれば始めない。 */
  readonly #active = new Set<Conversation>();
  /** 提案がどの思考から出たか。採否をその思考の実績に返すために持つ。 */
  readonly #origin = new Map<string, string>();
  #lastChangeAt = Date.now();
  /** ベースライン。同じ命令なら一度しか流さない。 */
  #baseline?: BaselineProbe;
  /** 置き場の決まり（AGENTS.md など）。**人に貼り直させない。** */
  readonly #projectRules: ProjectRules;
  /**
   * そのモデルの本物の数え方。**無ければ見積もりに戻る。**
   * 一度だけ引く（`undefined` と「まだ引いていない」を分ける）。
   */
  #counter?: Counter;
  #counterAsked = false;

  private constructor(init: {
    config: AasConfig; root: string; candidates: string[]; modelReason: string;
    memory: Memory; roles: RoleRegistry; orchestrator: ChatOrchestrator;
    proposals: ProposalQueue; idle: IdleScheduler; duties: DutyRoster;
    pilot: AutopilotBundle; prefetch: Prefetcher; opts: SessionOptions;
    holder: { instruction: string };
    forum: Forum;
    harness: Harness;
    toolPool: { read: Tool[]; write: Tool[]; execute: Tool[]; network: Tool[]; mcp: Tool[] };
    mcpClients: McpClient[];
    services: ServiceHooks;
  }) {
    this.services = init.services;
    this.config = init.config;
    this.modelReason = init.modelReason;
    this.root = init.root;
    this.undo = new UndoStore(init.root, join(stateDir(), 'undo'));
    this.acks = new AckStore(join(stateDir(), 'acks.json'));
    this.#projectRules = new ProjectRules(init.root);
    this.candidates = init.candidates;
    this.memory = init.memory;
    this.proposals = init.proposals;
    this.idle = init.idle;
    this.duties = init.duties;
    this.roles = init.roles;
    this.orchestrator = init.orchestrator;
    this.pilot = init.pilot;
    this.toolPool = init.toolPool;
    this.mcpClients = init.mcpClients;
    this.#prefetch = init.prefetch;
    this.#opts = init.opts;
    this.#holder = init.holder;
    this.#forum = init.forum;
    this.#harness = init.harness;
  }

  static async create(config: AasConfig, opts: SessionOptions): Promise<Session> {
    const agentCfg = config.agent ?? {};
    const root = resolve(agentCfg.root ?? defaultWorkRoot());
    // **無ければ作る。**入れた版の既定（根の下の work）は、初回には無い。
    // 無いまま進むと、一覧も読み書きも「そんな場所は無い」で落ちる。
    await mkdir(root, { recursive: true }).catch(() => { /* 作れないなら、使う所で言う */ });

    const registry = buildRegistry(config);
    const orchestrator = new ChatOrchestrator(registry);
    const pilot = await setupAutopilot(config, registry);
    const { candidates, note } = resolveCandidates(config, pilot);
    /*
     * **モデルが無いことを、ここで投げない。**
     *
     * ここは `throw` していた。土台を作るのは画面のほとんどの入口
     * （提案・当番・戻す・会話の一覧）なので、**GGUF が一つ無いだけで、
     * 画面じゅうが 500 になる。**設定を開くことすらできない。
     * つまり「モデルが無い」を直しに行く手段まで、同時に塞いでいた。
     * 実際にそうなって、利用者は設定画面を開けなかった。
     *
     * モデルが要るのは、送る・段取る・考えごとの三つだけ。
     * **要る所で断る。**ここでは候補が空のまま進み、理由を持っておく
     * （`modelReason`）。画面はそれを読んで、何が足りないかを出せる。
     */
    if (candidates.length === 0) opts.onLog?.('warn', `使えるモデルがありません: ${note}`);
    /*
     * **黙って選ばない。**
     *
     * 何を選んだかと、なぜそれなのかは、既に手元にある（`note`）のに、
     * **モデルが無いときのエラー文にしか使っていなかった**。選べたときは
     * 捨てていたので、利用者から見ると「いつのまにか、この名前で動いている」。
     * 速い方へ勝手に乗り換える作りなので、なおさら理由が要る。
     *
     * 「黙って切らない・黙って落とさない」と同じことで、**選ぶのも黙らない**。
     */
    if (candidates.length > 0) opts.onLog?.('info', `モデルを ${candidates[0]} にしました（${note}）`);

    const log = (level: 'info' | 'warn' | 'error', text: string) => opts.onLog?.(level, text);

    // ハーネス。守らせるのではなく、実行させないことで守る。
    const holder = { instruction: '' };
    // 協議の場。依頼ごとに開き直す（前の依頼で通した話を持ち越さない）。
    const forum = new Forum();
    const harness = await buildHarness(config, (d) => {
      if (d.outcome === 'denied') log('error', `⛔ ${d.rule}: ${d.reason ?? ''}`);
      else if (d.outcome === 'warned') log('warn', `⚠ ${d.rule}: ${d.reason ?? ''}`);
    }, forum);
    // 記録を残せなかったことを黙らない（続けて失敗している間は一度だけ）
    harness.audit.warnTo((t) => log('warn', t));
    harness.metrics?.warnTo((t) => log('warn', t));

    /*
     * 外のツール。**立ち上がるのを待たない。**
     *
     * ここは全部が繋がるまで待っていた。1台につき最大20秒。その間
     * `Session.create` が止まり、**最初の送信がそのぶん待たされる。**
     * 起こすだけ起こして先へ進み、繋がった時点でツールを足す（下の `refresh`）。
     * 最初の1ターンに間に合わなければ、その1ターンだけツールが少ない。
     */
    let refresh = (): void => { /* ツールの入れ物が出来るまでは、何もしない */ };
    const mcpClients = await startMcpServers(config, log, () => refresh());

    /*
     * 繋ぐ・外すを、**いま動いている相手の一覧にも効かせる。**
     *
     * ここまで、`connect_service` / `disconnect_service` は設定ファイルを
     * 書き換えるだけだった。この一覧は `Session.create` のときに作ったきり
     * 作り直さないので、**外してもツールは呼べたまま**、**繋いでも次の依頼では
     * 使えない**。それでいて「次の依頼から使えます」「次の依頼からは
     * 出てきません」と言っていた。動かして確かめた。
     */
    const serviceHooks: Required<ServiceHooks> = {
      onConnected: async (id: string, spec: McpServerSpec): Promise<boolean> => {
        if (mcpClients.some((c) => c.name === id)) return true;
        const client = new McpClient(id, spec);
        mcpClients.push(client);
        const up = await client.start().catch(() => false);
        if (!up) {
          // 立たなかったものを一覧に残さない（ツールは出ないが、外せなくなる）。
          const at = mcpClients.indexOf(client);
          if (at >= 0) mcpClients.splice(at, 1);
          log('warn', `外のツールに繋がりませんでした: ${id} — ${client.failure ?? '理由は不明'}`);
          return false;
        }
        log('info', `外のツールに繋がりました: ${id}（${client.tools.length} 件）`);
        refresh();
        return true;
      },
      onDisconnected: (id: string): boolean => {
        const at = mcpClients.findIndex((c) => c.name === id);
        if (at < 0) return false;
        mcpClients[at]!.stop();
        mcpClients.splice(at, 1);
        refresh();
        return true;
      },
    };

    // 権限は「配らない」ことで守る。禁じる文言ではなく、手段の有無で決める。
    const netCfg = config.network ?? {};

    // 関所の二段目。外へ出るときも、外の道具から返るときも、同じ検査官を通す。
    // 使えるモデルが無ければ置かれず、一段目（当てはめ）だけで動く。
    const inspector = buildInspector(
      orchestrator,
      // 明示が無ければ候補を逆順にする。候補は強い順に並んでいるので、
      // そのまま渡すと一番重いモデルが関所に立つ。ここは速さが要る。
      netCfg.inspector?.candidates ?? [...candidates].reverse(),
      netCfg.inspector ?? {},
    );
    const wrap = (tools: Tool[]) => harness.wrapAll(tools, () => holder.instruction);
    const toolPool = {
      // `show_file` は読む側に置く。中身を返さないので、読む権限より弱い。
      read: wrap([readFileTool, listFilesTool, searchTextTool, findCodeTool, findSymbolTool,
        createShowFileTool(opts.onShow)]),
      // `replace_selection` は書く側。ディスクは触らないが、**人が書きかけの
      // 欄を書き換える**ので、読むだけの役職には持たせない。
      write: wrap([writeFileTool, editFileTool, createDeliberateTool(forum),
        createReplaceSelectionTool(opts.editorSelection, opts.onPatch)]),
      execute: wrap([createRunCommandTool({ allowed: agentCfg.allowedCommands })]),
      network: netCfg.enabled === false ? [] : wrap([createFetchUrlTool({
        allowedHosts: netCfg.allowedHosts, maxBytes: netCfg.maxBytes, timeoutMs: netCfg.timeoutMs,
        inspector,
      })]),
      // 外の道具。立ち上がった相手のぶんだけ増える。
      // 繋がらない相手がいても、他は動く（全部を道連れにしない）。
      // 繋ぐ・外すも、ここに置く。**外の道具の話は、外の道具の側で完結させる。**
      // 繋ぐのは承認を通す（協議は自動では通らない）。
      mcp: wrap([
        listServicesTool,
        createConnectServiceTool(serviceHooks), createDisconnectServiceTool(serviceHooks),
        ...collectTools(mcpClients, { inspector, timeoutMs: config.mcp?.timeoutMs }),
      ]),
    };

    // 繋がったら、そのぶんを入れ直す。**次のターンから使える。**
    refresh = () => {
      toolPool.mcp = wrap([
        listServicesTool,
        createConnectServiceTool(serviceHooks), createDisconnectServiceTool(serviceHooks),
        ...collectTools(mcpClients, { inspector, timeoutMs: config.mcp?.timeoutMs }),
      ]);
    };

    const prefetch = new Prefetcher(root, () => undefined);
    prefetch.start();

    const memory = new Memory(join(stateDir(), 'memory.jsonl'));
    await memory.load();
    // **入れた直後から、同じ地雷を踏まない。**
    // ここまで指摘されてきたことを、最初から持たせておく。
    if (memory.seedLessons() > 0) await memory.save().catch(() => undefined);

    /*
     * 溜めておくもの（提案・当番・暇の配分）。
     *
     * **渡されたらそれを使う。**画面はこれを読むためだけに、ここまで
     * セッションを作っていた。作ると、モデルの一覧を取り・MCP の相手を
     * 起こし・先読みを始め・記憶を読み込む。**利用者は何も頼んでいない。**
     * 呼ぶ側が先に読んでおけるようにして（`loadJournals`）、二つ持たない
     * ように、ここでは渡されたものを使う。
     */
    const { proposals, idle, duties } = opts.journals ?? await loadJournals(config);

    const session = new Session({
      config, root, candidates, modelReason: note, memory,
      roles: new RoleRegistry(config.roles ?? [], (t) => log('warn', t)),
      orchestrator, pilot, prefetch, opts, holder, forum, toolPool, harness, mcpClients,
      services: serviceHooks,
      proposals, idle, duties,
    });
    return session;
  }

  get busy(): boolean { return this.#conv.running !== undefined; }

  /** どれかの会話が走っているか（既定の会話に限らない）。 */
  get anyBusy(): boolean { return this.#conv.running !== undefined || this.#active.size > 0; }

  /** いま何本目の依頼か。依頼のあいだだけ効くものは、これが変わったら外す。 */
  get requestSeq(): number { return this.#requests; }

  /**
   * 承認の問い合わせを通り道にして、差分を拾っておく。
   * 差分は道具の中で作られていて、承認以外に外へ出る道が無いため。
   */
  #approveFor(conv: Conversation): (req: ApprovalRequest) => Promise<ApprovalAnswer> {
    return async (req) => {
      if (req.kind === 'write') conv.diffs.set(req.path, { diff: req.diff, created: req.created });
      return this.#opts.approve(req, { requestKey: conv.requestKey });
    };
  }

  /** 既定の会話の承認（段取り・暇な思考・役職が使う）。 */
  readonly #approve = this.#approveFor(this.#conv);

  /** 直近の書き換えの差分。取り出したら手放す。 */
  #takeDiff(path: string, conv: Conversation = this.#conv): { diff: string; created: boolean } | undefined {
    const key = path.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const candidate of [path, key]) {
      const found = conv.diffs.get(candidate);
      if (found) { conv.diffs.delete(candidate); return found; }
    }
    return undefined;
  }

  /** レーン。指定が無ければ候補から作る。空いている資源は節約ではなく損失。 */
  get lanes(): LaneConfig[] {
    const configured = this.config.agent?.lanes;
    return configured && configured.length > 0
      ? configured
      : [{ id: 'main', candidates: this.candidates, parallel: 2 }];
  }

  /**
   * 依頼を分解して、複数の担当に同時に働いてもらい、検収まで通す。
   *
   * 入口ごとに書き直さない。ここが唯一の手順で、
   * CLI も画面も、出てくる出来事を見て描くだけにする。
   *
   * `said` は利用者が打った文（添付の中身を差し込む前）。戻り先の見出し・前に分かっていることの呼び出し・覚える見出しは
   * 利用者の言葉で持つ（添付の頭が見出しにならないように）。分解・規則の判定・検収には全文を渡す。
   */
  async *plan(request: string, said?: string): AsyncGenerator<PlanEvent, AcceptanceReport | undefined> {
    const asked = said || request;
    if (this.noModel) {
      yield { type: 'log', level: 'error', text: this.noModel };
      return undefined;
    }
    if (this.#conv.running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return undefined;
    }
    const ac = new AbortController();
    this.#conv.running = ac;
    /*
     * 段取りは担当が並列に書くので、依頼の頭で作業場の錠を取る（最初に書く時点を一つに決められない）。
     * 止められて待つのをやめたら、何もせずに終える。
     */
    const lockOwner = `plan:${++this.#lockSeq}`;
    try {
      await this.lock.acquire(lockOwner, ac.signal);
    } catch (e) {
      this.#conv.running = undefined;
      yield { type: 'log', level: 'warn', text: (e as Error).message };
      return undefined;
    }
    // 段取りでもファイルを触る。**戻せるのは送り口だけ、にしない。**
    // 始められなかったら（前の戻り先を閉じる書き込みの失敗など）、錠と「動いている」を返して終える。
    try {
      await this.undo.begin(asked);
    } catch (e) {
      this.lock.release(lockOwner);
      this.#conv.running = undefined;
      yield { type: 'log', level: 'error', text: (e as Error).message };
      return undefined;
    }
    this.#holder.instruction = request;
    this.#requests += 1;
    // 段取りも一つの依頼。承認の「この依頼のあいだは訊かない」を前の依頼から持ち越さない。
    this.#conv.nextRequest();
    // 依頼が変われば協議もやり直し。前回通した話で今回の変更を通させない。
    this.#forum.clear();
    /*
     * **依頼ごとに履歴を切る。ここも送り口と同じ。**
     *
     * ハーネスの規則は「1つの依頼の中での積み重ね」を見る。送り口では
     * 切っていたのに、こちらでは呼んでいなかった。切らないと前の依頼で
     * 書いたファイルが今回の分として数えられ、**一文字も書いていない依頼が
     * 上限（maxFilesPerTask）で最初の一回から止まる。**
     * 同じ内容の書き直しを止める規則も、前の依頼の分で誤爆する。
     */
    this.#harness.beginTask();
    /** 外のツールの分を「戻す」に載せる。一度だけ（途中で落ちたら finally から）。 */
    let outsideTaken: (() => Promise<void>) | undefined;
    const takeOutside = async (): Promise<void> => {
      const take = outsideTaken;
      outsideTaken = undefined;
      await take?.().catch(() => undefined);
    };

    try {
      const root = this.root;
      const verifyCfg = this.config.agent?.verify ?? {};

      // 作業前の状態。あとで「今回何が変わったか」を出すために要る。
      const gitBefore = await inspectGit(root);
      const dirtyBefore = gitBefore.kind === 'dirty' ? gitBefore.changed : [];

      const command = await this.verifyCommand();
      // ベースラインは切り分けのためだけのもの。切っても作業後の検査は残す。
      const probed = command && verifyCfg.baseline !== false
        ? await this.measureBaseline(command, ac.signal)
        : undefined;
      const baseline = probed?.result;
      // 「分からない」は失敗ではない。切り分けをやめるだけ。
      // 測っている途中で止めた回は、落ちたのではない（止めると終わりの番号が無く、「落ちた」に見える）。
      const baselineFailed = probed?.status === 'failed' && !ac.signal.aborted;
      if (baselineFailed) yield { type: 'baselineFailed' };

      const active = this.roles.active();
      const fallbackRoleId = this.roles.get('worker') ? 'worker' : active[0]!.id;
      const pmCtx = {
        lanes: this.lanes,
        roleIds: active.map((r) => r.id),
        fallbackRoleId,
        maxItems: 8,
        // 誰が書き、誰が調べるだけかを渡す。二人目を付ける判断に要る。
        access: Object.fromEntries(active.map((r) => [r.id, r.access as string[]])),
      };

      // 前に分かっていること・駄目だったことを渡してから分解させる。
      // 段取りの側は、こちらの決まり（system）を通らない（進行役は別の決まりで動く）。
      // なので「二度としないこと」は、こちらに載せる。
      const known = this.#recall(asked);
      if (known) yield { type: 'recalled', text: known };

      const pm = decompose(
        this.orchestrator,
        known ? `${request}\n\n${known}` : request,
        // 利用者が押して待っている。直前の判じ（中）の後ろに並ばせない。
        { candidates: this.candidates, ctx: pmCtx, priority: Priority.top },
        ac.signal,
      );
      let step = await pm.next();
      while (!step.done) {
        if (step.value.type === 'repaired') yield { type: 'planRepaired', detail: step.value.detail };
        step = await pm.next();
      }
      const plan = step.value;
      yield { type: 'planned', plan };

      /*
       * **段取りの担当にも、こちらの決まりを渡す。**
       *
       * ここは役職の文だけを渡していた。送り口（send）が渡している
       * リポジトリの決まり・二度としないこと・作業場の様子・repo map が、
       * 段取りからの担当には**一つも届いていなかった。**
       * 「push では CI を回さない」も「C: 直下にフォルダを作らない」も、
       * 段取りで書かせる限り一度も目に入らない。
       *
       * 組むのは一度だけ（repo map と様子を人数ぶん作り直さない）。役職の文は
       * **後ろに置く。**前を全員で同じにしておくと、相手が頭から計算し
       * 直さずに済む（役職ごとに頭が変わると、そのぶん待ち時間になる）。
       */
      const shared = await this.#system();
      const systemFor = (role: Role): string => `${shared}\n\n${buildSystemPrompt(role)}`;

      /** 段取り全体で呼んだツール（並べた担当の間で一つ）。書ける数の規則がこれで数える。 */
      const planCalls: NonNullable<RequestScope['taskHistory']> = [];
      const team = new Team(this.orchestrator, {
        lanes: this.lanes,
        system: systemFor(this.roles.get(fallbackRoleId)!),
        tools: toolsFor(this.roles.get(fallbackRoleId)!, this.toolPool),
        root,
        maxTurns: this.config.agent?.maxTurns,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        maxTotalParallel: this.config.agent?.maxTotalParallel,
        approve: this.#approve,
        beforeWrite: (path, previous) => this.undo.capture(path, previous),
        wrote: (path, diff, created) => this.#conv.diffs.set(path, { diff, created }),
        // 権限は役職から配る。調べるだけの担当は書き込む手段を持たない。
        /*
         * **規則の履歴は担当ごと。**ツールは共有の harness で包まれていて、入れ物を渡さないと全員が一つの履歴を見る。
         * 読んでから書く規則が**別の担当が読んだこと**で通り、同じ中身の書き直しを止める規則は他人の書き込みで止まる
         * （`Harness.forTask()` の注と同じ話）。依頼文と協議は依頼で一つ、数え（metrics）は既定の会話の札で数える。
         */
        assign: (roleId) => {
          const role = this.roles.get(roleId);
          if (!role) return undefined;
          // 書ける数は依頼全体で数える（`taskHistory` は担当の間で一つ）
          const scope: RequestScope = { instruction: () => request, history: [], taskHistory: planCalls, forum: this.#forum, metricsKey: () => '' };
          return { system: systemFor(role), tools: toolsFor(role, this.toolPool), request: scope };
        },
      });

      /*
       * **外のツール（MCP）と `run_command` が変えた分も「戻す」に載せる。**
       *
       * 送り口（send）はツールを呼ぶたびに前後を比べるが、段取りは担当が並列に動くので、
       * ツールごとに比べると他の担当の書き込みが混ざる。「戻す」は依頼 1 件で 1 つの戻り点
       * なので、依頼全体を一度で挟めば足りる。担当が始まる手前で記録を取り、終わり
       * （途中で落ちても）にもう一度比べる。
       *
       * ここで分かる前の中身は**依頼の前の姿**なので、書く手前の記録（`beforeWrite`）より優先して
       * 置き換える。担当が先に `run_command` で変えてから `write_file` で書くと、書く手前の記録は
       * `run_command` の後の姿になっている（最初の一度が勝つので、そのままだと途中の姿に戻る）。
       * 前の中身を記録できなかった道は、書く手前の記録も捨てて「戻せない」にする（途中の姿に戻さない）。
       * 確かめのコマンドが書くもの（スナップショット等）は作業ではないので、比べるのは確かめの前。
       */
      const outside = new OutsideChanges(root);
      await outside.before();
      /*
       * 書くツールを通らずに変わった道（run_command・外のツール）。受け入れの報告の「変わったもの」にも足す。
       * git の差分だけで見ると、作業の前から手元で変えてあったファイルをさらに書き換えても、道の名前が同じなので載らず、
       * 「何も変わっていません」と報告していた。
       */
      const outsideChanged = new Set<string>();
      outsideTaken = async () => {
        const found = await outside.after();
        for (const c of found.changes) this.undo.replace(c.path, c.previous);
        for (const path of found.unrecorded) this.undo.forget(path);
        for (const path of [...found.changes.map((c) => c.path), ...found.unrecorded]) outsideChanged.add(path.replace(/\\/g, '/'));
      };

      /*
       * テストの数を担当が始まる前に記録する。`run_command` でテストを消して・skip して通した形を、
       * 「通過」と言わない（送り口は比べていた。書くツールの分は規則が止めるが、コマンドの分は通る）。
       */
      const testsBefore = command ? await snapshotTests(root).catch(() => undefined) : undefined;
      /** 実際に書き換えられたファイル。宣言ではなく、起きたことを見る。 */
      const written = new Set<string>();
      /*
       * 書けるのに書き込み先を挙げなかった担当は、誰とも同時に書かせない（`ANY_PATH`）。錠は宣言だけで掛かるので、
       * 挙げなかった二人が同じファイルを読み・書き、後の全文書き込みが前の担当の仕事を黙って消していた（どちらも「完了」）。
       */
      // `execute` も書ける側に数える（`run_command` で書けるので、書く担当と同時に走らせない）
      const canWrite = (roleId: string): boolean => {
        const access = this.roles.get(roleId)?.access ?? [];
        return access.includes('write') || access.includes('execute');
      };
      const items = toWorkItems(plan).map((w) =>
        (w.writes ?? []).length === 0 && canWrite(w.roleId) ? { ...w, writes: [ANY_PATH] } : w);
      const gen = team.run(items, ac.signal);
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.type === 'taskStart') yield { type: 'taskStart', taskId: ev.taskId, laneId: ev.laneId };
        else if (ev.type === 'taskEnd') {
          yield { type: 'taskEnd', taskId: ev.taskId, state: ev.state, ms: ev.ms, error: ev.error };
        } else if (ev.type === 'taskSkip') yield { type: 'taskSkip', taskId: ev.taskId, reason: ev.reason };
        else if (ev.type === 'handoff') yield { type: 'handoff', taskId: ev.taskId, from: ev.from };
        else if (ev.type === 'running') yield { type: 'running', taskIds: ev.taskIds };
        else if (ev.type === 'agent' && ev.event.type === 'toolEnd') {
          if (!ev.event.isError && mayChangeFiles(ev.event.call.name)) {
            this.#prefetch.invalidate();
            // 触った先が分かるのは、この場所の書くツールだけ。外のツールと
            // run_command は path を持たない（持っていても意味が違う）。
            if (isWriteTool(ev.event.call.name)) {
              const path = (ev.event.call.args as { path?: string }).path;
              if (path) written.add(path.replace(/\\/g, '/').replace(/^\.\//, ''));
            }
          }
          yield {
            type: 'work', taskId: ev.taskId, ok: !ev.event.isError,
            text: `${ev.event.call.name} ${summarize(ev.event.call.args)}`,
          };
          const shown = this.#diffFor(ev.event.call.name, ev.event.call.args, ev.event.isError);
          if (shown) yield shown;
        }
        next = await gen.next();
      }
      const outcomes = next.value;
      // 担当が終わった時点の姿で比べる（確かめのコマンドが書く分を混ぜない）。
      await takeOutside();

      // 検査。通らないものを人に見せない。
      let verified: 'passed' | 'failed' | 'skipped' | 'preexisting' | 'unsure' = 'skipped';
      let verifyDetail: string | undefined;
      /*
       * **止めた回は確かめない。**`execCommand` は、渡す前に止められていた signal の abort を拾わない
       * （聞き手を足した時点で、もう鳴り終わっている）。止めた後にここへ来ると、確かめのコマンドが
       * 最後まで（既定 600 秒）走り、そのあいだ錠と「動いている」を抱えたままになる。
       * 走らせても「落ちた」と出るだけで、止めた手を「駄目だった手」として覚える。
       */
      const stopped = (): boolean => ac.signal.aborted;
      if (command && stopped()) verifyDetail = '止めたので、確かめていません';
      if (command && !stopped()) {
        yield { type: 'verifying', command };
        const r = await runVerification(
          { command, root, commandTimeoutMs: verifyCfg.commandTimeoutMs }, ac.signal);
        const integrity: { ok: boolean; reason?: string; unsure?: string } = r.passed && testsBefore
          ? await snapshotTests(root).then((after) => compareTests(testsBefore, after), () => ({ ok: true, unsure: 'テストを読めませんでした' }))
          : { ok: true };
        if (stopped()) verifyDetail = '止めたので、確かめを途中でやめました';
        else if (!integrity.ok) { verified = 'failed'; verifyDetail = integrity.reason ?? 'テストが減っています'; }
        else if (integrity.unsure) { verified = 'unsure'; verifyDetail = integrity.unsure; }
        else if (r.passed) verified = 'passed';
        // 時間切れは落ちたのではない（送り口と同じく「分からない」。全部を巻き戻す理由にしない）
        else if (r.timedOut) { verified = 'unsure'; verifyDetail = '確かめが時間内に終わりませんでした'; }
        // **作業前と同じ落ち方のときだけ「元から」。**落ち方を比べずに言うと、この回が増やした失敗まで
        // 「今回の作業が原因ではありません」と言い、巻き戻しもしない（送り口は digest で比べている）。
        else if (baselineFailed && baseline && digestFailure(baseline.output) === digestFailure(r.output)) {
          verified = 'preexisting'; verifyDetail = firstLine(r.output);
        } else {
          verified = 'failed';
          verifyDetail = r.output.split('\n').filter((l) => l.trim()).slice(-3).join(' / ');
        }
        // 次の回の「前」を、この回の終わりの姿にする（送り口と同じ）。止めた・時間切れ・読めないなら忘れる。
        if (!stopped() && !r.timedOut && verified !== 'unsure') this.baselineProbe.note(command, r);
        else this.baselineProbe.invalidate(command);
      }

      const roleOf = new Map(plan.items.map((t) => [t.id, t.roleId]));
      const members: MemberReport[] = [...outcomes.values()].map((o) => ({
        id: o.id,
        roleId: roleOf.get(o.id) ?? '不明',
        state: o.state === 'done' ? 'done' : o.state === 'failed' ? 'failed' : 'skipped',
        ms: (o.finishedAt ?? 0) - (o.startedAt ?? 0),
        report: (o.result as { report?: string } | undefined)?.report,
        error: o.error,
      }));

      const gitAfter = await inspectGit(root);
      const dirtyAfter = gitAfter.kind === 'dirty' ? gitAfter.changed : [];
      // git が一つのフォルダ（`coverage/`）にまとめて見せる新しいフォルダの下は、外の変化でも一つずつ並べない（何千件にふくらむ）
      const folded = dirtyAfter.filter((p) => p.endsWith('/'));
      const outsideShown = [...outsideChanged].filter((p) => !folded.some((d) => p.startsWith(d)));
      const changed = [...new Set([...written, ...outsideShown, ...dropCoveredDirs(changedBetween(dirtyBefore, dirtyAfter), [...written, ...outsideShown])])].sort();

      const report = accept({
        request, summary: plan.summary, members, changed,
        declared: [...new Set(plan.items.flatMap((t) => t.writes ?? []))],
        verified, verifyDetail,
      });

      /*
       * **確かめて落ちたら、この依頼の変更を全部戻す**（送り口と同じ設定 `harness.rollbackOnGiveUp`）。
       *
       * 戻す材料は「戻す」の記録そのもの。書くツールの分は書く手前に、外のツールと `run_command` の分は
       * 依頼全体の前後比べで、依頼の前の姿が入っている（`takeOutside` は済んでいる）。人が「戻す」を
       * 押したときと同じ道で戻すので、二進も、戻せなかった道の扱いも同じになる。
       * 並列の担当の正しい仕事も一緒に戻る。何を戻したかを言い、次の依頼でやり直せる形にする。
       */
      let rolledBack: string[] | undefined;
      // 止めた回は、確かめが途中で切れて「落ちた」に見えるだけ。落ちたとは言えないので戻さない。
      if (verified === 'failed' && !ac.signal.aborted && (this.config.harness ?? {}).rollbackOnGiveUp) {
        const point = await this.undo.end().catch((e: unknown) => e as Error);
        if (point instanceof Error) {
          yield { type: 'log', level: 'warn', text: `確かめて落ちましたが、この依頼の戻り先を残せなかったので、自動では戻していません（${point.message}）。「戻す」からも戻せません` };
        }
        /*
         * **いちばん新しい戻り先のときだけ当てる。**`restore` は選んだ戻り先より新しいものも全部当てる。
         * 記録の保存先は一つで、別の Session や CLI が同じ保存先を使うと、この依頼の後に始まって閉じた
         * 別の戻り先が在り得る。黙ってそれまで戻さない。戻さなかったことは言う。
         */
        const kept = point instanceof Error ? undefined : point;
        const listed = kept ? await this.undo.list().catch((e: unknown) => e as Error) : undefined;
        const newest = kept && !(listed instanceof Error) ? listed?.[0]?.id === kept.id : false;
        if (listed instanceof Error) {
          yield { type: 'log', level: 'warn', text: `確かめて落ちましたが、戻り先の一覧を読めなかったので、自動では戻していません（${listed.message}）` };
        } else if (kept && !newest) {
          yield { type: 'log', level: 'warn', text: '確かめて落ちましたが、この依頼の後に別の作業の戻り先ができているので、自動では戻していません（「戻す」から選んでください）' };
        }
        const tried = kept && newest ? await this.undo.restore(kept.id).catch((e: unknown) => e as Error) : undefined;
        if (tried instanceof Error) {
          // 戻せなかった（読めない戻り先がある等）。依頼の結末は変えず、戻していないことを言う（依頼の出来事の流れに残す）
          yield { type: 'log', level: 'warn', text: `確かめて落ちましたが、自動では戻せませんでした（${tried.message}）。「戻す」から選んでください` };
        }
        const done = tried instanceof Error ? undefined : tried;
        // 戻せなかった道は notRestored で出すので、ここでは片づけの失敗だけを言う
        for (const text of done ? restoreWarnings(done) : []) yield { type: 'log', level: 'warn', text: `自動で戻しましたが、${text}` };
        const notRestored = [...new Set([...this.undo.peekSkipped(), ...(done?.failed ?? [])])].sort();
        rolledBack = done?.paths ?? [];
        // 作業場は依頼の前に戻った。次の回の「前」も依頼の前のもの（戻せなかった分があれば分からないので忘れる）。
        if (command) {
          if (done && notRestored.length === 0 && baseline) this.baselineProbe.note(command, baseline);
          else this.baselineProbe.invalidate(command);
        }
        if (rolledBack.length > 0 || notRestored.length > 0) {
          yield { type: 'rolledBack', paths: rolledBack, ...(notRestored.length > 0 ? { notRestored } : {}) };
          // 開いている画面に、戻した中身を配る（「戻す」を押したときと同じ）。
          for (const c of done?.changed ?? []) {
            const diff = unifiedDiff(c.path, c.before ?? '', c.after ?? '');
            const { added, removed } = diffStat(diff);
            yield { type: 'diff', path: c.path, diff, added, removed, created: c.before === undefined };
          }
        }
      }
      yield { type: 'accepted', report };

      // 止めた回は覚えない・点を付けない。止めただけの手を「駄目だった手」として次の段取りに渡さない（送り口と同じ）。
      if (stopped()) {
        this.#harness.endTask('failed');
        await this.#harness.metrics?.save();
        this.markChanged();
        return report;
      }

      // 起きたことを覚える。同じ手を二度試さないため。
      this.memory.remember({
        kind: 'attempt',
        title: asked,
        detail: [
          plan.summary,
          report.verdict === 'rejected'
            ? `受け取れず: ${report.concerns.map((x) => x.reason).join(' / ')}`
            : `${members.filter((m) => m.state === 'done').length}/${members.length}件完了、検査は${verified}`,
          ...(rolledBack ? [`確かめて落ちたので巻き戻した（${rolledBack.length}件）`] : []),
        ].join(' — '),
        tags: changed.slice(0, 5),
        // **確かめて通ったときだけ「うまくいった」。**
        // 受け取れたことと、動くことは別。ここを一緒にすると、
        // 動かない手を「うまくいった手」として覚え続ける。
        // 確かめて落ちたときだけ「駄目だった手」。分からない（時間切れ・読めない）・確かめていない・元からは、良し悪しを付けない
        // （送り口と同じ。「駄目だった」は遠くまで運ばれ、次の段取りに避ける手として渡る）
        ...(verified === 'passed' ? { outcome: 'worked' as const } : {}),
        ...(verified === 'failed' ? { outcome: 'failed' as const } : {}),
        source: 'plan',
        root: this.root,
      });
      this.#gradeRecall(verified === 'passed' ? 'passed' : verified === 'failed' ? 'failed' : verified === 'unsure' ? 'unsure' : 'notRun');
      this.#compactMemory();
      // 止めた規則が、通り道になったのか邪魔になったのかは、結末で決まる。
      this.#harness.endTask(report.verdict === 'accepted' ? 'completed' : 'failed');
      await this.#harness.metrics?.save();
      this.markChanged();
      return report;
    } catch (e) {
      this.#harness.endTask('failed');
      await this.#harness.metrics?.save();
      yield { type: 'log', level: 'error', text: (e as Error).message };
      return undefined;
    } finally {
      // 担当の途中で落ちた・止めた回も、そこまでに外のツールが変えた分を戻せるように。
      await takeOutside();
      await this.#closeUndo();
      // 錠を返してから「動いていない」にする（送り口と同じ）。
      this.lock.release(lockOwner);
      this.#conv.running = undefined;
      await this.saveMemory();
    }
  }

  /**
   * 暇なときの思考。
   *
   * 何を考えるかはハーネス側のスケジューラが決める。
   * 「変わっていないのに考え直す」「予算を超えて考える」
   * 「役に立たなかった考え方を繰り返す」を、そこで止める。
   *
   * 考えた結果は提案として溜めるだけで、実行はしない。
   * 勝手に手を動かされるのと、勝手に考えてくれるのは、別の話。
   */
  /** 手がかりごとに、考えごとが落ちた回数（立ち上げ直すと数え直す）。 */
  readonly #reconFailures = new Map<string, number>();
  /** 同じ手がかりで何回落ちたら、調べたことにして次へ進むか。 */
  static readonly #RECON_GIVE_UP = 3;

  async *think(): AsyncGenerator<ThinkEvent, boolean> {
    // **断る理由は必ず言う。**黙るかどうかは、呼ぶ側が決める（見回りは黙る）。
    if (this.noModel) {
      yield { type: 'declined', reason: `使えるモデルがありません: ${this.modelReason}` };
      return false;
    }
    if (this.config.initiative?.enabled === false) {
      yield { type: 'declined', reason: '設定で、暇なときの考えごとを止めています（initiative.enabled）' };
      return false;
    }
    if (this.anyBusy) {
      yield { type: 'declined', reason: 'いま別の作業をしています' };
      return false;
    }

    const now = Date.now();
    const due = this.duties.due(now).map((s) => ({
      dutyId: s.duty.id, modeId: s.duty.modeId,
      codename: s.duty.codename, isCatchUp: s.isCatchUp,
    }));

    const decision = await this.idle.choose(
      { lastChangeAt: this.#lastChangeAt, openProposals: this.proposals.open().length, now },
      due,
    );
    if (!decision.mode) {
      // 割り当ての側は理由を組み立てている。**ここで捨てない。**
      yield { type: 'declined', reason: decision.reason ?? '今回は見送りました' };
      return false;
    }

    const mode = decision.mode;
    const role = this.roles.get(MODE_ROLE[mode.id] ?? 'scout') ?? this.roles.get('scout')!;
    const snap = await this.#prefetch.snapshotWithin(3000);

    let context = snap ? describeSnapshot(snap) : '';
    let fingerprint = `${mode.id}:${Date.now()}`;
    let files: string[] = [];

    // 外へ出る前に、手元を数えて渡す。
    // 「何か新しい話は無いか」と漠然と出しても、雑音しか持ち帰らない。
    // 「この依存のどれが古いか」なら、答えは一つに定まる。
    if (mode.id === 'briefing') {
      const deps = await inspectDependencies(this.root);
      context = `${context}\n\n${describeDependencies(deps)}`;
    }

    // UPKEEP は道具の側の話。BRIEFING（利用者の仕事の話）とは持ち場が違う。
    // 混ぜると、利用者にとって必要な報告が道具の都合に押し出される。
    let upkeepStopped = false;
    if (mode.id === 'upkeep') {
      // 人が思い出したときだけ確かめる作りでは、結局は古いまま使い続ける。
      // 機械が定期的に見に行き、出ていたら提案として上げる。
      try {
        /*
         * **名前の頭で、使っている道を判じない。**
         *
         * ここは `ollama:` で始まる候補だけを見ていた。中で読む道（inproc）
         * では候補が `inproc:Foo.gguf` の形なので、一件も当たらない。
         * つまり**この構成では、新しい世代を一度も見に行っていなかった**。
         * 作ってはあるのに、繋がっていなかった。
         *
         * 何も入っていないときは、カタログの家族から訊く。入れた直後は
         * 何も入っていないので、そこで黙ると最初の一つが古いまま固定される。
         */
        const using = this.candidates.map((c) => {
          const at = c.indexOf(':');
          return at < 0 ? c : c.slice(at + 1);
        });
        // 配布元への問い合わせも ■ で止められるようにし、上限で打ち切る。考えごとの間は人の送信が順番待ちになるので、
        // 返事が来ないと（最大で約 5 分）その間ずっと待たせていた
        const probe = new AbortController();
        this.#conv.running = probe;
        const asked = AbortSignal.any([probe.signal, AbortSignal.timeout(UPDATE_PROBE_TIMEOUT_MS)]);
        const newer = await findNewerFor({
          runtimeKind: this.config.runtime?.kind ?? 'inproc',
          installed: using,
          seed: catalogFamilies(),
          signal: asked,
        }).finally(() => { if (this.#conv.running === probe) this.#conv.running = undefined; });
        // 止めた・打ち切った問い合わせは、中で失敗を握って空を返す。空を「新しい世代は無かった」と読まない（下の catch で「訊けなかった」と書く）
        if (probe.signal.aborted) upkeepStopped = true;
        if (asked.aborted) throw new Error(probe.signal.aborted ? '止めました' : `${UPDATE_PROBE_TIMEOUT_MS / 1000} 秒で返事が揃いませんでした`);
        context = [
          `いま使っているモデル: ${using.join(', ') || '(ローカルの指定なし)'}`,
          '',
          describeNewer(newer),
        ].join('\n');
      } catch (e) {
        // 配布元へ行けないのは、この思考を止める理由にはならない。
        // ただし「無かった」と混同させない。行けなかったと書く。
        context = `配布元に訊けませんでした（${describeNet(e)}）。`
          + '新しいものが無いのか、繋がらなかっただけなのかは分かりません。';
      }
    }

    // ■で止めたなら、考えごとも続けない（問い合わせだけ止めて、モデルは呼び出す、にしない）
    if (upkeepStopped) return false;

    // RECON だけは手がかりを機械で探してから渡す。
    // 事実の収集は機械の方が速く、確実で、無料。
    if (mode.id === 'recon') {
      if (!snap) return false;
      const leads = await findLeads({
        root: this.root, snapshot: snap, known: this.proposals.seen(), max: 1,
      });
      if (leads.length === 0) return false;
      const lead = leads[0]!;
      context = `${context}\n\n${investigationPrompt(lead)}`;
      fingerprint = lead.fingerprint;
      files = lead.files;
    }

    this.idle.begin(mode, Date.now());
    yield {
      type: 'chose', modeId: mode.id, codename: mode.codename, name: mode.name,
      roleCodename: role.codename, reason: decision.reason, isDuty: !!decision.dutyId,
    };

    const ac = new AbortController();
    this.#conv.running = ac;
    let text = '';
    // モデルが落ちた・止められたか。`Agent.run` は投げずに `finished` で知らせる
    let broken: string | undefined;
    let finishedWith: string | undefined;
    try {
      const thinker = new Agent(this.orchestrator, {
        candidates: this.candidates,
        system: buildSystemPrompt(role),
        tools: toolsFor(role, this.toolPool),
        root: this.root,
        maxTurns: 8,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        // 考えるだけ。手は動かさない。
        // ただし外を**読む**ことは止めない。読むだけなら、この場所は変わらない。
        // 止めるのは書き込みとコマンド。手を出すことと、調べることは違う。
        approve: async (req) => req.kind === 'network' && this.#opts.approveThinking !== false,
      });
      for await (const ev of thinker.run(
        [{ role: 'user', content: promptFor(mode, context) }], ac.signal,
      )) {
        if (ev.type === 'thinking') text += ev.delta;
        if (ev.type === 'finished') {
          finishedWith = ev.reason;
          if (ev.reason === 'failed' || ev.reason === 'aborted') {
            broken = ev.reason === 'aborted' ? '止められました' : (ev.detail ?? 'モデルが答えませんでした');
          }
        }
      }
    } catch {
      // 考えに失敗しても、この場所は止まらない。
      return true;
    } finally {
      this.#conv.running = undefined;
    }
    // 落ちた・止められた回は、手がかりを「調べた」とも、日課を「済ませた」とも記録しない（前は記録していたので、繋がらなかった
    // 回の手がかりは二度と調べられず、その日の日課は済んだことになった）。次の見回りでもう一度やる
    // 返事が空のまま止まった回も、答えていない（手が止まった回とは違い、何も調べていない）
    if (broken === undefined && finishedWith === 'noProgress' && text.trim() === '') broken = '返事が空でした';
    if (broken !== undefined) {
      // 手がかりは、同じものが決まって落ちる（長すぎて断られる等）と、先へ進めなくなる。3 回落ちたら調べたことにして次へ進む
      if (mode.id === 'recon') {
        const failures = (this.#reconFailures.get(fingerprint) ?? 0) + 1;
        this.#reconFailures.set(fingerprint, failures);
        if (failures >= Session.#RECON_GIVE_UP) {
          this.proposals.markExamined(fingerprint);
          this.#reconFailures.delete(fingerprint);
          await this.saveProposals();
        }
      }
      // 見回りの回数と間合い（`idle.begin` で数えた分）は残す。残さないと、立ち上げ直すと間合いが戻る
      await this.saveAutonomy();
      yield { type: 'failed', codename: mode.codename, reason: broken };
      return true;
    }

    if (mode.id === 'recon') this.proposals.markExamined(fingerprint);

    // 日課として動いたなら、済んだことにする。
    // 報告が無くても「確認した」ことに変わりはない。
    if (decision.dutyId) {
      this.duties.complete(decision.dutyId, Date.now());
      await this.saveAutonomy();
    }

    const parsed = parseProposal(text);
    this.idle.recordOutcome(mode.id, parsed !== undefined);
    await this.saveAutonomy();

    if (!parsed) {
      await this.saveProposals();
      yield { type: 'noFinding', codename: mode.codename };
      return true;
    }

    // 外から持ち帰ったことは覚えておく。同じことを何度も訊きに行かないため。
    if (mode.id === 'briefing') {
      this.memory.remember({
        kind: 'fact', title: parsed.title, detail: parsed.rationale, source: '外部',
      });
      await this.saveMemory();
    }

    const added = this.proposals.add({
      kind: mode.id === 'patrol' ? 'bug' : mode.id === 'briefing' ? 'risk' : 'question',
      title: parsed.title,
      rationale: `[${role.codename}] ${parsed.rationale}`,
      evidence: files,
      suggestedAction: parsed.action,
      fingerprint,
    });
    await this.saveProposals();

    if (added) {
      // どの思考から出た提案かを覚える。採否がその思考の実績になる。
      this.#origin.set(added.id, mode.id);
      yield { type: 'proposal', proposal: added, codename: mode.codename };
    }
    return true;
  }

  /** 提案の採否。役に立ったかどうかが、次に何を考えるかを変える。 */
  async decide(id: string, verdict: 'accepted' | 'rejected'): Promise<Proposal | undefined> {
    // 決まった提案は決め直さない（片づいた提案を開き直して、もう一度実行していた）。ファイルを読み直して、
    // もう一方（画面と端末）が決めた分も見てから決める。
    const target = await this.proposals.settle(id, verdict, { onlyOpen: true });
    if (!target) return undefined;
    const origin = this.#origin.get(target.id);
    if (origin) this.idle.recordVerdict(origin, verdict);
    await this.saveAutonomy();
    return target;
  }

  /** 提案を実行し終えたことにする。 */
  async completeProposal(id: string): Promise<void> {
    await this.proposals.settle(id, 'done');
  }

  /**
   * この依頼の戻り先を閉じて残す。書けなければ（ディスクが一杯・掴まれている）、そう言う。前は黙って捨てていたので、
   * 利用者は「戻す」で戻せるつもりのままだった。依頼そのものは止めない（書き換えは済んでいる）。
   */
  async #closeUndo(): Promise<void> {
    try {
      await this.undo.end();
    } catch (e) {
      this.#opts.onLog?.('warn', `この依頼の戻り先を残せませんでした（${(e as Error).message}）。この依頼の変更は「戻す」からは戻せません`);
    }
  }

  /** 提案を残す。残せなかったら言う（立ち上げ直すと消えるのに、黙って「提案」を出さない）。 */
  async saveProposals(): Promise<void> {
    const failed = await this.proposals.save();
    if (failed) this.#opts.onLog?.('warn', failed.message);
  }

  /** 覚えたことを残す。残せなかったら言う（覚えたつもりで、立ち上げ直すと消えるのを黙らない）。 */
  async saveMemory(): Promise<void> {
    await this.memory.save().catch((e: unknown) => {
      this.#opts.onLog?.('warn', `覚えたことを残せませんでした（${(e as Error).message}）。立ち上げ直すと、残せなかった分は消えます`);
    });
  }

  /** 思考の実績と日課の記録を残す。次の起動でも続きから考えられるように。 */
  async saveAutonomy(): Promise<void> {
    const unsaved = await saveJournals(this).catch(() => []);
    // 読めないまま（EACCES 等）だと書けない日が続く。黙っていると、記録が止まっていることに誰も気づかない。
    if (unsaved.length > 0) this.#opts.onLog?.('warn', `記録を書けませんでした（読めないか、書き込みに失敗）: ${unsaved.join(', ')}`);
  }

  /** 何かが変わった。考え直す価値が生まれたということ。 */
  markChanged(at = Date.now()): void { this.#lastChangeAt = at; }
  get lastChangeAt(): number { return this.#lastChangeAt; }

  /** 検査コマンド。設定 > 先読みが見つけたもの。 */
  /** ベースラインの実行役。設定を読んで一度だけ作る。 */
  get baselineProbe(): BaselineProbe {
    if (!this.#baseline) {
      const cfg = this.config.agent?.verify ?? {};
      this.#baseline = new BaselineProbe(this.root, {
        ...(cfg.baselineTimeoutMs !== undefined ? { timeoutMs: cfg.baselineTimeoutMs } : {}),
        ...(cfg.baselineMaxAgeMs !== undefined ? { maxAgeMs: cfg.baselineMaxAgeMs } : {}),
      });
    }
    return this.#baseline;
  }

  /** 作業前の状態を得る。二度目からは覚えていた結果を返す。 */
  async measureBaseline(command: string, signal: AbortSignal): Promise<BaselineOutcome> {
    return this.baselineProbe.measure(command, signal);
  }

  async verifyCommand(): Promise<string | undefined> {
    const configured = this.config.agent?.verify?.command;
    if (configured) return configured;
    const snap = await this.#prefetch.snapshotWithin(2000);
    // 動かし方（package.json など）を読めなかった。「確かめのコマンドが無い」と同じ顔をさせない（次の依頼で調べ直す）
    if (snap && !snap.ready.includes('commands')) {
      this.#opts.onLog?.('warn', 'この作業場の動かし方（package.json など）を読めなかったので、今回は確かめられません。次の依頼で読み直します');
    }
    // **`check` があるなら、そちらを先に。**`npm test` は型を見ないことが多い。
    // この作業場自身が、型のずれを 30 件溜めてから気づいた。
    return snap?.commands.check ?? snap?.commands.test;
  }

  /** いま動いているものを止める。既定の会話だけでなく、走っている会話を全部止める。止めても対話は続く。 */
  abort(): void {
    this.#conv.running?.abort();
    for (const conv of this.#active) conv.running?.abort();
  }

  /**
   * 指示を受けて、起きたことを順に返す。
   *
   * 「書いて終わり」にしない。テストを流し、失敗したら自分で直させる。
   * 計算が無料なローカルでは、この往復が**時間で品質を買う**手段になる。
   * 打ち切ったときに中途半端な状態を残さないよう、書く前に控えも取る。
   */
  async *send(
    instruction: string,
    opts: {
      /**
       * 利用者が書いたものか。
       *
       * **こちらが組み立てた文を、利用者の言葉として判じない。**
       * やり残しの続き・段取りの一歩・提案の実行は、どれもこちらが書いている。
       * それを指摘として覚えると、**利用者が言っていないことを覚える**。
       */
      fromUser?: boolean;
      /**
       * 利用者が**打った分だけ**。
       *
       * 依頼には、こちらが差し込んだものが前に付くことがある（添付の中身、
       * いま開いている所）。それを「利用者の言葉」として判じると、**選んだ
       * コードを指摘として覚える**。判じるのは、打った分だけにする。
       */
      said?: string;
      /**
       * どの会話で送るか。省けば既定の会話。画面は会話ごとに渡して、二つの会話を同時に動かす
       * （履歴・差分・思い出した記憶・規則の積み重ね・協議が会話ごとに分かれる）。
       */
      conversation?: Conversation;
    } = {},
  ): AsyncGenerator<SessionEvent> {
    const conv = opts.conversation ?? this.#conv;
    /*
     * 既定の会話か。共有の入れ物（ツールを包んだときの依頼文・協議・規則の積み重ねと数え）に触るのは既定の会話だけ。
     * ほかの会話が触ると、並行して走る段取りの判じ方を崩す。ほかの会話の規則の数え（metrics）は、
     * 依頼ごとの札（`metricsKey`）で開いて閉じる（DECISIONS 09-26 の 2e）。
     */
    const shared = conv === this.#conv;
    if (this.noModel) {
      yield { type: 'log', level: 'error', text: this.noModel };
      yield { type: 'finished', reason: 'error', detail: this.noModel };
      return;
    }
    if (conv.running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return;
    }
    const ac = new AbortController();
    conv.running = ac;
    this.#active.add(conv);
    conv.beginRequest(instruction);
    if (shared) this.#holder.instruction = instruction;
    this.#requests += 1;
    if (shared) this.#forum.clear();
    /*
     * **この 1 ターンで触ったものを、後から戻せるようにする。**
     *
     * 覚える名前は**利用者が打った分だけ**にする。依頼にはこちらが差し込んだ
     * ものが前に付くことがあるので（いま開いている所・添付の中身）、そのまま
     * 使うと、横の一覧に「【いま開いているファイル】a.ts（3 行目）」と出て、
     * **どの依頼を戻すのか人が選べない**（押して実測）。
     */
    // 打った分が空（添付だけを送った回）なら、差し込んだ方を使う。空の名前を残さない。
    const undoName = opts.said || instruction;

    const verifyCfg = this.config.agent?.verify ?? {};
    const harnessCfg = this.config.harness ?? {};
    /*
     * **訊かれただけなのか、作業を頼まれたのかを、ここで一度だけ決める。**
     * 決めた結果は、この 1ターンの中で変えない（途中で服が変わると話が割れる）。
     */
    const chat = looksLikeChat(instruction);
    const started = Date.now();
    const checkpoint = new Checkpoint(this.root);
    /*
     * **外のツール（MCP）と `run_command` が変えた分も、巻き戻しと「戻す」に載せる。**
     *
     * この場所の書くツールは書く直前に前の中身を渡してくれるが、外のツールは何を書くか
     * 前もって分からない。呼ぶ前後で作業場を比べ、前の中身は呼ぶ前に読んだものか
     * git の索引から取る（`src/agent/outside-changes.ts`）。載せないと、打ち切って
     * 巻き戻したとき、この場所で書いた分だけ戻って外のツールの分が残る。
     */
    const outside = new OutsideChanges(this.root);
    const outsideTool = (name: string): boolean => isExternalTool(name) || name === 'run_command';
    /*
     * **書き得る手を初めて使う時点で、作業場の錠を取り、「戻す」の記録を始める。**
     *
     * 読むだけの回（質問・調べもの）は錠を取らず、ほかの会話と並んで動ける。錠を取ってから記録を始めるので、
     * 二つの会話の書き込みが一つの戻り先に混ざらない。ツールはこちらが次の出来事を受け取ってから動くので、
     * ここで待てば書く前に止まる。
     */
    const lockOwner = `send:${++this.#lockSeq}`;
    let locked = false;
    const takeLock = async (name: string): Promise<void> => {
      if (locked || !(mayChangeFiles(name) || isWriteTool(name) || outsideTool(name))) return;
      await this.lock.acquire(lockOwner, ac.signal);
      locked = true;
      await this.undo.begin(undoName);
    };
    /** 前の中身を記録できなかった道（大きすぎる・取れない）。戻せないことを言うために持つ。 */
    const outsideUnrecorded: string[] = [];
    // 依頼の番号はこの依頼の間は変わらない（同じ会話の次の依頼は、これが終わるまで始まらない）。
    const metricsKey = conv.request.metricsKey();
    if (shared) this.#harness.beginTask();
    else this.#harness.metrics?.beginTask(metricsKey);
    /*
     * 依頼の数えを閉じる。一度だけ。受け取る側が途中で抜けると（`for await` の break）、try の終わりも
     * catch も通らず finally だけが走るので、そこでも閉じる。閉じないと札が開いたまま残り続ける。
     */
    let metricsEnded = false;
    const endMetrics = (outcome: 'completed' | 'failed'): void => {
      if (metricsEnded) return;
      metricsEnded = true;
      if (shared) this.#harness.endTask(outcome);
      else this.#harness.metrics?.endTask(outcome, metricsKey);
    };

    let finishedReason: string | undefined;
    let answerChars = 0;
    /** 答えたモデル。途中で切り替わったら、その先を覚える。 */
    let modelUsed = this.candidates[0] ?? '';
    /*
     * **速さを測り始める時刻。途中でモデルが変わったら、そこから測り直す。**
     *
     * 最初の候補が落ちるまでの時間（やり直しの待ちも入る）を、答えた側の
     * 秒数に混ぜていた。混ぜたぶん遅く見えるので、**答えたモデルが遅いことに
     * される。**その数字は次のモデル選びに使われる（`autopilot.record`）ので、
     * 一度混ぜると選び方まで狂う。
     */
    let measuredFrom = started;
    // 巻き戻すかどうか（従来の意味）。確かめて落ちたときだけ倒す。
    let keep = true;
    // 実際に確かめたか、どうだったか。**確かめていないことを、通ったと言わない。**
    let checked: 'passed' | 'failed' | 'preexisting' | 'unsure' | 'notRun' = 'notRun';

    /*
     * 嫌がっていないかを見る材料は、**ここで押さえる。**
     *
     * 判じるのは、この回が終わってから（下の finally）。
     * **先に判じると、利用者の依頼がその後ろに並ぶ。**
     * 中で読む道は同じモデルへの呼び出しを順番待ちにするので、
     * 判じ終わるまで返事が始まらない。「待たせない」は嘘だった。
     *
     * 場面（直前の指示）は、この回の記録で上書きされる前に取る。
     */
    const situation = {
      when: conv.lastTurn?.instruction.trim().slice(0, 120),
      did: this.#lastTurnSummary(conv),
    };

    try {

      // 関係することを思い出して添える。無関係なら何も足さない。
      // **「二度としないこと」はここでは足さない。**決まり（system）が載せる。
      // 両方に載せると、同じ文が一往復に二度入る（実際に八件ずつ二重に入っていた）。
      // 問いかけには、前の作業の覚えを足さない。話が混ざるだけで、答えは良くならない。
      const recalled = chat ? '' : this.#recall(instruction, { lessons: false }, conv);
      if (recalled) yield { type: 'recalled', text: recalled };

      conv.history.push({
        role: 'user',
        content: recalled ? `${instruction}\n\n---\n${recalled}` : instruction,
      });

      const verifyOn = verifyCfg.enabled !== false;
      const command = verifyOn ? await this.verifyCommand() : undefined;

      /*
       * 作業前の状態（テストの控えと、作業前の成否）。
       *
       * **書き換えが起きるまで測らない。**毎回いちばん先に測っていたので、
       * 「この関数は何をしていますか」と訊いただけで検査が丸ごと流れ、
       * 数分ぶん画面が止まって見えた。動いているのか止まっているのかが
       * 分からない、という壊れ方の実体がこれ。
       *
       * 測るのは、最初にファイルを触る直前。そこまでは作業場は変わっていないので、
       * 「作業前」であることは変わらない。
       */
      let baseline: VerifyResult | undefined;
      /** 測っている間に出た出来事。流れの順番を崩さないよう、外へ出して渡す。 */
      const beforeEvents: SessionEvent[] = [];
      /*
       * テストの数は、外のツールの手前でも記録する（軽い）。作業前の成否は、
       * この場所のツールの手前でだけ測る（重い）。分けた理由は `before-work.ts`。
       */
      const before = new BeforeWork({
        enabled: verifyOn,
        snapshot: () => snapshotTests(this.root),
        // 記録を使うのは、確かめる命令があるときだけ（無ければ比べても走らせない）。
        ...(command ? { stamp: () => workspaceStamp(this.root) } : {}),
        measure: async () => {
          if (!command || verifyCfg.baseline === false) return;
          /*
           * **外のツールが先に作業場を変えていたら、ここで測るのは「作業前」ではない。**
           *
           * 測れば、外のツールが落とした分まで「作業前から落ちていた」と読み、
           * この回のせいにしない（直させない）。外のツールを呼んだのもこの回なので、
           * 落ちたものはこの回のものとして扱う。成否は測らず、そう言う。
           * 外のツールの手前で記録が取れなかったとき（git の管理下でない等）は、
           * これまでどおり測る。手前で取れて、いま取れないときは、変わったかもしれない
           * 側に置いて測らない。
           */
          const was = before.stamp;
          if (was) {
            const now = await workspaceStamp(this.root);
            const moved = now ? stampChanges(was, now) : undefined;
            if (moved === undefined || moved.length > 0) {
              /*
               * 走らせずに使える「前」があるなら使う。**この回より前に測った結果**は、
               * 外のツールが触る前の姿。同じ回の中では、この場所のツールより前に測ることは
               * 無いので、覚えているものは必ず外のツールより前（`BaselineProbe` は 30 分まで
               * 覚える。普通の道でも同じ古さのものを使っている）。
               */
              const kept = this.baselineProbe.remembered(command);
              if (kept?.result) {
                baseline = kept.result;
                beforeEvents.push({ type: 'outsideChanged', paths: moved, beforeBaseline: true, remembered: true });
                beforeEvents.push({
                  type: 'baseline', command, passed: kept.status === 'passed', cached: true,
                  ...(kept.reason !== undefined ? { detail: kept.reason } : {}),
                });
              } else {
                beforeEvents.push({ type: 'outsideChanged', paths: moved, beforeBaseline: true });
              }
              return;
            }
          }
          const probed = await this.measureBaseline(command, ac.signal);
          baseline = probed.result;
          beforeEvents.push({
            type: 'baseline', command,
            passed: probed.status === 'passed',
            cached: probed.cached,
            ...(probed.status === 'unknown' ? { unknown: true } : {}),
            ...(probed.reason !== undefined ? { detail: probed.reason } : {}),
          });
        },
      });

      /*
       * 効かなかったツールを数える。
       *
       * **「書き換えました」と言われても、書けているとは限らない。**
       * 読む前に書こうとして規則に止められたのに、本文は「書き換えました」で、
       * 画面は「完了」と出ていた（実測）。言葉ではなく、結果で判じる。
       */
      const failedTools: string[] = [];
      let wroteSomething = false;
      /** この回で触ったもの。覚えるときの手がかりにする。 */
      const changedHere: string[] = [];
      /** この回で使った道具。嫌がられたときに、何をしていたかを言うために持つ。 */
      const usedTools: string[] = [];

      const run = async function* (this: Session, agent: Agent): AsyncGenerator<SessionEvent> {
        for await (const ev of agent.run(conv.history, ac.signal)) {
          switch (ev.type) {
            case 'thinking':
              answerChars += ev.delta.length;
              yield { type: 'text', delta: ev.delta };
              break;
            case 'salvaged':
              yield { type: 'salvaged', name: ev.name };
              break;
            case 'nudged':
              yield { type: 'nudged', left: ev.left };
              break;
            case 'trimmed':
              yield { type: 'trimmed', dropped: ev.dropped };
              break;
            case 'toolStart':
              await takeLock(ev.call.name);
              // 作業場を変える手前で、作業前の状態を控える。
              await before.atToolStart(ev.call.name);
              while (beforeEvents.length > 0) yield beforeEvents.shift()!;
              // 書き込む前の状態を控える。打ち切ったときに戻せるように。
              if (isWriteTool(ev.call.name) && harnessCfg.rollbackOnGiveUp) {
                const p = (ev.call.args as { path?: unknown }).path;
                if (typeof p === 'string') await checkpoint.capture(p);
              }
              if (outsideTool(ev.call.name)) await outside.before();
              yield { type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) };
              break;
            case 'toolEnd': {
              usedTools.push(ev.call.name);
              // 何が効いて何が効かなかったかを数える。**言葉ではなく、結果で見る。**
              if (ev.isError) failedTools.push(ev.call.name);
              else if (isWriteTool(ev.call.name)) {
                wroteSomething = true;
                const at = (ev.call.args as { path?: unknown }).path;
                if (typeof at === 'string' && !changedHere.includes(at)) changedHere.push(at);
              }
              // 外のツールが変えた分を記録する。失敗して返っても、途中まで書いたかもしれない。
              if (outsideTool(ev.call.name)) {
                const found = await outside.after();
                for (const c of found.changes) {
                  if (harnessCfg.rollbackOnGiveUp) checkpoint.remember(c.path, c.previous);
                  this.undo.capture(c.path, c.previous);
                  if (!changedHere.includes(c.path)) changedHere.push(c.path);
                }
                for (const path of found.unrecorded) { this.undo.skip(path); outsideUnrecorded.push(path); }
                if (found.changes.length > 0 || found.unrecorded.length > 0) wroteSomething = true;
              }
              if (!ev.isError && mayChangeFiles(ev.call.name)) this.#prefetch.invalidate();
              yield {
                type: 'toolEnd', name: ev.call.name, ok: !ev.isError, summary: firstLine(ev.result),
              };
              const shown = this.#diffFor(ev.call.name, ev.call.args, ev.isError, conv);
              if (shown) yield shown;
              break;
            }
            case 'fallback':
              modelUsed = ev.to;
              // 前のモデルに使った時間と文字を、次のモデルの分として数えない。
              measuredFrom = Date.now();
              answerChars = 0;
              yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
              break;
            case 'retry':
              // 流れと記録（ui.log）に残す。落ちるまでの秒数の内訳がここで分かる。
              yield {
                type: 'log', level: 'warn',
                text: `やり直します（${ev.attempt + 1} 回目、${Math.round(ev.elapsedMs / 1000)} 秒経過）: ${ev.modelId}`,
              };
              break;
            case 'finished':
              finishedReason = ev.reason;
              yield { type: 'finished', reason: ev.reason, detail: ev.detail };
              break;
          }
        }
      }.bind(this);

      yield* run(await this.#agent({ chat, conv }));

      /*
       * 実測を溜める。次回以降の自動選択がこれで変わる。
       *
       * **答えたモデルに付ける。**ここは候補の先頭に付けていたので、
       * 途中で別のモデルへ移った回の成否と速さが、**一度も答えていない
       * モデルの成績**になっていた。選び方がその数字で決まるので、
       * 付け先を間違えると、以後ずっと間違った方を選び続ける。
       */
      if (modelUsed) {
        await this.pilot.autopilot.record({
          modelId: modelUsed,
          success: finishedReason === 'completed',
          outputTokens: Math.round(answerChars / 3),
          seconds: (Date.now() - measuredFrom) / 1000,
        });
      }

      // ツールが全部弾かれたのに、本文だけが「やりました」になっている形を見逃さない。
      if (finishedReason === 'completed' && failedTools.length > 0 && !wroteSomething) {
        yield { type: 'toolsFailed', names: [...new Set(failedTools)] };
      }

      /** この回の終わりに分かった作業場の成否。巻き戻さなければ、次の回の「前」になる。 */
      let verifiedLast: VerifyResult | undefined;
      /** 外のツールだけの回で引いた、覚えている「前」。巻き戻した後の「前」はこれ。 */
      let keptBefore: VerifyResult | undefined;
      // 書いて終わりにしない。失敗したら、その内容を渡して直させる。
      const testsBefore = before.measured ? before.tests : undefined;
      if (finishedReason === 'completed' && testsBefore && command) {
        keep = false;
        const events: SessionEvent[] = [];
        const fix = async (feedback: string, sig: AbortSignal): Promise<void> => {
          conv.history.push({ role: 'user', content: feedback });
          for await (const ev of (await this.#agent({ chat, conv })).run(conv.history, sig)) {
            if (ev.type === 'thinking') events.push({ type: 'text', delta: ev.delta });
            else if (ev.type === 'salvaged') events.push({ type: 'salvaged', name: ev.name });
            else if (ev.type === 'toolStart') {
              await takeLock(ev.call.name);
              if (isWriteTool(ev.call.name) && harnessCfg.rollbackOnGiveUp) {
                const p = (ev.call.args as { path?: unknown }).path;
                if (typeof p === 'string') await checkpoint.capture(p);
              }
              if (outsideTool(ev.call.name)) await outside.before();
              events.push({ type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) });
            } else if (ev.type === 'toolEnd') {
              if (!ev.isError && mayChangeFiles(ev.call.name)) this.#prefetch.invalidate();
              /*
               * 直させている間に書いたものも「この依頼で触ったもの」に載せる（本体の周と同じ）。載せていなかったので、巻き戻しで
               * 前を読めなかった道の報告（`checkpoint.unrecorded(changedHere)`）からこの周の分が漏れ、戻せていないのに全部戻したと言っていた
               */
              if (!ev.isError && isWriteTool(ev.call.name)) {
                wroteSomething = true;
                const at = (ev.call.args as { path?: unknown }).path;
                if (typeof at === 'string' && !changedHere.includes(at)) changedHere.push(at);
              }
              if (outsideTool(ev.call.name)) {
                const found = await outside.after();
                for (const c of found.changes) {
                  if (harnessCfg.rollbackOnGiveUp) checkpoint.remember(c.path, c.previous);
                  this.undo.capture(c.path, c.previous);
                  if (!changedHere.includes(c.path)) changedHere.push(c.path);
                }
                for (const path of found.unrecorded) { this.undo.skip(path); outsideUnrecorded.push(path); }
              }
              events.push({
                type: 'toolEnd', name: ev.call.name, ok: !ev.isError, summary: firstLine(ev.result),
              });
              const shown = this.#diffFor(ev.call.name, ev.call.args, ev.isError, conv);
              if (shown) events.push(shown);
            }
          }
        };

        const loop = verifyLoop(
          {
            command, root: this.root,
            maxRounds: verifyCfg.maxRounds,
            timeBudgetMs: verifyCfg.timeBudgetMs,
            commandTimeoutMs: verifyCfg.commandTimeoutMs,
          },
          fix, ac.signal, testsBefore, baseline,
        );
        let step = await loop.next();
        while (!step.done) {
          const ev = step.value;
          if (ev.type === 'passed') { keep = true; checked = 'passed'; }
          // 元から落ちていたものは、この作業のせいにしない（巻き戻さない）。
          // ただし**通ったとも言わない**。落ちているものは落ちている。
          else if (ev.type === 'preexisting') { keep = true; checked = 'preexisting'; }
          // 試験は通ったがテストを読めなかった。失敗にしない（巻き戻さない）。段取り・外のツールの道と同じ扱い
          else if (ev.type === 'giveUp' && ev.reason === 'unsure') { keep = true; checked = 'unsure'; }
          else if (ev.type === 'failed') checked = 'failed';
          yield { type: 'verify', event: ev };
          // 直させている間に出たものも、そのまま見せる。黙って直させない。
          while (events.length > 0) yield events.shift()!;
          step = await loop.next();
        }
        while (events.length > 0) yield events.shift()!;
        // 止めた・時間切れの途中の出力を「前」として覚えない（外のツールだけの分岐と同じ守り）。
        if (!ac.signal.aborted && step.value.last && !step.value.last.timedOut) verifiedLast = step.value.last;
      }

      /*
       * **外のツールだけの回。作業場が変わっていたら、一度だけ確かめる。**
       *
       * 上の確かめは、この場所のツールで書く手前に作業前の成否を測った回だけ回る。
       * 外のツール（MCP）で書いて終わった回は、何も確かめずに「完了」になっていた。
       *
       * 作業前の成否は測っていない（外のツールの手前で測ると 1ターンが何十秒も
       * 伸びる）。だから**直させない。**落ちたものが元から落ちていたのか分からない
       * ままモデルに直させると、関係の無い所まで書き換えにいく。一度走らせて、
       * 結果をそのまま見せるところまで。
       *
       * 読むだけの MCP を呼んだ回は、作業場が変わっていないので走らせない。
       */
      if (finishedReason === 'completed' && before.snapped && !before.measured && command) {
        const was = before.stamp;
        const now = was ? await workspaceStamp(this.root) : undefined;
        const paths = was && now ? stampChanges(was, now) : undefined;
        if (paths === undefined) {
          /*
           * 比べられない作業場。一度伝われば済むので、了解済みならもう言わない。
           * 了解が効くのは**呼ぶ前から比べられなかった**回だけ。手前では比べられたのに
           * 今は比べられない（途中で `.git` が消えた等）は別のことなので、了解で黙らせない。
           */
          if (!was) {
            if (!(await this.acks.has('outside-uncomparable', this.root))) {
              yield { type: 'outsideChanged', paths: undefined, ackable: 'outside-uncomparable', root: this.root };
            }
          } else {
            yield { type: 'outsideChanged', paths: undefined };
          }
        } else if (paths.length > 0 && !ac.signal.aborted) {
          yield { type: 'outsideChanged', paths };
          // 覚えている「前」は、走らせる前に引く。走らせた後に引くと、確かめの長さで期限の境目が動く。
          const kept = this.baselineProbe.remembered(command);
          keptBefore = kept?.result;
          yield { type: 'verify', event: { type: 'running', round: 1, command } };
          const r = await runVerification(
            { command, root: this.root, commandTimeoutMs: verifyCfg.commandTimeoutMs }, ac.signal);
          if (!ac.signal.aborted && !r.timedOut) verifiedLast = r;
          // テストを消して通す形は、通っていても通ったとは言わない（上と同じ判じ方）。
          const verdict = r.passed && before.tests
            ? compareTests(before.tests, await snapshotTests(this.root))
            : { ok: true as const };
          if (ac.signal.aborted) {
            // **止められたものを「落ちた」と言わない。**直させるループの側と同じ言い方にする。
            yield { type: 'verify', event: { type: 'giveUp', reason: 'aborted', detail: '止めました' } };
          } else if (!verdict.ok) {
            // テストが減ったのは、この回が呼んだ外のツールのせい。はっきり失敗。
            keep = false; checked = 'failed';
            yield { type: 'verify', event: { type: 'tampered', reason: verdict.reason ?? 'テストが減っています' } };
          } else if ('unsure' in verdict && verdict.unsure) {
            // 読めなかっただけ。通ったとは言わないが、巻き戻しもしない（確かめはこの一回きり）
            checked = 'unsure';
            yield { type: 'verify', event: { type: 'giveUp', reason: 'unsure', detail: verdict.unsure } };
          } else if (r.passed) {
            checked = 'passed';
            yield { type: 'verify', event: { type: 'passed', round: 1, durationMs: r.durationMs } };
          } else if (r.timedOut) {
            checked = 'unsure';
            yield { type: 'verify', event: { type: 'giveUp', reason: 'timeBudget', detail: '確かめが時間内に終わりませんでした' } };
          } else {
            /*
             * **落ちた。この回のせいかは、覚えている「前」があれば言える。**
             *
             * この回より前に測った結果（`remembered`）と同じ落ち方なら元から。前は通っていた、
             * または別の落ち方なら、外のツールで落ちた（打ち切りと同じく巻き戻す）。
             * 覚えていなければ、分からないは分からないで持つ。`failed` にすると、思い出した
             * 記憶に失点を付け、画面の「原因とは限りません」と記録が食い違う。
             */
            const digest = digestFailure(r.output);
            if (kept?.result && !kept.result.passed && digestFailure(kept.result.output) === digest) {
              checked = 'preexisting';
              yield { type: 'verify', event: { type: 'preexisting', digest } };
            } else if (kept?.result) {
              keep = false; checked = 'failed';
              yield { type: 'verify', event: { type: 'failed', round: 1, digest } };
            } else {
              checked = 'unsure';
              yield { type: 'verify', event: { type: 'failed', round: 1, digest } };
            }
          }
        }
      }

      // 打ち切ったなら、中途半端な状態を残さない選択肢を持つ。
      // 書く前の中身を読めず、そのうえで書き込めた道も、戻せない道として言う（checkpoint は触らずに残す）
      const unrecorded = [...new Set([...outsideUnrecorded, ...checkpoint.unrecorded(changedHere)])].sort();
      // 止めた回は巻き戻さない（打ち切ったのではなく、利用者が止めた。team の側と同じ）
      if (!keep && !ac.signal.aborted && harnessCfg.rollbackOnGiveUp && (checkpoint.size > 0 || unrecorded.length > 0)) {
        // 戻せなかった道だけの回も黙らない。「打ち切ったら戻る」つもりの人に、戻っていないことを言う。
        // 前の中身を記録できなかった道と、置き戻しに失敗した道（掴まれている・フォルダに入れ替わった）の両方。
        const r = await checkpoint.restoreAll();
        const notRestored = [...new Set([...unrecorded, ...r.failed])].sort();
        yield { type: 'rolledBack', paths: r.restored, ...(notRestored.length > 0 ? { notRestored } : {}) };
        /*
         * 作業場は回の前に戻った（戻せなかった分を除く）。次の回の「前」も、回の前のもの。
         * この場所で書く手前に測ったもの（`baseline`）か、外のツールだけの回で引いた覚え（`keptBefore`）。
         * 戻せなかった分があるなら、いまの姿は分からないので忘れる。
         */
        const before = baseline ?? keptBefore;
        if (notRestored.length === 0 && before) this.baselineProbe.note(command!, before);
        else if (command) this.baselineProbe.invalidate(command);
      } else {
        checkpoint.commit();
        if (command) {
          // 回の終わりに分かった姿を、次の回の「前」として覚える（測った時点のままにしない）。
          if (verifiedLast) this.baselineProbe.note(command, verifiedLast);
          // 打ち切ったのに終わりの姿が分からない（止めた・時間切れ）なら、測った時点の姿も忘れる。
          // 残したままだと、次の回の外のツールに、この回が残した失敗を着せる。
          else if (!keep) this.baselineProbe.invalidate(command);
        }
      }

      // 添えた覚えに、結果を書き戻す。ここが「使うほど賢く」の要。
      this.#gradeRecall(checked, conv);
      // 次に嫌がられたとき、「このとき何をしていたか」を言えるようにする。
      conv.lastTurn = { instruction, tools: usedTools, changed: changedHere, checked };

      /*
       * この回のことを覚える。
       *
       * **覚えていたのは、段取りを組んだ回だけだった。**普通の依頼では
       * 何も残らないので、いくら使っても手持ちが増えない。それでは
       * 「使うほど賢くなる」にならない。
       *
       * ただし**何でも覚えない。**
       *   ・作業場が変わっていない回（訊いただけ）は覚えない。雑談で埋まる
       *   ・確かめていない回に「うまくいった」と付けない。
       *     付けると、動かない手を「うまくいった手」として覚え続ける
       */
      if (wroteSomething) {
        this.memory.remember({
          kind: 'attempt',
          // **打った分だけを題にする**（戻り先の名前と同じ）。依頼には添付の中身・開いているファイル・指名で読んだ中身が
          // 前に付く。そのまま題にすると、ファイルの中身が記憶に残り続け（会話を消しても残る）、思い出すたびに丸ごと依頼へ差し込まれていた
          title: undoName,
          detail: [
            changedHere.length > 0 ? `触ったもの: ${changedHere.slice(0, 5).join(', ')}` : '',
            checked === 'passed' ? '確かめて通った'
              : checked === 'failed' ? '確かめたが通らなかった'
              : checked === 'preexisting' ? '元から落ちていた'
              : checked === 'unsure' ? '通らなかったが、この回が原因かは分からない'
              : '確かめていない',
          ].filter(Boolean).join(' — '),
          tags: changedHere.slice(0, 5),
          // **確かめた回だけ、良し悪しを付ける。**
          ...(checked === 'passed' ? { outcome: 'worked' as const } : {}),
          ...(checked === 'failed' ? { outcome: 'failed' as const } : {}),
          source: 'send',
          root: this.root,
        });
        this.#compactMemory();
      }

      const succeeded = finishedReason === 'completed' && keep;
      endMetrics(succeeded ? 'completed' : 'failed');
      await this.#harness.metrics?.save();
      this.#prefetch.invalidate();
      this.markChanged();

      yield {
        type: 'settled',
        // 確かめの最中（担当の後）に止めても、担当の終わり方は completed のまま。止めたなら止めたと言う（「済んだ」として次の段へ進ませない）
        reason: ac.signal.aborted ? 'aborted' : (finishedReason ?? 'failed'),
        verified: checked === 'passed',
        checked,
        ...(chat ? { chat: true } : {}),
        seconds: (Date.now() - started) / 1000,
        ...speedOf(modelUsed, answerChars, (Date.now() - measuredFrom) / 1000),
      };
    } catch (e) {
      /*
       * 止めた回（作業場の錠を待っている間に止めた等）は「失敗」にしない。止めたと言う。
       * 失敗として残すと、止めただけの手が「駄目だった手」として覚えられる。
       */
      const stopped = ac.signal.aborted;
      // 一度の失敗で対話ごと終わらせない。次の指示は受けられる。
      // 規則の数え（harness）は、通常の止めた回と同じく「完了しなかった」に数える。
      endMetrics('failed');
      // 失敗の回も数えを残す（成功の回でしか保存しないと、次の成功まで結末がファイルに無い）。
      await this.#harness.metrics?.save();
      if (!stopped) yield { type: 'log', level: 'error', text: (e as Error).message };
      yield {
        type: 'settled', reason: stopped ? 'aborted' : 'failed', verified: false, checked,
        ...(chat ? { chat: true } : {}),
        seconds: (Date.now() - started) / 1000, detail: (e as Error).message,
        ...speedOf(modelUsed, answerChars, (Date.now() - measuredFrom) / 1000),
      };
    } finally {
      // **この一往復ぶんを、戻り先として残す。**触っていなければ残らない（錠を取っていなければ始めてもいない）。
      if (locked) await this.#closeUndo();
      if (!metricsEnded) {
        endMetrics('failed');
        await this.#harness.metrics?.save();
      }
      // 錠を返してから「動いていない」にする。逆だと、その間に押した保存が錠に当たって断られる。
      this.lock.release(lockOwner);
      conv.running = undefined;
      this.#active.delete(conv);
      await this.saveMemory();
      // **この回が終わってから判じる。**待たせない、を本当にする。
      // こちらが書いた文は判じない（利用者が言っていないことを覚えないため）。
      // 待たない代わりに、**拾い手を置く。**置かないと、判じるところで
      // 一度失敗しただけでプロセスごと落ちる。
      if (opts.fromUser !== false) {
        void this.#judge(opts.said ?? instruction, situation.when, situation.did)
          .catch((e: unknown) => {
            this.#opts.onLog?.('warn', `判じられませんでした: ${e instanceof Error ? e.message : String(e)}`);
          });
      }
    }
  }

  /** 書き換えが通ったら、その差分を出来事にする。 */
  #diffFor(name: string, args: unknown, isError: boolean, conv: Conversation = this.#conv): (SessionEvent & PlanEvent & { type: 'diff' }) | undefined {
    if (isError || !isWriteTool(name)) return undefined;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== 'string') return undefined;
    const found = this.#takeDiff(path, conv);
    if (!found) return undefined;
    const { added, removed } = diffStat(found.diff);
    return { type: 'diff', path, diff: found.diff, added, removed, created: found.created };
  }

  /**
   * トークンの数え方。**そのモデルのファイルに書いてある通りに数える。**
   *
   * 中で読む道（inproc）は GGUF を名前で指すので、そこから引ける。
   * 外のモデルや Ollama 越しでは分からないので、見積もりのまま。
   * **分からないことを異常にしない。**
   */
  async #count(): Promise<Counter | undefined> {
    if (this.#counterAsked) return this.#counter;
    this.#counterAsked = true;
    this.#counter = (await resolveCounting(this.config)).counter;
    return this.#counter;
  }

  /**
   * いま、どちらで数えているか。**理由まで返す。**
   *
   * 見えないと、切れ方がおかしいときに「モデルが悪い」としか言えない。
   */
  async counting(): Promise<Counting> {
    return resolveCounting(this.config);
  }

  /** 一人で全部やる作業者。気質も権限も既定のもの。 */
  async #agent(opts: { chat?: boolean; conv?: Conversation } = {}): Promise<Agent> {
    const counter = await this.#count();
    const conv = opts.conv ?? this.#conv;
    return new Agent(this.orchestrator, {
      candidates: this.candidates,
      system: await this.#system({ ...opts, conv }),
      // 問いかけにはツールを渡さない。渡すと、答える前に作業場を読みに行く。
      tools: opts.chat ? [] : this.#tools,
      root: this.root,
      maxTurns: this.config.agent?.maxTurns ?? 40,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      // **本番の会話は最優先。**裏の仕事（役職・判じ・補完）より先に口を借りる。
      priority: Priority.top,
      // **実際に立てた窓を渡す。**渡さないと既定の 8192 で見積もるので、
      // 狭い窓を広いと思って溢れさせるか、広い窓を狭いと思って刈りすぎる。
      contextTokens: this.contextTokens,
      ...(counter ? { count: (t: string) => counter.count(t) } : {}),
      approve: conv === this.#conv ? this.#approve : this.#approveFor(conv),
      beforeWrite: (path, previous) => this.undo.capture(path, previous),
      /*
       * **会話ごとの依頼の入れ物を、ツールまで届ける。**規則の履歴・依頼文・協議を会話ごとに持つため
       * （ツールは `create()` で一度だけ包まれていて、既定では共有の入れ物を見る）。
       */
      request: conv.request,
      /*
       * **書いた分の差分で上書きする。**
       *
       * 承認のときに拾った差分は「提案そのまま」なので、塊を選んで通したときは
       * 書いたものと食い違う（当たっていない塊まで札に並び、そこの「戻す」は
       * 断られる）。書けた側から来たものを正とする。
       */
      wrote: (path, diff, created) => conv.diffs.set(path, { diff, created }),
    });
  }

  /**
   * いま使っているモデルの窓（トークン）。
   *
   * 中で読む道（inproc）は `runtime.contextSize`、llama-server は
   * `runtime.desiredContext`。どちらも無ければ、ローカルの既定と同じ 8192。
   * **大きい方に倒さない。**溢れたときは黙って古い方から落ちるので、
   * 見誤るなら狭い側に倒す。
   */
  get contextTokens(): number {
    const rc = this.config.runtime ?? {};
    return rc.contextSize ?? rc.desiredContext ?? 8192;
  }

  /**
   * 指摘かどうかを判じて、そうなら覚える。
   *
   * **モデルが居ないときだけ**、合図で拾う網に落ちる。
   * 判じ手が居ないのに黙って素通りさせると、いちばん覚えるべき回を落とす。
   */
  async #judge(said: string, when: string | undefined, did: string | undefined): Promise<void> {
    // 一度読めなくても、そこで捨てない。**読めないのと、指摘が無いのは違う。**
    for (let round = 1; round <= 2; round += 1) {
      const got = await this.#askJudge(said, when, did);
      if (got?.kind === 'none') return; // 指摘ではない、と答えた
      if (got?.kind === 'complaint') {
        const { judged } = got;
        this.#keepLesson(judged.code, lessonFromUnderstanding(judged, did), judged.when);
        this.#opts.onLog?.('warn',
          `覚えました（二度としないこと）: ${judged.when} のときに、${judged.what}`);
        return;
      }
      if (round === 1) continue; // 読めなかった。もう一度だけ訊く
    }

    // **二度読めなかった。**ここで黙ると、覚えるべき回を落とす。
    // 合図の網に落として、掴めていないことは印で残す。
    const sensed = senseDispleasure(said);
    if (!sensed) {
      this.#opts.onLog?.('info', '指摘かどうかを判じられませんでした（覚えていません）');
      return;
    }
    this.#keepLesson(sensed.code, lessonFrom(sensed.code, when, did), when);
    this.#opts.onLog?.('warn',
      `覚えました（判じられなかったので、合図で拾いました）: ${DISPLEASURE_LABEL[sensed.code]}`);
  }

  /** 一度だけ訊く。落ちたら「読めなかった」として返す。 */
  async #askJudge(
    said: string, when: string | undefined, did: string | undefined,
  ): Promise<JudgeOutcome | undefined> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    timer.unref?.();
    try {
      let text = '';
      for await (const ev of this.orchestrator.run({
        // **安いほうから使う。**判じるのは短い仕事なので、いちばん高いモデルを
        // 毎回起こす理由がない（検問所と同じ選び方に揃える）。
        candidates: [...this.candidates].reverse(),
        system: '指摘を受けた側として、何が悪かったのかを考える。決まった形だけを返す。',
        messages: [{ role: 'user', content: judgePrompt(said, when, did) }],
        temperature: 0.2,
      }, ac.signal)) {
        if (ev.type === 'text') text += ev.delta;
      }
      return judgeOutcome(text, when);
    } catch {
      return undefined; // 判じ手が居ない・落ちた
    } finally {
      clearTimeout(timer);
    }
  }

  /** 覚えを一つ置く。表題は場面ごとに分ける（符丁だけだと一つに潰れる）。 */
  #keepLesson(code: DispleasureCode, detail: string, when: string | undefined): void {
    const got = this.memory.remember({
      kind: 'displeasure',
      title: displeasureTitle(code, when),
      detail,
      tags: [code],
      source: 'user',
    });
    if (betterDetail(detail, got.entry.detail)) got.entry.detail = detail;
    this.memory.touch();
    // saveMemory は中で失敗を言い、投げない。受け手は、落ちてもプロセスごと消さないための念のため
    void this.saveMemory().catch(() => undefined);
  }

  /**
   * 直前に何をしていたか。学びに添えるためだけに持つ。
   *
   * **符丁だけでは、次に何を変えればいいのか分からない。**
   * 「同じことを言わせた」が並ぶだけの覚え書きは、学びではなく記録になる。
   */
  #lastTurnSummary(conv: Conversation = this.#conv): string | undefined {
    const last = conv.lastTurn;
    if (!last) return undefined;
    return [
      last.tools.length > 0 ? `使った道具: ${[...new Set(last.tools)].slice(0, 4).join(', ')}` : '道具は使っていない',
      last.changed.length > 0 ? `触ったもの: ${last.changed.slice(0, 3).join(', ')}` : '作業場は変えていない',
      last.checked === 'passed' ? '確かめて通した'
        : last.checked === 'failed' ? '確かめたが通らなかった'
        : last.checked === 'unsure' ? '確かめたが通らなかった（この回が原因かは分からない）'
        : '確かめていない',
    ].join(' / ');
  }

  /**
   * 思い出して添える。**添えたものを控えておく。**
   *
   * 控えないと、あとで「役に立ったのか」を書き戻せない。書き戻さないと、
   * 外れた覚えが永遠に効き続ける（使うほど雑音が増える）。
   */
  #recall(text: string, opts: { lessons?: boolean } = {}, conv: Conversation = this.#conv): string {
    // **件数ではなく、長さで決める。**一件の長さは決まっていないので、
    // 「6件」では窓が狭いモデルで押し出し、広いモデルで余らせる。
    const related = fitByTokens(
      this.memory.recall(text, { limit: 12, root: this.root, ...opts }),
      (e) => `${e.title}${e.detail}`,
      Math.floor(this.contextTokens * 0.10),
      2,
    );
    const failed = this.memory.failedBefore(text, 2, this.root);
    const merged = [...related];
    for (const f of failed) if (!merged.some((e) => e.id === f.id)) merged.push(f);
    conv.recalledIds = merged.map((e) => e.id);
    conv.recalledEra = this.memory.era;
    this.memory.noteRecalled(conv.recalledIds);
    return formatRecall(merged);
  }

  /**
   * 添えた覚えに、結果を書き戻す。
   *
   * **確かめた回だけ。**検証を回していない回の「うまくいった気がする」で
   * 重みを動かすと、思い込みが固まるだけで、賢くはならない。
   */
  #gradeRecall(checked: 'passed' | 'failed' | 'preexisting' | 'unsure' | 'notRun', conv: Conversation = this.#conv): void {
    const ids = conv.recalledIds;
    conv.recalledIds = [];
    // 添えた後に番号が振り直されていたら、別の覚えに点を付けることになる。付けない
    if (ids.length === 0 || conv.recalledEra !== this.memory.era) return;
    if (checked === 'passed') this.memory.noteOutcome(ids, true);
    else if (checked === 'failed') this.memory.noteOutcome(ids, false);
    // preexisting と notRun は、こちらの手柄でも失点でもない。動かさない。
  }

  /**
   * 記憶を刈る。**落とした数を黙らない。**
   *
   * `compact()` は落とした数を返すのに、呼ぶ側が三箇所とも捨てていた。
   * 忘れたことが誰にも見えないと、「前に言ったのに覚えていない」が
   * 起きたときに、忘れたのか思い出せないのかを切り分けられない。
   */
  #compactMemory(): void {
    const dropped = this.memory.compact();
    if (dropped > 0) {
      this.#opts.onLog?.('info', `記憶を ${dropped} 件、古い方から片づけました（${this.memory.size} 件になりました）`);
    }
  }

  /**
   * いまモデルへ渡している前置き。
   *
   * **中に閉じ込めない。**窓のどれだけを前置きが食っているかは、
   * 狭い窓のモデルでは死活問題で、外から測れないと確かめようがない。
   */
  async systemPrompt(): Promise<string> {
    return this.#system();
  }

  /**
   * システムプロンプトに入り切らなかったもの。
   *
   * **ここまで、`#lastDropped` は書かれるだけで一度も読まれていなかった。**
   * すぐ上に「黙って落とさない」と書いてあるのに、読む道が無い。
   * 決まりが半分しか渡っていないことを、誰も知る手立てが無かった。
   *
   * 呼ぶ側（画面・CLI）が、そのまま人に見せられる形で返す。
   */
  droppedFromSystem(): readonly string[] {
    return this.#lastDropped;
  }

  /** 依頼のたびに、その時点で分かっている状況を渡す。調べ直させるより速い。 */
  async #system(opts: { chat?: boolean; conv?: Conversation } = {}): Promise<string> {
    /*
     * 訊かれただけのときは、**決まりを入れ替えて、そこで終える。**
     * リポジトリの決まりも作業場の様子も載せない。問いに答えるのに要らないし、
     * 狭いコンテキストウィンドウの模型では、それだけで問いが押し出される。
     */
    if (opts.chat) return this.config.chatSystem ?? DEFAULT_CHAT_SYSTEM;
    const base = this.config.system ?? DEFAULT_SYSTEM;
    const counter = await this.#count();
    const count = counter ? (t: string) => counter.count(t) : undefined;
    const size = count ?? estimateTokens;
    const snap = await this.#prefetch.snapshotWithin(3000);

    /*
     * **前置き全体で、一つの予算にする。**
     *
     * ここまで、載せるものごとに窓の割合を別々に決めていた
     * （学び 15%、置き場の決まり 20%、道具の説明 15%）。**合計を誰も
     * 見ていない。**足すと窓の半分が、依頼と履歴の前に消える。
     * コンテキストウィンドウ 4096 のモデルでは、それだけで 56%（実測）。
     *
     * 一つずつ見ると、どれも「窓に合わせて」いる。**合わせ方が独立
     * だっただけで、これは前に六箇所直したのと同じ形。**
     *
     * だから、前置きは全体で `SYSTEM_SHARE` まで。中では**優先順に**取る。
     * 決まり本体 → 嫌がられたこと → 作業場の様子 → 置き場の決まり。
     * 入らないものは載せない（切り詰めるより、載せない方が読める）。
     */
    const budget = Math.floor(this.contextTokens * SYSTEM_SHARE);

    /*
     * **並べる場所と、残す優先を、別々に持つ。**
     *
     * 並び（この配列の順）は、相手に計算し直させないための順。
     * 動かないものを先、変わるものを後ろに置く。相手（llama.cpp / ollama）は
     * 前と同じ頭を再計算しないので、頭の一文字が変わると、そこから先を
     * 毎回まるごと計算し直すことになる。狭い機械ほど、それが待ち時間になる。
     *
     *   base   決まり本体          変わらない
     *   rules  置き場の決まり      置き場のファイルを直したときだけ
     *   never  嫌がられたこと      覚えたときだけ
     *   brief  作業場の様子        作業が進むと変わる
     *   map    作業場の地図        **依頼ごとに変わる**
     *
     * 優先（`priority`）は、狭いときに何を残すか。**別の理由で決まる。**
     * 直す前はこの二つが同じもので、捨てる順を `parts` の添字で手書きして
     * いた（`const drop = [4, 1, 3]`）。並べ替えれば黙って違うものを指す。
     *
     * 優先を決めた理由:
     *   決まり本体   落とさない。無いと話にならない
     *   嫌がられた   同じ失敗を繰り返すのがいちばん高くつく
     *   置き場の決まり 利用者が書いたもの。こちらが後から足した地図より重い
     *   作業場の様子  小さい。置き場の決まりより先に取らせる
     *   地図         後から足したもの。**狭いときに捨てるのはこちら**
     *
     * 作業場の様子を置き場の決まりより上に置くのは、**直す前と同じ取り順に
     * するため**。置き場の決まりは残りを全部取るので、後ろに回すと様子が
     * 必ず 0 になる（窓 16852 で、地図まで落ちた。実測）。様子は数十で、
     * 決まりを削るほどのものではない。
     *
     * なお、捨てる順は直す前と一つ変わる。前は手書きの並びで
     * 「地図 → 置き場の決まり → 作業場の様子」の順に捨てていた。
     * いまは優先の低い方からなので「地図 → 作業場の様子 → 置き場の決まり」。
     * **こちらが正しい。**置き場の決まりは利用者が書いたもので、
     * 作業場の様子はこちらが毎回作り直せる。前の並びは、
     * 添字を手で書いていたことによる取りこぼしだったと考えている。
     */
    /** 決まりのうち、窓に入らなかった見出し。**黙って落とさない。** */
    const missingRules: string[] = [];
    const { text, dropped } = await fitParts([
      { name: '決まり本体', priority: 100, required: true, render: () => base },
      {
        name: 'リポジトリの決まり',
        priority: 60,
        /*
         * **入らなかった見出しを、拾っておく。**
         *
         * ここは丸ごと落ちたことしか分からなかった。実際には**節の途中で
         * 切れて、後ろの節が全部消えて**いた。コンテキストウィンドウ 8192（手元の小さいモデルで
         * ふつうの大きさ）では、11 節のうち 3 節しか渡っていない。
         * 「push では CI を回さない」も「C: 直下にフォルダを作らない」も、
         * 一度もモデルに届いていなかった。
         */
        render: async (left) => {
          const got = await this.#projectRules.blockWithDropped(left, Date.now(), count);
          for (const d of got.dropped) missingRules.push(d);
          return got.text;
        },
      },
      {
        name: '嫌がられたこと',
        priority: 80,
        // **取れるだけ取らせない。**ここは 12 件あると 1142 になり、窓 16852 の
        // 予算 4213 の 27% を一人で取っていた（実測）。上限は外に書く。
        atMost: Math.floor(budget * HATED_SHARE),
        /*
         * **嫌がられたことは、決まりの側にも置く。**
         *
         * 思い出す仕組み（recall）は依頼の言葉から引くので、取りこぼしうる。
         * ここに置けば、どの回でも必ず目に入る。窓は食うが、同じ失敗を
         * 一度でも減らせるなら安い。
         *
         * 取るのは残りの半分まで。**窓が狭くても一件は載せる**
         * （ここを 0 にすると、狭い窓のモデルほど同じ失敗を繰り返す。
         * いちばん要る所から削ることになる）。
         */
        render: (left) => {
          const hated = fitByTokens(
            this.memory.displeasures(12),
            (e) => e.detail || e.title,
            left,
            1,
            count,
          );
          if (hated.length === 0) return '';
          return [
            '',
            '二度としないこと（前に同じことで止められています。話題が違っても効きます）:',
            ...hated.map((e) => `- ${e.detail || e.title}`),
            '同じことをもう一度すると、それまでの積み上げが無駄になります。時間をかけてよいので、繰り返さないこと。',
          ].join('\n');
        },
      },
      {
        name: '作業場の様子',
        priority: 70,
        // 大きな置き場ほど長くなる。**入らなければ載せない**（切り詰めない）。
        render: (left) => {
          const raw = snap ? describeSnapshot(snap) : '';
          return size(raw) <= left ? raw : '';
        },
      },
      {
        name: '作業場の地図',
        priority: 20,
        /*
         * **取り置く。**置き場の決まりは残りを全部取るので、これが無いと
         * 地図はコンテキストウィンドウ 32768 まで一度も載らなかった（実測）。
         * 狭い窓では取り置かない（取り置くと、決まりの側が落ちる）。
         */
        atLeast: budget >= MAP_FROM ? Math.floor(budget * MAP_SHARE) : 0,
        /*
         * **どこに何が在るかを、先に渡す。**
         *
         * これが無いと、モデルは何も知らないところから始める。`list_files` で
         * 歩き、`search_text` で総当たりし、見当違いのファイルを何枚も開く。
         * 探すところで窓を使い切って、直すところまで辿り着かない。
         * 手元の小さいモデルでは、ここが効く。
         */
        render: (left) => this.#repoMap(left, count, opts.conv),
      },
    ], budget, size);

    /*
     * **黙って落とさない。**
     *
     * ここは `#lastDropped` に入れるだけで、**どこからも読まれていなかった。**
     * コメントにそう書いてあるのに、実装が無い。決まりが半分しか渡って
     * いないことを、誰も知る手立てが無かった。
     */
    const now = [...dropped, ...missingRules];
    /*
     * **変わったときだけ言う。**毎回言うと同じ行で記録が埋まり、
     * 埋まったものは読まれなくなる（それは黙っているのと同じ）。
     */
    if (now.join('\n') !== this.#lastDropped.join('\n') && now.length > 0) {
      this.#opts.onLog?.('warn',
        `決まりがコンテキストウィンドウに入り切らないので、${now.length} 件をモデルへ渡していません: ${now.join(' / ')}`
        + '（前に書いてある節から入ります。大事なものを上へ動かすか、コンテキストウィンドウの広いモデルにしてください）');
    }
    this.#lastDropped = now;
    return text;
  }

  /**
   * 作業場の地図を、渡せる形で作る。
   *
   * 索引は先読みが持っているものを使う（**ここで組み直さない**。
   * 4000 ファイルで数秒かかる）。まだ無いなら、地図は出さない。
   * 出せないことを黙るのではなく、出せるようになってから出す
   * （最初の一往復だけ地図が無い。二回目からは在る）。
   */
  async #repoMap(left: number, count?: (t: string) => number, conv: Conversation = this.#conv): Promise<string> {
    if (left <= 0) return '';
    try {
      /*
       * **前と同じで済むなら、同じものを返す。**
       *
       * システムプロンプトが一文字でも変われば、モデルはそこから先を全部
       * 計算し直す（prompt cache が効かなくなる。会話の履歴も含めて）。
       * 依頼ごとに repo map を作り直すと、毎回それが起きる。
       *
       * ただし、**いま探しているファイルが repo map に無いなら、作り直す。**
       * 無いものを使い回しても、モデルが探し回るやりとりが増えるだけで、
       * 計算し直すより高くつく。
       */
      // 索引は `find_code` と同じものを使う（二つ持つと、同じディレクトリを
      // 二度歩くことになる）。作ってあれば、それをそのまま使う。
      // 無ければ組む（このあとの `find_code` もそれを使うので、払いは一度きり）。
      const index = await indexStore.fresh(this.root);
      if (index.files.length === 0) return '';
      const seed = seedFrom(index, conv.instruction, conv.history
        .flatMap((m) => (typeof m.content === 'string' ? m.content.match(/[\w./-]+\.[a-z]{1,4}/g) ?? [] : [])),
        this.undo.recent());
      const held = this.#map;
      // 作ってあるものを使ってよいかは、**確かな手がかりだけ**で決める
      // （`covers` のコメント）。検索の点の付け方は、並べるには効くが、
      // 「そのファイルを直している」の判断には使えない。
      const strong = seedFrom(index, conv.instruction, [], this.undo.recent(), { search: false });
      if (held && held.builtAt === index.builtAt && covers(held.text, index, strong)) return held.text;

      // トークンではなく文字で切る（切り出しが文字単位のため）。**多めに数える。**
      const chars = count ? left : left * 2;
      /*
       * **上位の候補だけ本文を読んで、並べ直す（rerank）。**
       *
       * `scoreFiles` は索引の head（冒頭とコメント）しか見ていないので、
       * 本文にだけ答えがあるファイルが沈む。repo map に入らなかった 209 件の
       * うち 56 件（27%）がこれだった（実測）。
       *
       * 効かせ方は repo map の予算で決める。数件しか見せられないときほど
       * 上位の精度が効き、ほとんど見せられるなら並べ直しても入れ替わるだけ。
       */
      const ranked = await rerankByBody(index, conv.instruction, seed, rerankShare(chars));
      const entries = rankedEntries(index, ranked);
      const made = renderMap(entries, { chars }, count);
      this.#map = { text: made, builtAt: index.builtAt };
      return made;
    } catch { return ''; }
  }

  get instruction(): string { return this.#conv.instruction; }

  /** 話の続きを切る。覚えたことは消えない。忘れるのは、いま話していた流れだけ。 */
  reset(): void { this.#conv.reset(); }

  /**
   * いままでのやりとり。**残す側が読む。**
   *
   * 中身は渡すが、外から書き換えさせない（読み取り専用で返す）。
   * 書き換えを許すと、道具の呼び出しと結果の対応が崩れて、
   * 次の一手でモデルが弾かれる。
   */
  get history(): readonly ProviderMessage[] { return this.#conv.history; }

  /**
   * 続きから話す。残してあったやりとりを積み直す。
   *
   * **積む前に空にする。**足すだけにすると、会話を切り替えたときに
   * 前の会話が下に残り、別の話が地続きに見える。
   */
  restore(messages: readonly ProviderMessage[]): void {
    this.#conv.restore(messages);
  }

  async close(): Promise<void> {
    this.abort();
    // 外の道具（子プロセス）を止める。止めないと、画面を閉じても
    // npx や相手のサーバが残る（検査が終わらないことで気づいた）。
    for (const c of this.mcpClients) c.stop();
    await this.saveAutonomy();
    this.#compactMemory();
    await this.saveMemory();
    await this.#harness.metrics?.save();
  }
}

function summarize(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const o = args as Record<string, unknown>;
  // `name` は find_symbol（名前で引く）が使う。**足したツールの引数を
  // ここに足し忘れると、画面にはツールの名前しか出ない。**
  const key = ['path', 'command', 'query', 'url', 'name'].find((k) => typeof o[k] === 'string');
  return key ? String(o[key]).slice(0, 100) : '';
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 160);
}

/**
 * 1ターンの速さ。**遅い理由を、答えのすぐ下に出すために持つ。**
 *
 * 8B を CPU で読んでいて一言に 3 分かかっていたとき、画面には「待機中」と
 * 秒数しか無く、モデルが大きすぎるのか、壊れているのかが分からなかった。
 * 数え方は metrics と同じ（文字数 / 3、1 秒未満か 20 トークン未満は数えない）。
 */
export function speedOf(model: string, chars: number, seconds: number): { model: string; outputTokens: number; tps?: number } {
  const outputTokens = Math.round(chars / 3);
  const usable = seconds >= 1 && outputTokens >= 20;
  return usable
    ? { model, outputTokens, tps: Math.round((outputTokens / seconds) * 10) / 10 }
    : { model, outputTokens };
}
