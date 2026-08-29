/**
 * ハーネスの組み立て。
 * どの規則を効かせるかを設定から決める。
 */
import { join } from 'node:path';
import type { AasConfig } from '../config.ts';
import { Harness, type HarnessDecision } from '../harness/harness.ts';
import { AuditLog } from '../harness/audit.ts';
import type { Rule } from '../harness/rules.ts';
import {
  workspaceBoundary, protectedPaths, testProtection, blastRadius,
  readBeforeWrite, noRepeatedWrites, dangerousCommands,
} from '../harness/builtin-rules.ts';
import { stateDir } from './autopilot-setup.ts';

/** 既定で保護するもの。触れて得より害が大きいファイル。 */
const DEFAULT_PROTECTED = [
  '.env', '.env.*',
  '**/*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  '.git/**',
  '**/id_rsa', '**/*.pem', '**/credentials*',
];

export function buildHarness(
  config: AasConfig,
  onDecision?: (e: HarnessDecision) => void,
): Harness {
  const hc = config.harness ?? {};
  const audit = new AuditLog(hc.auditLog ?? join(stateDir(), 'audit.jsonl'));

  const rules: Rule[] = [];
  if (hc.enabled !== false) {
    rules.push(workspaceBoundary);
    rules.push(protectedPaths([...DEFAULT_PROTECTED, ...(hc.protectedPaths ?? [])]));
    rules.push(testProtection);
    rules.push(dangerousCommands);
    rules.push(noRepeatedWrites);
    if (hc.readBeforeWrite !== false) rules.push(readBeforeWrite);
    if (hc.maxFilesPerTask && hc.maxFilesPerTask > 0) rules.push(blastRadius(hc.maxFilesPerTask));
  }

  return new Harness({ rules, audit, onDecision });
}
