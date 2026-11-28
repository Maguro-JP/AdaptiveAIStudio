# アイデアの拡張機能に同梱しているデータの表示

このフォルダの 3 本の JSON は、公開のリポジトリ IDEAMAN（https://github.com/Maguro-JP/IDEAMAN）の
`ideaman/data/` の YAML（`lexicon.yaml`・`templates.yaml`・`mechanisms.yaml`）を、中身を変えずに JSON に直したものです。

| ファイル | 中身 | 元 |
|---|---|---|
| `lexicon.json` | 語のプール（概念・操作・制約・問いかけ・側面・試し方）と気分 | IDEAMAN の `lexicon.yaml` |
| `templates.json` | 文の型 | IDEAMAN の `templates.yaml` |
| `mechanisms.json` | 外の世界の仕組みの文（何をどうしているかの 1 文）と、その出典 | IDEAMAN の `mechanisms.yaml` |

## 仕組みの文（mechanisms.json）のライセンス

`mechanisms.json` の `how` は、日本語版ウィキペディアの記事の文です（脚注と、読みの括弧を除いたもの）。
文章は「クリエイティブ・コモンズ 表示-継承 4.0 国際」（CC BY-SA 4.0）で提供されています。

- ライセンス: https://creativecommons.org/licenses/by-sa/4.0/deed.ja
- 著作者: 下の各記事の執筆者（各記事の履歴に載っています）
- 変えた所: 記事から 1 文を抜き出し、脚注と読みの括弧を除いています。文の末尾の句点を外して、札の文に埋め込みます
- この文を含むデータ（`mechanisms.json`）を配り直すときは、同じライセンス（CC BY-SA 4.0）で、出典の表示を残してください

画面では、札の「なぜ」を押すと、元の文と、その記事の URL と、ライセンスの名前が出ます。

## 出典の記事

- ごみ収集車: https://ja.wikipedia.org/wiki/ごみ収集車
- エレベーター: https://ja.wikipedia.org/wiki/エレベーター
- コンバインハーベスター: https://ja.wikipedia.org/wiki/コンバインハーベスター
- ダム: https://ja.wikipedia.org/wiki/ダム
- パイプオルガン: https://ja.wikipedia.org/wiki/パイプオルガン
- ピアノ: https://ja.wikipedia.org/wiki/ピアノ
- ラウンドアバウト: https://ja.wikipedia.org/wiki/ラウンドアバウト
- 人工透析: https://ja.wikipedia.org/wiki/人工透析
- 冬眠: https://ja.wikipedia.org/wiki/冬眠
- 冷蔵庫: https://ja.wikipedia.org/wiki/冷蔵庫
- 回転寿司: https://ja.wikipedia.org/wiki/回転寿司
- 堆肥: https://ja.wikipedia.org/wiki/堆肥
- 天ぷら: https://ja.wikipedia.org/wiki/天ぷら
- 将棋: https://ja.wikipedia.org/wiki/将棋
- 尺八: https://ja.wikipedia.org/wiki/尺八
- 手術: https://ja.wikipedia.org/wiki/手術
- 持ち時間: https://ja.wikipedia.org/wiki/持ち時間
- 時計: https://ja.wikipedia.org/wiki/時計
- 浄水場: https://ja.wikipedia.org/wiki/浄水場
- 消化: https://ja.wikipedia.org/wiki/消化
- 消防: https://ja.wikipedia.org/wiki/消防
- 灌漑: https://ja.wikipedia.org/wiki/灌漑
- 灯台: https://ja.wikipedia.org/wiki/灯台
- 緊急地震速報: https://ja.wikipedia.org/wiki/緊急地震速報
- 蒸留: https://ja.wikipedia.org/wiki/蒸留
- 血液凝固: https://ja.wikipedia.org/wiki/血液凝固
- 調律: https://ja.wikipedia.org/wiki/調律
- 避難: https://ja.wikipedia.org/wiki/避難
- 金庫: https://ja.wikipedia.org/wiki/金庫
- 閘門: https://ja.wikipedia.org/wiki/閘門
- 魔法瓶: https://ja.wikipedia.org/wiki/魔法瓶
- かな漢字変換: https://ja.wikipedia.org/wiki/かな漢字変換
- ため池: https://ja.wikipedia.org/wiki/ため池
- オルゴール: https://ja.wikipedia.org/wiki/オルゴール
- クラッチ: https://ja.wikipedia.org/wiki/クラッチ
- コーヒー: https://ja.wikipedia.org/wiki/コーヒー
- シートベルト: https://ja.wikipedia.org/wiki/シートベルト
- トランペット: https://ja.wikipedia.org/wiki/トランペット
- ビーバー: https://ja.wikipedia.org/wiki/ビーバー
- ビール: https://ja.wikipedia.org/wiki/ビール
- ボールペン: https://ja.wikipedia.org/wiki/ボールペン
- マークシート: https://ja.wikipedia.org/wiki/マークシート
- ミシン: https://ja.wikipedia.org/wiki/ミシン
- ヴァイオリン: https://ja.wikipedia.org/wiki/ヴァイオリン
- 人工呼吸器: https://ja.wikipedia.org/wiki/人工呼吸器
- 体温計: https://ja.wikipedia.org/wiki/体温計
- 印鑑: https://ja.wikipedia.org/wiki/印鑑
- 差動装置: https://ja.wikipedia.org/wiki/差動装置
- 心肺蘇生法: https://ja.wikipedia.org/wiki/心肺蘇生法
- 日本酒: https://ja.wikipedia.org/wiki/日本酒
- 校倉造: https://ja.wikipedia.org/wiki/校倉造
- 滑車: https://ja.wikipedia.org/wiki/滑車
- 火消: https://ja.wikipedia.org/wiki/火消
- 献血: https://ja.wikipedia.org/wiki/献血
- 石垣: https://ja.wikipedia.org/wiki/石垣
- 納豆: https://ja.wikipedia.org/wiki/納豆
- 索道: https://ja.wikipedia.org/wiki/索道
- 聴診器: https://ja.wikipedia.org/wiki/聴診器
- 自動列車停止装置: https://ja.wikipedia.org/wiki/自動列車停止装置
- 自動販売機: https://ja.wikipedia.org/wiki/自動販売機
- 自転車: https://ja.wikipedia.org/wiki/自転車
- 落語: https://ja.wikipedia.org/wiki/落語
- 運河: https://ja.wikipedia.org/wiki/運河
- 道の駅: https://ja.wikipedia.org/wiki/道の駅
- 電子レンジ: https://ja.wikipedia.org/wiki/電子レンジ
- 食器洗い機: https://ja.wikipedia.org/wiki/食器洗い機
- 養蜂: https://ja.wikipedia.org/wiki/養蜂
- 鷹狩: https://ja.wikipedia.org/wiki/鷹狩
- ICカード乗車券: https://ja.wikipedia.org/wiki/ICカード乗車券
- めっき: https://ja.wikipedia.org/wiki/めっき
- オセロ: https://ja.wikipedia.org/wiki/オセロ_(ボードゲーム)
- カーリング: https://ja.wikipedia.org/wiki/カーリング
- トイレ: https://ja.wikipedia.org/wiki/トイレ
- トランプ: https://ja.wikipedia.org/wiki/トランプ
- ペットボトル: https://ja.wikipedia.org/wiki/ペットボトル
- 吊橋: https://ja.wikipedia.org/wiki/吊橋
- 和太鼓: https://ja.wikipedia.org/wiki/和太鼓
- 土嚢: https://ja.wikipedia.org/wiki/土嚢
- 墨: https://ja.wikipedia.org/wiki/墨
- 歌舞伎: https://ja.wikipedia.org/wiki/歌舞伎
- 汲み取り式便所: https://ja.wikipedia.org/wiki/汲み取り式便所
- 洗濯機: https://ja.wikipedia.org/wiki/洗濯機
- 百人一首: https://ja.wikipedia.org/wiki/百人一首
- 能: https://ja.wikipedia.org/wiki/能
- 花札: https://ja.wikipedia.org/wiki/花札
