export interface PlacementRow {
  ref?: string; fit?: string; chosen?: string;
  options?: Array<{ id: string; label: string; line: string; isDefault: boolean; chosen: boolean }>;
  alternatives?: Array<{ id: string; kind: string; line: string; downloaded: boolean }>;
}
export declare function placementAlternatives(m: PlacementRow, o?: { say?: (text: string, ok: boolean) => void }): HTMLElement | null;
export declare function placementChoices(m: PlacementRow, o?: { onChange?: () => unknown; say?: (text: string, ok: boolean) => void }): HTMLElement | null;
