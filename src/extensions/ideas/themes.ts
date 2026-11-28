/**
 * テーマの語（材料）を、今の作業場と直近の依頼から採る。
 *
 * 材料は、文の中に名詞として埋め込まれる（「{材料}の{側面}を…」）。文を入れると
 * 「予約の締切をどうするか決めきれていないの頻度を…」になるので、語であることをここで確かめる
 * （IDEAMAN の ideaman/store.py の `clean_material` を移したもの）。
 */
import { basename } from 'node:path';

/** 材料として受ける長さの上限。日本語の語は短く、英語の語は長いので、文字の種類で分ける。 */
export const MAX_MATERIAL_LEN_JA = 12;
export const MAX_MATERIAL_LEN_ASCII = 24;
/** 自動で採る語の数の上限。多いと、どの札も違う語になって、今の作業から離れる。 */
export const MAX_AUTO_THEMES = 8;

const JAPANESE = /[ぁ-んァ-ヴ一-龥々〆ヵヶ]/;
const NOT_A_WORD = /[。、！？!?,\s]/;
const HAS_LETTER = /[0-9A-Za-zぁ-んァ-ヴ一-龥々〆ヵヶー]/;

/** 材料として使える形に整える。使えないなら undefined（空・1 文字・長すぎる・句読点や空白を含む・文字を含まない）。 */
export function cleanMaterial(raw: string): string | undefined {
  const term = raw.normalize('NFKC').trim();
  if ([...term].length < 2) return undefined;
  const limit = JAPANESE.test(term) ? MAX_MATERIAL_LEN_JA : MAX_MATERIAL_LEN_ASCII;
  if ([...term].length > limit) return undefined;
  if (NOT_A_WORD.test(term) || !HAS_LETTER.test(term)) return undefined;
  return term;
}

/** どの頼みにも出てくる語。材料にしても、今の作業の話にならない。 */
const COMMON = new Set([
  '今日', '明日', '以下', '以上', '場合', '必要', '確認', '作成', '修正', '追加', '変更', '対応', '実行', '使用', '利用',
  '部分', '全部', '自分', '一覧', '今回', '問題', '方法', '結果', '内容', '説明', '質問', '回答', '依頼', '答え', '最初', '最後',
  '実装', '機能', '処理', 'ファイル', 'コード', 'システム', 'お願い', 'ください', 'テスト', 'エラー',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'not', 'are', 'was', 'you', 'your', 'can', 'will', 'use',
  'http', 'https', 'www', 'com', 'org', 'src', 'tmp', 'var', 'let', 'const', 'function', 'return', 'true', 'false', 'null', 'app', 'work',
]);

/** 文から、語の候補を出てきた順に拾う。カタカナの連なり・漢字の連なり・英字の語。 */
export function wordsIn(text: string): string[] {
  const found = text.normalize('NFKC').match(/[ァ-ヴー]{3,12}|[一-龥々]{2,6}|[A-Za-z][A-Za-z0-9]{2,23}/g) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const word = cleanMaterial(raw);
    if (!word || COMMON.has(word) || COMMON.has(word.toLowerCase())) continue;
    out.push(word);
  }
  return out;
}

/**
 * 自動で採るテーマの語。直近の依頼（新しいものが先）に出てくる語を、出てきた回数の多い順に採り、
 * 足りなければ作業場のフォルダの名前を足す。同じ入力なら同じ並びになる。
 */
export function autoThemes(input: { workRoot?: string; recentRequests?: readonly string[] }, max: number = MAX_AUTO_THEMES): string[] {
  const count = new Map<string, number>();
  const order: string[] = [];
  for (const text of input.recentRequests ?? []) {
    for (const word of wordsIn(text)) {
      if (!count.has(word)) order.push(word);
      count.set(word, (count.get(word) ?? 0) + 1);
    }
  }
  // 回数の多い順。同じ回数なら、先に出てきた順（並べ替えは安定）
  const ranked = [...order].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0));
  const out = ranked.slice(0, max);
  if (input.workRoot) {
    const name = basename(input.workRoot);
    // 区切り（- _ .）で分けた語を採る。1 つも採れなければ、名前そのまま
    const parts = wordsIn(name.replace(/[-_.]+/g, ' '));
    for (const word of parts.length > 0 ? parts : [cleanMaterial(name)]) {
      if (out.length >= max) break;
      if (word && !COMMON.has(word.toLowerCase()) && !out.includes(word)) out.push(word);
    }
  }
  return out;
}
