import type { ModelId } from '../model/ModelDescriptor.js';

export type TaskKind =
  | 'chat'
  | 'code_generation'
  | 'code_review'
  | 'refactor'
  | 'test_generation'
  | 'documentation';

export interface RoutingPolicy {
  /** タスク種別ごとの候補列。先頭が primary、以降がフォールバック順。 */
  byTask: Partial<Record<TaskKind, ModelId[]>>;
  /** byTask に定義が無いタスクで使う既定の候補列。 */
  default: ModelId[];
}
