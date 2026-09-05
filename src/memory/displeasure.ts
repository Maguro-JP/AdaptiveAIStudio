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
      /言(って|った)(る)?(よ|ん)?[ねな]/, /何度(も|言)/, /また[^。]{0,6}(か|かよ|ですか)/,
      // 「また障害発生してる?」のような、問い返しの形。
      /また[^。！？\n]{0,12}[?？]/,
      /前(に|も)言/, /さっき(も|言)/, /毎回/, /いつも/, /二度と/,
    ],
  },
  {
    code: 'STOP',
    patterns: [/やめて/, /辞めて/, /やめろ/, /しないで/, /するな/, /要らない/, /いらない/, /余計/],
  },
  {
    code: 'OFFENSIVE',
    patterns: [/気持ち悪い/, /不快/, /嫌(だ|い|な)/, /失礼/, /馬鹿にして/, /舐めて/],
  },
  {
    code: 'ANGRY',
    patterns: [
      /無能/, /ふざけ/, /いい加減/, /ボケ/, /殺す/, /クソ/, /くそ/, /最悪/,
      /真面目に/, /ちゃんと(しろ|して|やれ)/, /訴え/, /クレーム/,
    ],
  },
  {
    code: 'STALLED',
    patterns: [/止ま(って|った)/, /進んで(ない|いない)/, /遅い/, /まだ(かよ|なの)/, /フリーズ/, /固ま(って|った)/],
  },
  {
    code: 'BROKEN',
    patterns: [
      /動(か|い)(ない|てない|ていない)/, /出来て(ない|いない)/, /できて(ない|いない)/,
      /壊れ(て|た)/, /直って(ない|いない)/, /粗末/, /雑/, /使えない/,
      /なって(ない|いない)/, /違う/, /そうじゃない/,
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
export function understandPrompt(said: string, did?: string): string {
  return [
    '利用者が、いまの作業に不満を示しました。何が問題だったのかを考えてください。',
    '',
    `利用者の言葉: ${said.trim().slice(0, 600)}`,
    did ? `直前にこちらがしたこと: ${did}` : '直前にこちらがしたこと: 分かりません',
    '',
    '次の三行だけを、この形で返してください。前置きも説明も要りません。',
    'WHAT: 何が問題だったか（利用者の言葉ではなく、こちらの何が悪かったか）',
    'WHY: なぜそれが問題なのか（利用者にとって何が困るのか）',
    'NEXT: 次から具体的にどう変えるか',
  ].join('\n');
}

export interface Understood {
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
export function parseUnderstanding(text: string): Understood | undefined {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+?)\\s*$`, 'mi').exec(text);
    const got = m?.[1]?.trim();
    return got && got.length > 1 ? got : undefined;
  };
  const what = pick('WHAT');
  const why = pick('WHY');
  const next = pick('NEXT');
  if (!what || !next) return undefined;
  return { what, why: why ?? '（理由まで書かれていません）', next };
}

/** 考えたものを、覚えの一行にする。 */
export function lessonFromUnderstanding(u: Understood, did?: string): string {
  return [
    `${u.what} — ${u.why}`,
    `次から: ${u.next}`,
    did ? `（このとき: ${did}）` : '',
  ].filter(Boolean).join(' / ');
}

/**
 * 学びを一行にする。
 *
 * **直前に何をしていたかを、必ず添える。**符丁だけだと「同じことを言わせた」
 * が並ぶだけで、次に何を変えればいいのかが分からない。
 */
export function lessonFrom(code: DispleasureCode, did?: string): string {
  // **考えられなかったときの受け皿。**決め文句なので、意味までは入っていない。
  // 入っていないことが分かるように、印を付けておく（消化できていない、と）。
  const rule = `${DISPLEASURE_RULE[code]}【未消化: 何が嫌だったかまでは掴めていません】`;
  return did ? `${rule}（このとき: ${did}）` : rule;
}
