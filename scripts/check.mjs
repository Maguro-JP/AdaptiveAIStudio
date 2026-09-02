/**
 * 型検査と検査を、続けて回す。
 *
 * `npm run typecheck && npm test` と書くと npm 無しでは動かせない
 * （scripts/run.mjs は node 一つで仕事を起こす作り。`&&` は shell の言葉）。
 * だから node で順に起こす。片方でも落ちたら、その終了コードで終わる。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(label, args) {
  console.log(`\n== ${label}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
  return r.status ?? 1;
}

const typecheck = run('型検査', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
if (typecheck !== 0) process.exit(typecheck);
process.exit(run('検査', [join(root, 'scripts', 'run-tests.mjs')]));
