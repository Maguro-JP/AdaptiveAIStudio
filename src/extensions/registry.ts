/**
 * 拡張機能の入れ物（docs/EXTENSIONS.md）。
 *
 * 拡張機能は、本体に同梱した機能のうち、設定で入り切りできるもの。ここに在る固定の一覧だけが拡張機能で、
 * 外からコードや CSS を読み込む経路は作らない（見た目は tokens と effects に従う。画面を書き換える経路を増やさないため）。
 *
 * - 入り切りは設定の `extensions.<id>.enabled`。書いていなければ `defaultEnabled`
 * - 切ると、パネルの種類が画面の一覧から消え、API（`apiPrefix` の下）は 404 を返す
 * - データは AAS_HOME のデータの下の `extensions/<dataDir>/`。切っても消さない（入れ直すと戻る）。
 *   消すのは `npm run clean`（切ってある拡張機能のデータだけを一覧に出し、`--yes` で消す）
 */
import { join } from 'node:path';
import { stateDir } from '../core/home.ts';

export interface ExtensionSpec {
  /** 設定の鍵（`extensions.<id>`）。英小文字と数字とハイフン。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** 設定の画面に出す 1 行の説明。 */
  description: string;
  /** パネルの種類（`src/ui/layout.ts` の `PANEL_KINDS` に在るもの）。 */
  panel: string;
  /** API の接頭辞。この下の口は、切ってある間 404 を返す。 */
  apiPrefix: string;
  /** データのフォルダの名前（`extensions/` の下）。 */
  dataDir: string;
  /** 設定に書いていないときの入り切り。 */
  defaultEnabled: boolean;
}

/** 同梱の拡張機能。足すときはここに 1 行（docs/EXTENSIONS.md の手順）。 */
export const EXTENSIONS: readonly ExtensionSpec[] = [
  {
    id: 'ideas',
    name: 'アイデア',
    description: '今の作業の語と、外の世界の仕組みを掛け合わせて、アイデアの札を出します（モデルもネットワークも要りません）',
    panel: 'ideas',
    apiPrefix: '/api/ideas',
    dataDir: 'ideas',
    defaultEnabled: true,
  },
];

/** 設定のうち、拡張機能が読む部分。 */
export interface ExtensionsConfig { extensions?: Record<string, { enabled?: boolean } | undefined> }

export function extensionById(id: string): ExtensionSpec | undefined {
  return EXTENSIONS.find((e) => e.id === id);
}

/** 入っているか。設定に `enabled` が真偽で書いてあればそれ、無ければ既定。一覧に無い id は入っていない。 */
export function extensionEnabled(config: ExtensionsConfig | undefined, id: string): boolean {
  const spec = extensionById(id);
  if (!spec) return false;
  const set = config?.extensions?.[id]?.enabled;
  return typeof set === 'boolean' ? set : spec.defaultEnabled;
}

/** その道が、どの拡張機能の API か。接頭辞そのものか、その下（`/api/ideas/…`）。`/api/ideasx` は違う。 */
export function extensionForPath(path: string): ExtensionSpec | undefined {
  return EXTENSIONS.find((e) => path === e.apiPrefix || path.startsWith(`${e.apiPrefix}/`));
}

/** 切ってある拡張機能のパネルの種類。画面はこれを一覧に出さず、並びからも外す。 */
export function offPanelKinds(config: ExtensionsConfig | undefined): string[] {
  return EXTENSIONS.filter((e) => !extensionEnabled(config, e.id)).map((e) => e.panel);
}

/** 拡張機能のデータを置くフォルダ（AAS_HOME のデータの下）。 */
export function extensionDataDir(id: string, root?: string): string {
  const spec = extensionById(id);
  if (!spec) throw new Error(`知らない拡張機能です: ${id}`);
  return join(stateDir(root), 'extensions', spec.dataDir);
}

/** 設定の画面と doctor に出す一覧。 */
export function listExtensions(config: ExtensionsConfig | undefined): Array<ExtensionSpec & { enabled: boolean }> {
  return EXTENSIONS.map((e) => ({ ...e, enabled: extensionEnabled(config, e.id) }));
}
