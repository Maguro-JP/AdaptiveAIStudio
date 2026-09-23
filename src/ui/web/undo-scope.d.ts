/** 戻り先一つ。画面はここから、戻るもの・戻らないものを数える。 */
export interface UndoRow {
  readonly paths?: readonly string[];
  /** 大きすぎて控えられなかったファイル。戻らない。 */
  readonly skipped?: readonly string[];
}

export declare function willRestore(
  list: ReadonlyArray<UndoRow | undefined>, index: number,
): string[];

export declare function wontRestore(
  list: ReadonlyArray<UndoRow | undefined>, index: number,
): string[];
