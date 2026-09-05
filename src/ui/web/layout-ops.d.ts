/** 画面側の素の JS に、型だけ添える。中身は layout-ops.js が持つ。 */
import type { Layout, LayoutNode, PanelKind } from '../layout.ts';

export function panelsInUse(node: LayoutNode | null | undefined, out?: string[]): string[];
export function closePanel(layout: Layout, id: string): Layout;
export function openPanel(layout: Layout, kind: PanelKind, title?: string): Layout;
export const DROPS: readonly ['left', 'right', 'top', 'bottom', 'tab'];
export function movePanel(
  layout: Layout, id: string, targetId: string,
  where: 'left' | 'right' | 'top' | 'bottom' | 'tab',
): Layout;
