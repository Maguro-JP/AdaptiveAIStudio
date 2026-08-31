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
  triggeredBy: 'time',
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
  triggeredBy: 'time',
  codename: 'FORECAST',
  name: '先読み',
  purpose: '今の作りのままだと、次に何で困りそうかを考える。',
  // 手元が変わっていないなら、先読みの結論も前回と同じになる。
  // 30分ごとに繰り返すと、静かな時間の埋め草になってしまう。
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.now - ctx.lastRunAt > 90 * MINUTE,
  cooldownMs: 90 * MINUTE,
  cost: 2,
  basePriority: 3,
};

/**
 * WHATIF — 別の道を考える。
 *
 * 「あのとき別の作りにしていたら」は、後知恵ではなく設計の検算になる。
 * ただし始終やられると邪魔なので、間隔は長く取る（3時間）。
 */
export const whatif: IdleMode = {
  id: 'whatif',
  triggeredBy: 'time',
  codename: 'WHAT-IF',
  name: '別案',
  purpose: '今の作りとは別のやり方を考え、比べて利点と欠点を出す。',
  precondition: (ctx) => ctx.lastRunAt === undefined || ctx.now - ctx.lastRunAt > 3 * 60 * MINUTE,
  cooldownMs: 3 * 60 * MINUTE,
  cost: 3,
  basePriority: 2,
};

/** REVIEW — 期をまたいだ変更をまとめて見る。「昨日の分」の確認。 */
export const digest: IdleMode = {
  id: 'digest',
  codename: 'DIGEST',
  name: '通し確認',
  purpose: '前回からの変更をまとめて見直し、見落としが無いかを確かめる。',
  precondition: () => true, // 日課として時間で起きるので、変化は前提にしない
  cooldownMs: 30 * MINUTE,
  cost: 2,
  basePriority: 5,
  dutyOnly: true,
};

/** AGENDA — この先の段取りを組む。 */
export const agenda: IdleMode = {
  id: 'agenda',
  codename: 'AGENDA',
  name: '段取り',
  purpose: '溜まっている提案と残作業を見て、次に何から手を付けるべきかを整理する。',
  precondition: () => true,
  cooldownMs: 60 * MINUTE,
  cost: 1,
  basePriority: 6,
  dutyOnly: true,
};

export const BUILTIN_IDLE_MODES: IdleMode[] = [
  patrol, recon, retrospect, forecast, briefing, whatif, digest, agenda,
];

/** モードごとの依頼文。誰に何を考えさせるかがここで決まる。 */
export const MODE_ROLE: Record<string, string> = {
  recon: 'scout',
  patrol: 'tester',
  briefing: 'envoy',
  retrospect: 'reviewer',
  forecast: 'planner',
  whatif: 'planner',
  digest: 'reviewer',
  agenda: 'planner',
};

export function promptFor(mode: IdleMode, context: string): string {
  const asks: Record<string, string> = {
    recon: '気になる箇所を1つだけ選び、実際に読んで確かめてください。',
    patrol: '検査を実行し、失敗があればその内容を報告してください。',
    briefing:
      'この場所に関係する外部の情報を1つだけ確認し、関係を明記して報告してください。'
      + '新しいモデルが出ている旨が上に書かれていれば、それを最優先で報告してください'
      + '（ローカルで動かす以上、古いものを使い続ける理由がないため）。'
      + 'ただし、大きさと活性パラメータからこの機械で動くかどうかも併せて述べてください。'
      + '手元（package.json、変更履歴、実際に入っている版）で分かることは先に手元で確認し、'
      + '外に出るのは手元に答えが無い一点だけにしてください。'
      + '外に出られなかった場合も、手元で分かる範囲の結論を出し、確かめられなかった点を明記してください。',
    retrospect: '直近の変更を読み、急いで済ませた箇所や決め切れていない点を1つ挙げてください。',
    forecast: '今の作りのままだと次に何で困るかを、根拠とともに1つ挙げてください。',
    whatif: '今の作りとは別のやり方を1つ考え、利点と欠点を比べてください。',
    digest: '前回の確認以降に入った変更を通しで見て、見落としがあれば1つ挙げてください。',
    agenda: '未処理の提案と残作業を見て、次に何から手を付けるべきかを理由とともに1つ示してください。',
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
