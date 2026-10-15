/**
 * いま開いている所を、AI に渡せる形にする。
 *
 * **AI は、開いているファイルも選んでいる所も知らなかった。**
 * 人は画面を見ながら「この関数を直して」と打つので、指せているつもりになる。
 * 実際には何も渡っていないので、AI は当てずっぽうで探すか、訊き返すしかない。
 *
 * 渡すのは**名前・カーソルの行・選んでいる字**だけ。中身は丸ごと渡さない。
 * 毎回コンテキストウィンドウを食うし、読みたければ `read_file` を呼べる。
 * 選んでいる字も上限で切る（長い選択をそのまま積むと、依頼が末尾に押しやられる）。
 *
 * ここは**画面から来たもの**なので、そのまま信じない。形だけを見て、
 * 知らない項目は落とす（`editorHere`）。
 */

/** 画面から来た「いま開いている所」。 */
export interface EditorHere {
  /** 作業場からの相対の道。 */
  path: string;
  /** カーソルの行（1 から）。 */
  line?: number;
  /** 選んでいる字。 */
  selection?: string;
  selectionFrom?: number;
  selectionTo?: number;
  /** 保存していない直しが在るか。 */
  dirty?: boolean;
}

/** 道に使える形か。よそ（`..` や絶対の道）は受け取らない。 */
function looksLikePath(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const path = v.trim();
  if (path.length === 0 || path.length > 400) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

const positive = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 10_000_000 ? v : undefined);

/**
 * 画面から来たものを、形だけ見て受け取る。
 *
 * **落とすものは黙って落とす。**ここで断ると、開いている所が渡らないだけで
 * 依頼そのものは通る（送れなくする方が困る）。
 */
export function editorHere(raw: unknown): EditorHere | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (!looksLikePath(v.path)) return undefined;
  const line = positive(v.line);
  const selection = typeof v.selection === 'string' && v.selection.length > 0 ? v.selection : undefined;
  return {
    path: v.path.trim(),
    ...(line === undefined ? {} : { line }),
    ...(selection === undefined ? {} : { selection }),
    ...(positive(v.selectionFrom) === undefined ? {} : { selectionFrom: positive(v.selectionFrom)! }),
    ...(positive(v.selectionTo) === undefined ? {} : { selectionTo: positive(v.selectionTo)! }),
    ...(v.dirty === true ? { dirty: true } : {}),
  };
}

/**
 * 人が読んでも分かる一塊にする。AI へは依頼の前に置く。
 *
 * 選んでいる字は `chars` で切る。切ったことは書く（黙って切ると、AI は
 * 全部を見たつもりで答える）。
 */
export function describeEditorHere(here: EditorHere | undefined, chars = 2000): string {
  if (!here) return '';
  const head = `【いま開いているファイル】${here.path}`
    + (here.line === undefined ? '' : `（${here.line} 行目）`)
    + (here.dirty ? '（保存していない直しがあります）' : '');
  if (here.selection === undefined) return head;
  const range = here.selectionFrom !== undefined && here.selectionTo !== undefined
    ? `${here.selectionFrom}〜${here.selectionTo} 行目`
    : '選んでいる所';
  const cut = here.selection.length > chars;
  const body = cut ? `${here.selection.slice(0, chars)}\n…（ここで切りました。続きは read_file で読めます）` : here.selection;
  // 選んだ字の中に ``` があると、そこで塊が閉じて残りが依頼の地の文になる。中の一番長い ` の連なりより長い囲みにする
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${head}\n【選んでいる所】${range}\n${fence}\n${body}\n${fence}`;
}
