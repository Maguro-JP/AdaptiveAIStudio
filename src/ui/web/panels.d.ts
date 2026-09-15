/** 画面側の素の JS に、型だけ添える。中身は panels.js が持つ。 */

/** 板が受け取る道具立て。 */
export interface PanelContext {
  /** 状態が変わるたびに呼ばれる。 */
  onState(fn: (state: Record<string, unknown>) => void): void;
  /** 名前の付いた出来事を受ける。 */
  on?(name: string, fn: (event: Record<string, unknown>) => void): void;
  /** 入力欄へ移す。 */
  focusInput?(): void;
}

/**
 * 板の作り方。名前ごとに一つ。
 *
 * 戻り値を持たず、渡された箱に中身を足していく形。
 * 検査では最小の DOM を渡して、出た文字列を見る（test/dom-stub.ts）。
 */
export const PANELS: Record<
  string,
  (body: HTMLElement, ctx: PanelContext, spec?: Record<string, unknown>) => void
>;
