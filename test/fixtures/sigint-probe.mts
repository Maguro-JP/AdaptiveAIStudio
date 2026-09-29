// Ctrl-C（SIGINT）が LineSource の止める処理に届くかを見る子。届けば HANDLER と書く。
// 引数 stuck のときは、止める処理が詰まった形（読み手を閉じない）にする。二度目の Ctrl-C で終わるかを見る。
import { LineSource } from '../../src/cli/input.ts';

const stuck = process.argv[2] === 'stuck';
const rl = new LineSource(process.stdin, process.stdout);
rl.onSigint(() => { process.stdout.write('HANDLER\n'); if (!stuck) rl.close(); });
process.stdout.write('READY\n');
await rl.question('> ');
process.stdout.write('ENDED\n');
