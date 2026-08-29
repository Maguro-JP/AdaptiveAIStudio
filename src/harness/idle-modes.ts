/**
 * 思考モード — 暇なときに何を考えるか。
 *
 * 一種類だけだと、同じ角度からしか見なくなる。
 * 人が暇なときにやることも一つではない。
 * 見回りもするし、ニュースも見るし、振り返りもするし、
 * 「あのときこうしていたら」とも考える。
 *
 * それぞれに前提条件を付けるのが要点。
 * **何も変わっていないのに考え直すのは、思考ではなく空回り。**
 */
import type { IdleMode } from './idle.ts';

const MINUTE = 60_000;

/** RECON — 手元のコードを見回り、気になる箇所を探す。 */
export const recon: IdleMode = {
  id: 'recon',
  codename: 'RECON',
  name: '見回り',
  purpose: 'コードを見て回り、壊れそうな箇所や手が入っていない箇所を探す。',
  // 何かが変わったときだけ。変わっていないコードは前回と同じ結論になる。
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.lastChangeAt > ctx.lastRunAt,
  cooldownMs: 2 * MINUTE,
  cost: 2,
  basePriority: 7,
};

/** PATROL — 検査を回す。壊れていないかを確かめる。 */
export const patrol: IdleMode = {
  id: 'patrol',
  codename: 'PATROL',
  name: '巡回検査',
  purpose: 'テストや型検査を流し、いま壊れていないかを確かめる。',
  // 変更後に一度だけ回せばよい。変わっていないなら結果も変わらない。
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.lastChangeAt > ctx.lastRunAt,
  cooldownMs: 5 * MINUTE,
  cost: 1,
  basePriority: 8,
};

/** BRIEFING — 外の情報を取りに行く。ENVOY の担当。 */
export const briefing: IdleMode = {
  id: 'briefing',
  codename: 'BRIEFING',
  name: '外部情報',
  purpose: '依存パッケージの更新や既知の不具合など、外の情報を取りに行く。',
  // 外の世界は分単位では変わらない。頻繁に見に行っても無駄。
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.now - ctx.lastRunAt > 6 * 60 * MINUTE,
  cooldownMs: 60 * MINUTE,
  cost: 3,
  basePriority: 4,
};

/** RETROSPECT — 済んだ作業を振り返る。 */
export const retrospect: IdleMode = {
  id: 'retrospect',
  codename: 'RETROSPECT',
  name: '振り返り',
  purpose: '最近の変更を見直し、急いで済ませた箇所や決め切れなかった点を洗い出す。',
  // 振り返る材料が要る。直近に作業していなければ意味がない。
  precondition: (ctx) => ctx.now - ctx.lastChangeAt < 60 * MINUTE
    && (ctx.lastRunAt === undefined || ctx.lastChangeAt > ctx.lastRunAt),
  cooldownMs: 20 * MINUTE,
  cost: 2,
  basePriority: 5,
};

/** FORECAST — これから起きそうなことを考える。 */
export const forecast: IdleMode = {
  id: 'forecast',
  codename: 'FORECAST',
  name: '先読み',
  purpose: '今の作りのままだと、次に何で困りそうかを考える。',
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.now - ctx.lastRunAt > 30 * MINUTE,
  cooldownMs: 30 * MINUTE,
  cost: 2,
  basePriority: 3,
};

/**
 * WHATIF — 別の道を考える。
 *
 * 「あのとき別の作りにしていたら」は、後知恵ではなく設計の検算になる。
 * ただし始終やられると邪魔なので、間隔は長く取る。
 */
export const whatif: IdleMode = {
  id: 'whatif',
  codename: 'WHAT-IF',
  name: '別案',
  purpose: '今の作りとは別のやり方を考え、比べて利点と欠点を出す。',
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.now - ctx.lastRunAt > 45 * MINUTE,
  cooldownMs: 45 * MINUTE,
  cost: 3,
  basePriority: 2,
};

export const BUILTIN_IDLE_MODES: IdleMode[] = [
  patrol, recon, retrospect, forecast, briefing, whatif,
];

/** モードごとの依頼文。誰に何を考えさせるかがここで決まる。 */
export const MODE_ROLE: Record<string, string> = {
  recon: 'scout',
  patrol: 'tester',
  briefing: 'envoy',
  retrospect: 'reviewer',
  forecast: 'planner',
  whatif: 'planner',
};

export function promptFor(mode: IdleMode, context: string): string {
  const asks: Record<string, string> = {
    recon: '気になる箇所を1つだけ選び、実際に読んで確かめてください。',
    patrol: '検査を実行し、失敗があればその内容を報告してください。',
    briefing: 'この場所に関係する外部の情報を1つだけ確認し、関係を明記して報告してください。',
    retrospect: '直近の変更を読み、急いで済ませた箇所や決め切れていない点を1つ挙げてください。',
    forecast: '今の作りのままだと次に何で困るかを、根拠とともに1つ挙げてください。',
    whatif: '今の作りとは別のやり方を1つ考え、利点と欠点を比べてください。',
  };
  return [
    `[${mode.codename}] ${mode.purpose}`,
    '',
    context,
    '',
    asks[mode.id] ?? '気づいたことを1つ報告してください。',
    '',
    '重要:',
    '- 1回につき1件だけにしてください。数を出すことが目的ではありません。',
    '- 確認していないことは書かないでください。',
    '- 報告するに値しないなら「問題なし」とだけ答えてください。',
  ].join('\n');
}
