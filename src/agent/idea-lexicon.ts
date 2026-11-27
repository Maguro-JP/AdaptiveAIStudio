/**
 * アイデアの語彙 — IDEAMAN の語彙プールと文型を、そのままの形で移したもの。
 *
 * 語は `term` と分野タグ `domains` を持つ。生成側（`ideas.ts`）は、タグの
 * 重なりが少ない組を優先して「普段結びつかない衝突」を作る。
 * 外の世界から採る仕組み（mechanisms）はまだ持たない。仕組みを使う文型は、
 * 生成側の決まりで自動的に選ばれなくなる。
 * 語のうち2つ（AdaptiveAIStudio で別の意味に使う語を含むもの）は、移すときに除いた。
 */
import type { IdeaLexicon } from './ideas.ts';

export const IDEA_LEXICON: IdeaLexicon = {
  "pools": {
    "concepts": [
      {
        "term": "手紙",
        "domains": [
          "communication",
          "analog"
        ]
      },
      {
        "term": "検針",
        "domains": [
          "physical",
          "rule"
        ]
      },
      {
        "term": "待ち時間",
        "domains": [
          "time",
          "ux"
        ]
      },
      {
        "term": "忘却",
        "domains": [
          "memory",
          "mind"
        ]
      },
      {
        "term": "台所",
        "domains": [
          "daily",
          "space"
        ]
      },
      {
        "term": "改札",
        "domains": [
          "city",
          "system"
        ]
      },
      {
        "term": "図書館",
        "domains": [
          "knowledge",
          "space"
        ]
      },
      {
        "term": "名前",
        "domains": [
          "identity",
          "language"
        ]
      },
      {
        "term": "行列",
        "domains": [
          "city",
          "system"
        ]
      },
      {
        "term": "定員",
        "domains": [
          "rule",
          "space"
        ]
      },
      {
        "term": "賞味期限",
        "domains": [
          "time",
          "daily"
        ]
      },
      {
        "term": "名簿",
        "domains": [
          "social",
          "information"
        ]
      },
      {
        "term": "迷子",
        "domains": [
          "space",
          "emotion"
        ]
      },
      {
        "term": "目次",
        "domains": [
          "information",
          "structure"
        ]
      },
      {
        "term": "議事録",
        "domains": [
          "language",
          "memory"
        ]
      },
      {
        "term": "しおり",
        "domains": [
          "memory",
          "structure"
        ]
      },
      {
        "term": "通知",
        "domains": [
          "ux",
          "communication"
        ]
      },
      {
        "term": "待合室",
        "domains": [
          "space",
          "time"
        ]
      },
      {
        "term": "方言",
        "domains": [
          "language",
          "culture"
        ]
      },
      {
        "term": "引き出し",
        "domains": [
          "daily",
          "structure"
        ]
      },
      {
        "term": "時刻表",
        "domains": [
          "time",
          "structure"
        ]
      },
      {
        "term": "貼り紙",
        "domains": [
          "language",
          "space"
        ]
      },
      {
        "term": "定食屋",
        "domains": [
          "daily",
          "culture"
        ]
      },
      {
        "term": "補助輪",
        "domains": [
          "learning",
          "physical"
        ]
      },
      {
        "term": "交差点",
        "domains": [
          "city",
          "space"
        ]
      },
      {
        "term": "訃報",
        "domains": [
          "social",
          "emotion"
        ]
      },
      {
        "term": "潮見表",
        "domains": [
          "nature",
          "time",
          "information"
        ]
      },
      {
        "term": "予約席",
        "domains": [
          "rule",
          "space"
        ]
      },
      {
        "term": "予報",
        "domains": [
          "time",
          "information"
        ]
      },
      {
        "term": "相槌",
        "domains": [
          "communication",
          "social"
        ]
      },
      {
        "term": "廃線",
        "domains": [
          "city",
          "memory"
        ]
      },
      {
        "term": "仕込み",
        "domains": [
          "time",
          "food"
        ]
      },
      {
        "term": "索引",
        "domains": [
          "knowledge",
          "structure"
        ]
      },
      {
        "term": "停電",
        "domains": [
          "system",
          "emotion"
        ]
      },
      {
        "term": "遠回り",
        "domains": [
          "space",
          "play"
        ]
      },
      {
        "term": "見習い",
        "domains": [
          "social",
          "learning"
        ]
      },
      {
        "term": "実習",
        "domains": [
          "learning",
          "social"
        ]
      },
      {
        "term": "借り物",
        "domains": [
          "social",
          "economy"
        ]
      },
      {
        "term": "早送り",
        "domains": [
          "time",
          "ux"
        ]
      },
      {
        "term": "剪定",
        "domains": [
          "nature",
          "rule"
        ]
      },
      {
        "term": "合鍵",
        "domains": [
          "trust",
          "physical"
        ]
      },
      {
        "term": "給水塔",
        "domains": [
          "city",
          "system"
        ]
      },
      {
        "term": "当番表",
        "domains": [
          "social",
          "rule",
          "time"
        ]
      },
      {
        "term": "端数",
        "domains": [
          "economy",
          "structure"
        ]
      },
      {
        "term": "手順書",
        "domains": [
          "rule",
          "learning"
        ]
      },
      {
        "term": "校歌",
        "domains": [
          "culture",
          "memory"
        ]
      },
      {
        "term": "発酵",
        "domains": [
          "nature",
          "time"
        ]
      },
      {
        "term": "非常口",
        "domains": [
          "system",
          "space"
        ]
      },
      {
        "term": "折り返し地点",
        "domains": [
          "time",
          "structure"
        ]
      },
      {
        "term": "常連",
        "domains": [
          "social",
          "daily"
        ]
      },
      {
        "term": "見出し",
        "domains": [
          "information",
          "language"
        ]
      },
      {
        "term": "下足札",
        "domains": [
          "physical",
          "identity"
        ]
      },
      {
        "term": "番号札",
        "domains": [
          "system",
          "social"
        ]
      },
      {
        "term": "下書き",
        "domains": [
          "creation",
          "structure"
        ]
      },
      {
        "term": "空き家",
        "domains": [
          "city",
          "memory"
        ]
      },
      {
        "term": "口約束",
        "domains": [
          "trust",
          "communication"
        ]
      },
      {
        "term": "目覚まし",
        "domains": [
          "time",
          "daily"
        ]
      },
      {
        "term": "相部屋",
        "domains": [
          "social",
          "space"
        ]
      },
      {
        "term": "校正",
        "domains": [
          "language",
          "rule"
        ]
      },
      {
        "term": "引っ越し",
        "domains": [
          "space",
          "emotion"
        ]
      },
      {
        "term": "献立",
        "domains": [
          "daily",
          "structure"
        ]
      },
      {
        "term": "匿名",
        "domains": [
          "identity",
          "trust"
        ]
      },
      {
        "term": "棚卸し",
        "domains": [
          "economy",
          "time"
        ]
      },
      {
        "term": "中古品",
        "domains": [
          "economy",
          "memory"
        ]
      },
      {
        "term": "待ち合わせ",
        "domains": [
          "social",
          "space"
        ]
      },
      {
        "term": "検温",
        "domains": [
          "physical",
          "rule"
        ]
      },
      {
        "term": "敬語",
        "domains": [
          "language",
          "social"
        ]
      }
    ],
    "operations": [
      {
        "term": "反転させる",
        "domains": [
          "structure"
        ],
        "kind": "verb"
      },
      {
        "term": "半分に削る",
        "domains": [
          "structure"
        ],
        "kind": "verb"
      },
      {
        "term": "逆順で始める",
        "domains": [
          "time",
          "structure"
        ],
        "kind": "verb"
      },
      {
        "term": "誰か他人に委ねる",
        "domains": [
          "social"
        ],
        "kind": "verb"
      },
      {
        "term": "一切見えなくする",
        "domains": [
          "sense"
        ],
        "kind": "verb"
      },
      {
        "term": "一度だけ許す",
        "domains": [
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "十年後に届ける",
        "domains": [
          "time"
        ],
        "kind": "verb"
      },
      {
        "term": "音だけで表す",
        "domains": [
          "sense",
          "sound"
        ],
        "kind": "verb"
      },
      {
        "term": "わざと失敗させる",
        "domains": [
          "play",
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "全部公開する",
        "domains": [
          "trust",
          "social"
        ],
        "kind": "verb"
      },
      {
        "term": "数を数えるのをやめる",
        "domains": [
          "rule",
          "information"
        ],
        "kind": "phrase"
      },
      {
        "term": "引き継げるようにする",
        "domains": [
          "social",
          "time"
        ],
        "kind": "verb"
      },
      {
        "term": "使い捨てにする",
        "domains": [
          "economy",
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "自動で忘れさせる",
        "domains": [
          "memory",
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "二人でないと動かなくする",
        "domains": [
          "social",
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "遅延させる",
        "domains": [
          "time",
          "ux"
        ],
        "kind": "verb"
      },
      {
        "term": "手で触れるようにする",
        "domains": [
          "physical",
          "sense"
        ],
        "kind": "verb"
      },
      {
        "term": "増殖させる",
        "domains": [
          "structure"
        ],
        "kind": "verb"
      },
      {
        "term": "一行だけにする",
        "domains": [
          "structure",
          "language"
        ],
        "kind": "verb"
      },
      {
        "term": "場所に縛りつける",
        "domains": [
          "space",
          "rule"
        ],
        "kind": "verb"
      },
      {
        "term": "天気に連動させる",
        "domains": [
          "nature",
          "system"
        ],
        "kind": "verb"
      },
      {
        "term": "順番待ちを可視化する",
        "domains": [
          "system",
          "ux"
        ],
        "kind": "phrase"
      },
      {
        "term": "主役と脇役を入れ替える",
        "domains": [
          "story",
          "structure"
        ],
        "kind": "phrase"
      },
      {
        "term": "未完成のまま渡す",
        "domains": [
          "creation",
          "social"
        ],
        "kind": "verb"
      },
      {
        "term": "声に出させる",
        "domains": [
          "sound",
          "social"
        ],
        "kind": "verb"
      },
      {
        "term": "毎回違う姿にする",
        "domains": [
          "identity",
          "play"
        ],
        "kind": "verb"
      },
      {
        "term": "誰のものでもなくする",
        "domains": [
          "economy",
          "trust"
        ],
        "kind": "verb"
      },
      {
        "term": "途中から参加できるようにする",
        "domains": [
          "time",
          "social"
        ],
        "kind": "verb"
      }
    ],
    "constraints": [
      {
        "term": "十秒以内で",
        "domains": [
          "time"
        ]
      },
      {
        "term": "一人きりで",
        "domains": [
          "social"
        ]
      },
      {
        "term": "声だけで",
        "domains": [
          "sound",
          "sense"
        ]
      },
      {
        "term": "予算ゼロで",
        "domains": [
          "economy"
        ]
      },
      {
        "term": "紙の上だけで",
        "domains": [
          "analog",
          "physical"
        ]
      },
      {
        "term": "文字を使わずに",
        "domains": [
          "language"
        ]
      },
      {
        "term": "一日一回だけ",
        "domains": [
          "time",
          "rule"
        ]
      },
      {
        "term": "見知らぬ人と",
        "domains": [
          "social",
          "trust"
        ]
      },
      {
        "term": "説明書なしで",
        "domains": [
          "ux",
          "learning"
        ]
      },
      {
        "term": "三つの部品だけで",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "元に戻せない形で",
        "domains": [
          "rule",
          "time"
        ]
      },
      {
        "term": "誰にも見られずに",
        "domains": [
          "trust",
          "identity"
        ]
      },
      {
        "term": "十年続く前提で",
        "domains": [
          "time"
        ]
      },
      {
        "term": "子どもにも分かる形で",
        "domains": [
          "learning",
          "language"
        ]
      },
      {
        "term": "手放すことを前提に",
        "domains": [
          "economy",
          "emotion"
        ]
      },
      {
        "term": "立ったまま終わる速さで",
        "domains": [
          "time",
          "physical"
        ]
      },
      {
        "term": "調子の悪い日でも回る形で",
        "domains": [
          "rule",
          "nature"
        ]
      },
      {
        "term": "自動化を一切使わずに",
        "domains": [
          "physical",
          "economy"
        ]
      },
      {
        "term": "いつでも後戻りできる形で",
        "domains": [
          "rule"
        ]
      },
      {
        "term": "明日引き継ぐ前提で",
        "domains": [
          "social",
          "learning"
        ]
      },
      {
        "term": "半分の手間で",
        "domains": [
          "economy",
          "ux"
        ]
      },
      {
        "term": "失敗しても誰も困らない形で",
        "domains": [
          "rule",
          "trust"
        ]
      }
    ],
    "provocations": [
      {
        "term": "それは本当に必要か",
        "domains": [
          "rule"
        ]
      },
      {
        "term": "誰も損をしないか",
        "domains": [
          "social",
          "economy"
        ]
      },
      {
        "term": "逆に不便にしたらどうなるか",
        "domains": [
          "ux",
          "play"
        ]
      },
      {
        "term": "百年前ならどうしていたか",
        "domains": [
          "time",
          "culture"
        ]
      },
      {
        "term": "失われたら誰が困るか",
        "domains": [
          "social",
          "emotion"
        ]
      },
      {
        "term": "なぜ今まで誰もやらなかったのか",
        "domains": [
          "creation"
        ]
      },
      {
        "term": "最初の一人はどう始めるか",
        "domains": [
          "social",
          "learning"
        ]
      },
      {
        "term": "途中でやめたらどうなるか",
        "domains": [
          "time",
          "rule"
        ]
      },
      {
        "term": "それを嫌う人は何を守っているのか",
        "domains": [
          "social",
          "emotion"
        ]
      },
      {
        "term": "数えられないものは何か",
        "domains": [
          "information",
          "mind"
        ]
      },
      {
        "term": "静かにやる方法はあるか",
        "domains": [
          "sound",
          "social"
        ]
      },
      {
        "term": "一番安い版はどんな形か",
        "domains": [
          "economy",
          "structure"
        ]
      }
    ],
    "aspects": [
      {
        "term": "順番",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "頻度",
        "domains": [
          "time"
        ]
      },
      {
        "term": "入り口",
        "domains": [
          "ux"
        ]
      },
      {
        "term": "終わり方",
        "domains": [
          "ux"
        ]
      },
      {
        "term": "待ち時間",
        "domains": [
          "time",
          "ux"
        ]
      },
      {
        "term": "初期状態",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "失敗したときの挙動",
        "domains": [
          "rule"
        ]
      },
      {
        "term": "名前",
        "domains": [
          "language"
        ]
      },
      {
        "term": "単位",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "見た目",
        "domains": [
          "art",
          "ux"
        ]
      },
      {
        "term": "手数",
        "domains": [
          "ux"
        ]
      },
      {
        "term": "記録の残り方",
        "domains": [
          "memory",
          "information"
        ]
      },
      {
        "term": "例外の扱い",
        "domains": [
          "rule"
        ]
      },
      {
        "term": "境界",
        "domains": [
          "structure",
          "space"
        ]
      },
      {
        "term": "一番よく使う部分",
        "domains": [
          "ux"
        ]
      },
      {
        "term": "誰も見ていない部分",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "一番お金がかかっている部分",
        "domains": [
          "economy"
        ]
      },
      {
        "term": "一番遅いところ",
        "domains": [
          "time"
        ]
      },
      {
        "term": "やり直しのきかない部分",
        "domains": [
          "rule"
        ]
      },
      {
        "term": "説明が一番長くなる部分",
        "domains": [
          "language",
          "ux"
        ]
      },
      {
        "term": "誰も使っていない部分",
        "domains": [
          "ux"
        ]
      },
      {
        "term": "誰が決めるか",
        "domains": [
          "social",
          "rule"
        ],
        "kind": "clause"
      },
      {
        "term": "誰が得をしているか",
        "domains": [
          "social",
          "economy"
        ],
        "kind": "clause"
      },
      {
        "term": "誰が損をしているか",
        "domains": [
          "social",
          "economy"
        ],
        "kind": "clause"
      },
      {
        "term": "何が一番よく壊れるか",
        "domains": [
          "rule"
        ],
        "kind": "clause"
      },
      {
        "term": "何が一番時間を食っているか",
        "domains": [
          "time"
        ],
        "kind": "clause"
      },
      {
        "term": "なぜ二度手間になっているか",
        "domains": [
          "ux",
          "structure"
        ],
        "kind": "clause"
      },
      {
        "term": "何を諦めて今の形になったか",
        "domains": [
          "rule",
          "memory"
        ],
        "kind": "clause"
      }
    ],
    "probes": [
      {
        "term": "紙に1枚だけ書いてみる",
        "domains": [
          "analog"
        ]
      },
      {
        "term": "既存のものを1つ選んで作り替える",
        "domains": [
          "creation"
        ]
      },
      {
        "term": "1日だけその運用にしてみる",
        "domains": [
          "time"
        ]
      },
      {
        "term": "一番小さい例で手を動かす",
        "domains": [
          "creation"
        ]
      },
      {
        "term": "誰か1人に見せて反応を見る",
        "domains": [
          "social"
        ]
      },
      {
        "term": "逆の状態を作って比べる",
        "domains": [
          "structure"
        ]
      },
      {
        "term": "5件だけ手で作ってみる",
        "domains": [
          "creation"
        ]
      },
      {
        "term": "今あるログを見返す",
        "domains": [
          "information"
        ]
      },
      {
        "term": "15分だけ試して捨てる",
        "domains": [
          "time"
        ]
      },
      {
        "term": "一番困っている場面を1つ書き出す",
        "domains": [
          "mind"
        ]
      }
    ]
  },
  "moods": [
    "静穏",
    "挑発",
    "郷愁",
    "実務",
    "夢想",
    "逆説"
  ],
  "templates": [
    {
      "id": "swap_aspect",
      "tone": "proposal",
      "needs": [
        "material",
        "aspect",
        "operation_v",
        "probe"
      ],
      "text": "{material}の{aspect}を{operation_v}。まず{probe}。"
    },
    {
      "id": "borrow_from",
      "tone": "proposal",
      "needs": [
        "material",
        "concept_a",
        "aspect",
        "probe"
      ],
      "text": "{concept_a}のやり方を{material}に持ち込む。見るのは{aspect}。まず{probe}。"
    },
    {
      "id": "mechanism_transfer",
      "tone": "proposal",
      "needs": [
        "material",
        "mechanism"
      ],
      "text": "{mechanism_how}（{mechanism}）。{material}の{mechanism_aspect}で同じことをするなら、何が要るか。"
    },
    {
      "id": "constrained_rebuild",
      "tone": "proposal",
      "needs": [
        "material",
        "constraint",
        "aspect",
        "probe"
      ],
      "text": "{constraint}{material}を作り直すとしたら、{aspect}はどうなるか。まず{probe}。"
    },
    {
      "id": "remove_and_see",
      "tone": "proposal",
      "needs": [
        "material",
        "aspect"
      ],
      "text": "{material}から{aspect}を丸ごと取り除く。困る人がいれば、そこが本体。"
    },
    {
      "id": "exaggerate",
      "tone": "proposal",
      "needs": [
        "material",
        "aspect",
        "operation"
      ],
      "text": "{material}の{aspect}だけを極端にする。{operation}くらいまで。"
    },
    {
      "id": "two_materials",
      "tone": "proposal",
      "needs": [
        "material",
        "concept_a",
        "aspect"
      ],
      "text": "{material}と{concept_a}は、{aspect}だけ見れば同じではないか。"
    },
    {
      "id": "for_one_person",
      "tone": "proposal",
      "needs": [
        "material",
        "aspect"
      ],
      "text": "いちばんヘビーに使う一人のためだけに{material}を作り直す。まず{aspect}が変わるはず。"
    },
    {
      "id": "question_aspect",
      "tone": "question",
      "needs": [
        "material",
        "aspect",
        "provocation"
      ],
      "text": "{material}の{aspect}について——{provocation}。"
    },
    {
      "id": "question_assumption",
      "tone": "question",
      "needs": [
        "material",
        "aspect"
      ],
      "text": "{material}の{aspect}は、なぜ今の形なのか。"
    },
    {
      "id": "question_clause",
      "tone": "question",
      "needs": [
        "material",
        "aspect_q"
      ],
      "text": "{material}について、{aspect_q}。いま答えられるか。"
    },
    {
      "id": "question_clause_probe",
      "tone": "question",
      "needs": [
        "material",
        "aspect_q",
        "probe"
      ],
      "text": "{material}で{aspect_q}。まず{probe}。"
    },
    {
      "id": "question_absence",
      "tone": "question",
      "needs": [
        "material",
        "concept_a",
        "aspect"
      ],
      "text": "{material}の{aspect}を、{concept_a}のそれと並べてみる。無いものは何か。"
    },
    {
      "id": "question_constrained",
      "tone": "question",
      "needs": [
        "material",
        "constraint",
        "provocation"
      ],
      "text": "{constraint}{material}を扱うとする。{provocation}。"
    },
    {
      "id": "bare_collision",
      "tone": "proposal",
      "needs": [
        "concept_a",
        "concept_b",
        "aspect",
        "probe"
      ],
      "text": "{concept_a}のやり方を{concept_b}に持ち込む。見るのは{aspect}。まず{probe}。"
    },
    {
      "id": "bare_swap",
      "tone": "proposal",
      "needs": [
        "concept_a",
        "aspect",
        "operation_v",
        "probe"
      ],
      "text": "{concept_a}の{aspect}を{operation_v}。何が変わるか。まず{probe}。"
    },
    {
      "id": "bare_constrained",
      "tone": "question",
      "needs": [
        "concept_a",
        "constraint",
        "aspect"
      ],
      "text": "{constraint}{concept_a}を作り直すとしたら、{aspect}はどうなるか。"
    },
    {
      "id": "bare_question",
      "tone": "question",
      "needs": [
        "concept_a",
        "aspect",
        "provocation"
      ],
      "text": "{concept_a}の{aspect}について——{provocation}。"
    }
  ]
};
