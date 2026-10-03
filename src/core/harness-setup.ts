/**
 * ハーネスの組み立て。
 * どの規則を効かせるかを設定から決める。
 */
import { join } from 'node:path';
import type { AasConfig } from '../config.ts';
import { Harness, type HarnessDecision } from '../harness/harness.ts';
import { AuditLog } from '../harness/audit.ts';
import { HarnessMetrics } from '../harness/metrics.ts';
import type { Rule } from '../harness/rules.ts';
import {
  workspaceBoundary, protectedPaths, testProtection, blastRadius,
  readBeforeWrite, noRepeatedWrites, dangerousCommands, noSelfKill, noCiSpend,
} from '../harness/builtin-rules.ts';
import { type Forum, requiresDeliberation } from '../harness/deliberation.ts';
import { stateDir } from './autopilot-setup.ts';

/**
 * 既定で保護するもの。触れて得より害が大きいファイル。
 * **どの階層でも守る（`**\/` を付ける）。**道は全体で照らすので、付けないと作業場の直下だけに当たる（monorepo の
 * `packages/api/.env` が守りの外だった）。`**\/` は階層が無いものにも当たるので、直下のものも守る。
 */
const DEFAULT_PROTECTED = [
  '**/.env', '**/.env.*',
  '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  // `.git` も、どの階層でも、ファイルとしても守る。直下の `.git/**` だけだったので、作業場の下に置いた別の clone の `.git/config`・hooks や、
  // worktree・submodule の `.git`（`gitdir:` と書かれたファイル）を承認なしで書き換えられた（hook と core.fsmonitor は git を動かした所で命令を走らせる）
  '**/.git', '**/.git/**',
  '**/id_rsa', '**/*.pem', '**/credentials*',
];

/**
 * 大小を区別しないファイルシステムか。
 *
 * Windows と macOS は区別しないので、そこでは `.ENV` も `.env` として守る。
 * **`process.platform` を直に見ない。**直に見ると、Linux で走らせている限り
 * Windows 側の分岐が一度も通らず、配ってから初めて動く。渡せる形にして、
 * どの OS ぶんもここで試せるようにする（`test/harness-setup.test.ts`）。
 */
export function caseBlind(platform: NodeJS.Platform): boolean {
  return platform !== 'linux';
}

export async function buildHarness(
  config: AasConfig,
  onDecision?: (e: HarnessDecision) => void,
  /** 協議の場。渡された場合のみ、重大な変更を協議なしに通さない規則が入る。 */
  forum?: Forum,
  /** どの OS として組むか。既定はいま動いている OS。試験のために渡せる。 */
  platform: NodeJS.Platform = process.platform,
): Promise<Harness> {
  const hc = config.harness ?? {};
  const audit = new AuditLog(hc.auditLog ?? join(stateDir(), 'audit.jsonl'));
  const metrics = new HarnessMetrics(join(stateDir(), 'harness-metrics.json'));
  await metrics.load();

  const rules: Rule[] = [];
  if (hc.enabled !== false) {
    rules.push(workspaceBoundary);
    // Windows と macOS は大小を区別しない。そこでは `.ENV` も `.env` として守る。
    rules.push(protectedPaths(
      [...DEFAULT_PROTECTED, ...(hc.protectedPaths ?? [])],
      { nocase: caseBlind(platform) },
    ));
    rules.push(testProtection);
    rules.push(dangerousCommands);
    // 自分を殺す止め方と、断りのない CI。どちらも実際にやった失敗。
    rules.push(noSelfKill);
    rules.push(noCiSpend);
    rules.push(noRepeatedWrites);
    if (hc.readBeforeWrite !== false) rules.push(readBeforeWrite);
    if (hc.maxFilesPerTask && hc.maxFilesPerTask > 0) rules.push(blastRadius(hc.maxFilesPerTask));
    // 守りの仕掛けそのものへの変更と、広範囲の書き換えは協議を通す。
    if (forum) rules.push(requiresDeliberation({ forum, wideChangeFiles: hc.wideChangeFiles }));
  }

  return new Harness({ rules, audit, metrics, onDecision });
}
