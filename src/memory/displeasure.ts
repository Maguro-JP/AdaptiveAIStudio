/**
 * 不快を拾う。
 *
 * **失敗から学ぶほうが効く。**うまくいった手を覚えると出来ることが増えるが、
 * 同時に「その手しか取らない」ようにもなる。嫌がられたことを覚えると、
 * 出来ることは減らずに、踏む地雷だけが減る。
 *
 * 利用者が怒った・悲しんだ・指摘した・不満だった・不快だった。
 * これは**話題が変わっても効き続ける**ので、語の重なりでは引かない
 * （layout の不快は、MCP の作業のときにも思い出さないと意味がない）。
 *
 * 拾い方は決め打ちの合図で見る。モデルには判じさせない。
 * 判じさせると、モデルが替わるたびに拾えたり拾えなかったりする。
 * **符丁は ASCII で固定する**（語形が変わらないもので返す）。
 */
import { redactSecrets } from '../core/redact.ts';
import { headOf } from '../agent/window.ts';

/** 何が起きたか。表示のときに日本語へ引き直す。 */
export type DispleasureCode =
  /** 前に言ったことを、また言わせた */
  | 'REPEATED'
  /** 出来ていない・動かないと言われた */
  | 'BROKEN'
  /** やめてくれ・するなと言われた */
  | 'STOP'
  /** 遅い・止まっている */
  | 'STALLED'
  /** 言い方や中身が不快 */
  | 'OFFENSIVE'
  /** 責められている（強い言葉） */
  | 'ANGRY';

export interface Sensed {
  code: DispleasureCode;
  /** 当たった合図。なぜ拾ったのかを言えるように残す。 */
  cue: string;
}

/**
 * 合図。
 *
 * **強い順に見る。**「動かない」と「二度と言わせるな」が同時に来たら、
 * 後者を採る（同じことを言わせたのが、いちばん重い失敗）。
 */
const CUES: { code: DispleasureCode; patterns: RegExp[] }[] = [
  {
    code: 'REPEATED',
    patterns: [
      // 「言ってるよね」「言ったよな」。念押しは、こちらが聞いていない証拠。
      // 「CSVまたはJSON」「AまたはB」の「または」は拾わない
      /言(って|った)(る)?(よ|ん)?[ねな]/, /何度(も|言)/, /また(?!は)[^。]{0,6}(か|かよ|ですか)/,
      // 「また障害発生してる?」のような、問い返しの形。
      /また(?!は)[^。！？\n]{0,12}[?？]/,
      // 「いつもの手順で」「毎回テストを走らせて」はふつうの頼み方。同じことを繰り返された形だけを拾う
      /前(に|も)言/, /さっき(も|言)/, /毎回(同じ|言)/, /いつも(?!の|どおり|通り)/, /二度と/,
    ],
  },
  {
    code: 'STOP',
    // 「このログは要らないので消して」は頼み。理由として続くものは拾わない
    // 「キャッシュしないで読んで」「余計な空白を削って」は頼み。止めてと言っている形だけを拾う
    patterns: [/やめて/, /辞めて/, /やめろ/, /しないで(?![^。！？\n]{0,10}(て|で)(ください|ほしい|下さい)?$)/, /するな/, /要らない(?!ので|から)/, /いらない(?!ので|から)/, /余計(?!な)/],
  },
  {
    code: 'OFFENSIVE',
    patterns: [/気持ち悪い/, /不快/, /嫌(だ|い|な)/, /失礼/, /馬鹿にして/, /舐めて/],
  },
  {
    code: 'ANGRY',
    patterns: [
      // 「最悪の場合」「クレーム管理画面」は頼みの中の語
      /無能/, /ふざけ/, /いい加減/, /ボケ/, /殺す/, /クソ/, /くそ/, /最悪(?!の(場合|ケース|とき|時))/,
      /真面目に/, /ちゃんと(しろ|して|やれ)/, /訴え/, /クレーム(?![\p{Script=Han}\p{Script=Katakana}])/u,
    ],
  },
  {
    code: 'STALLED',
    // 「起動が遅いので速くして」は頼みの理由
    patterns: [/止ま(って|った)/, /進んで(ない|いない)/, /遅い(?!ので|から)/, /まだ(かよ|なの)/, /フリーズ/, /固ま(って|った)/],
  },
  {
    code: 'BROKEN',
    patterns: [
      /動(か|い)(ない|てない|ていない)/, /出来て(ない|いない)/, /できて(ない|いない)/,
      // 語の一部では拾わない（「複雑」「雑談」「違うファイルを開いて」「なっていないか確認して」を、出来ていないものを渡したと覚えていた）
      // 「壊れたJSON」「壊れたファイルも読めるように」のように、語の前に付いて物を言う形は拾わない
      /壊れ(て|た)(?![A-Za-z\p{Script=Han}\p{Script=Katakana}])/u, /直って(ない|いない)/, /粗末/, /(?<![複混])雑(?![談音誌多貨巾魚草用務記])/u, /使えない(?!ので|から)/,
      /なって(ない|いない)(?!か)/, /違う(?![\p{Script=Han}\p{Script=Katakana}A-Za-z])/u, /そうじゃない/,
    ],
  },
];

/**
 * 拾う。当たらなければ `undefined`。
 *
 * **拾いすぎない。**普通の依頼まで不快として覚えると、
 * 「二度としないこと」が依頼の山になって、どれも効かなくなる。
 */
export function senseDispleasure(text: string): Sensed | undefined {
  const body = String(text ?? '');
  if (body.trim().length === 0) return undefined;
  for (const { code, patterns } of CUES) {
    for (const p of patterns) {
      const m = p.exec(body);
      if (m) return { code, cue: m[0] };
    }
  }
  return undefined;
}

/** 人に見せるときの言い方。 */
export const DISPLEASURE_LABEL: Record<DispleasureCode, string> = {
  REPEATED: '同じことを言わせた',
  BROKEN: '出来ていないものを渡した',
  STOP: 'やめてほしいことをした',
  STALLED: '止まっていた・遅かった',
  OFFENSIVE: '言い方や中身が不快だった',
  ANGRY: '強く責められた',
};

/**
 * 次からどうするか。
 *
 * **言われた言葉は残さない。**
 *
 * 原文を溜めるのは記録であって、学びではない。しかも、自分の不満を集めた
 * 覚え書きを持たれて、気分の良い相手はいない（実際に言われた）。
 * 残すのは「何故そうなったか」と「次からどうするか」だけにする。
 */
export const DISPLEASURE_RULE: Record<DispleasureCode, string> = {
  REPEATED: '前に言われたことを、こちらが守れていない。言われる前に、決まりの側を見る',
  BROKEN: '出来ていないものを渡した。渡す前に、こちらで動かして確かめる',
  STOP: 'やめてほしいと言われたことをした。断られた道は、二度目を出さない',
  STALLED: '止まっていることに、こちらから気づけていない。進み具合を自分で出す',
  OFFENSIVE: '言い方か中身が不快だった。相手の言葉づかいに合わせ、押しつけない',
  ANGRY: '積み重なって責められた。手前でいくつも取りこぼしている。仕切り直して原因を潰す',
};

/**
 * 一言ごとに、指摘かどうかを判じてもらう問い。
 *
 * **合図（決め打ちの語）で選り分けない。**静かな指摘ほど落とす。
 * 「何に対して行ったか書けよ」には怒りの語が一つも無いが、指摘そのもの。
 * 落とした分は、そもそも学びに入らない。
 *
 * 判じるのは**別の呼び出し**にする。作業の窓を食わないため。
 * 返しは語形の変わらない印で固定する。
 */
export function judgePrompt(said: string, when?: string, did?: string): string {
  return [
    'いまの一言が、こちらへの指摘・不満・注意かどうかを判じてください。',
    '',
    `直前の指示: ${when ?? '（分かりません）'}`,
    `それに対してこちらがしたこと: ${did ?? '（分かりません）'}`,
    `利用者の言葉: ${headOf(said.trim(), 800)}`,
    '',
    'ただの依頼・質問・雑談なら、NONE とだけ返してください。',
    '指摘なら、次の五行だけを返してください。前置きも説明も要りません。',
    `CODE: ${CODES.join(' / ')} のどれか`,
    'WHEN: どういう場面だったか（何を頼まれていたか）',
    'WHAT: その場面で、こちらが何をしたのが悪かったか',
    'WHY: なぜそれが問題なのか（利用者にとって何が困るのか）',
    'NEXT: 同じ場面で、次からどうするか',
  ].join('\n');
}

const CODES: DispleasureCode[] = ['REPEATED', 'BROKEN', 'STOP', 'STALLED', 'OFFENSIVE', 'ANGRY'];

export interface Judged extends Understood {
  code: DispleasureCode;
}

/**
 * 判じた結果を受け取る。
 *
 * **指摘でないときは、何も返さない。**迷ったら覚えない。
 * 拾いすぎると「二度としないこと」が依頼の山になって、どれも効かなくなる。
 */
export function parseJudgement(text: string, fallbackWhen?: string): Judged | undefined {
  const got = judgeOutcome(text, fallbackWhen);
  return got.kind === 'complaint' ? got.judged : undefined;
}

/**
 * 判じた結果。**三つに分ける。**
 *
 *   complaint  … 指摘だった
 *   none       … 指摘ではない、と答えた
 *   unreadable … 答えたが、読めない
 *
 * `none` と `unreadable` を一緒にしていたので、**読めない返しは黙って
 * 消えていた**。指摘を落としたのか、指摘が無かったのかが区別できない。
 * 区別が付かないものは、直しようがない。
 */
export type JudgeOutcome =
  | { kind: 'complaint'; judged: Judged }
  | { kind: 'none' }
  | { kind: 'unreadable' };

export function judgeOutcome(text: string, fallbackWhen?: string): JudgeOutcome {
  const understood = parseUnderstanding(text, fallbackWhen);
  if (understood) {
    const m = /^[\s>*\-#・•]*\*{0,2}CODE\*{0,2}\s*[:：]\s*\*{0,2}\s*([A-Z_]+)/mi.exec(text);
    const code = CODES.find((c) => c === m?.[1]?.toUpperCase());
    // 符丁が読めないときは、いちばん弱いものにする。**強く決めつけない。**
    return { kind: 'complaint', judged: { ...understood, code: code ?? 'OFFENSIVE' } };
  }
  // 飾りが付いていても `NONE` は `NONE`。
  if (/(^|[^A-Z])NONE([^A-Z]|$)/i.test(text)) return { kind: 'none' };
  return { kind: 'unreadable' };
}

/**
 * 覚えの表題。
 *
 * **場面ごとに分ける。**符丁だけを表題にすると、場面の違う学びが
 * 一つに潰れて、古いほうから消える（学べる数が符丁の数で頭打ちになる）。
 * 同じ場面で同じ失敗をしたときだけ、重ねて数える。
 */
export function displeasureTitle(code: DispleasureCode, when?: string): string {
  const label = DISPLEASURE_LABEL[code];
  // 伏せてから切る（切ってから伏せると、鍵の途中で切れて形に当たらず、鍵の頭が題に残る）
  const where = headOf(redactSecrets((when ?? '').trim().replace(/\s+/g, ' ')), 40);
  return where ? `${label}: ${where}` : `${label}（場面は未確認）`;
}

/**
 * 何故そう言われたのかを、こちらで考えるための問い。
 *
 * **表の一行では、意味も意図も残らない。**符丁ごとの決め文句は、
 * 「言われた言葉をそのまま残す」を「決まり文句をそのまま残す」に
 * 置き換えただけで、**何が嫌だったのか**は同じように消えている
 * （実際に、そう指摘された）。
 *
 * 考えるのは、その場でしかできない。あとから元の言葉は捨てるので、
 * ここで汲み取れなかったものは、二度と戻らない。
 *
 * 返し方は**語形の変わらない印**で固定する。日本語で「通す」「止める」を
 * 返させたときに、語尾で取り違えた前科がある。
 */
export function understandPrompt(said: string, when?: string, did?: string): string {
  return [
    '利用者が、いまの作業に不満を示しました。何が問題だったのかを考えてください。',
    '',
    `直前の指示: ${when ?? '（分かりません）'}`,
    `それに対してこちらがしたこと: ${did ?? '（分かりません）'}`,
    `利用者の言葉: ${headOf(said.trim(), 600)}`,
    '',
    '次の四行だけを、この形で返してください。前置きも説明も要りません。',
    'WHEN: どういう場面だったか（何を頼まれていたか）',
    'WHAT: その場面で、こちらが何をしたのが悪かったか',
    'WHY: なぜそれが問題なのか（利用者にとって何が困るのか）',
    'NEXT: 同じ場面で、次からどうするか',
  ].join('\n');
}

export interface Understood {
  /** どういう場面だったか。**これが無いと「何をしても怒られた」になる。** */
  when: string;
  what: string;
  why: string;
  next: string;
}

/**
 * 考えたものを受け取る。
 *
 * **足りないものは、足りないと言う。**埋めて返すと、考えていないのに
 * 考えた顔の覚えが残る。それがいちばん質の悪い覚えになる。
 */
export function parseUnderstanding(text: string, fallbackWhen?: string): Understood | undefined {
  const pick = (key: string): string | undefined => {
    // **飾りを許す。**小さいモデルは `**WHAT:**` や `- WHAT:` をよく出す。
    // 素の形しか読めなかったので、いちばんよく来る形を落としていた。
    const m = new RegExp(
      `^[\\s>*\\-#・•]*\\*{0,2}${key}\\*{0,2}\\s*[:：]\\s*(.+?)\\s*$`, 'mi',
    ).exec(text);
    // 端の飾りは、まとめて落とす。一段だけ剥がすと `** **中身**` が残る。
    const got = m?.[1]?.replace(/^[\s*]+|[\s*]+$/g, '');
    return got && got.length > 1 ? got : undefined;
  };
  const what = pick('WHAT');
  const next = pick('NEXT');
  if (!what || !next) return undefined;
  // 場面は、こちらでも分かっている。書かれていなければ、こちらのを使う。
  const when = pick('WHEN') ?? fallbackWhen;
  if (!when) return undefined;
  return { when, what, why: pick('WHY') ?? '（理由まで書かれていません）', next };
}

/**
 * 考えたものを、覚えの一行にする。
 *
 * **必ず場面から書く。**場面が無いと「提案したら怒られた」「黙っていたら
 * 怒られた」が並ぶだけになる。それは学びではなく、
 * **相手が理不尽だという記録**にしかならない。
 */
export function lessonFromUnderstanding(u: Understood, did?: string): string {
  return [
    `【場面】${u.when}`,
    `【したこと】${u.what} — ${u.why}`,
    `【次から】${u.next}`,
    did ? `（このとき: ${did}）` : '',
  ].filter(Boolean).join(' / ');
}

/**
 * 学びを一行にする。
 *
 * **直前に何をしていたかを、必ず添える。**符丁だけだと「同じことを言わせた」
 * が並ぶだけで、次に何を変えればいいのかが分からない。
 */
export function lessonFrom(code: DispleasureCode, when?: string, did?: string): string {
  // **考えられなかったときの受け皿。**決め文句なので、意味までは入っていない。
  // 入っていないことが分かるように、印を付けておく（消化できていない、と）。
  return [
    when ? `【場面】${when}` : '',
    `${DISPLEASURE_RULE[code]}【未消化: 何が嫌だったかまでは掴めていません】`,
    did ? `（このとき: ${did}）` : '',
  ].filter(Boolean).join(' / ');
}
