// Ctrl-C（SIGINT）が LineSource の止める処理に届くかを見る子。届けば HANDLER と書いてきれいに終わる。
import { LineSource } from '../../src/cli/input.ts';

const rl = new LineSource(process.stdin, process.stdout);
rl.onSigint(() => { process.stdout.write('HANDLER\n'); rl.close(); });
process.stdout.write('READY\n');
await rl.question('> ');
process.stdout.write('ENDED\n');
