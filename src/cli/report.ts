/**
 * 困ったときに送るものを、一つのファイルにまとめる。
 *
 * ここまで、診断の結果・テストの結果・本体の記録・設定は別々の場所にあり、
 * 利用者が画面から文字を拾ったり、ファイルを何枚も送ったりしていた
 * （実際に doctor の記録を 10 枚以上送ってもらうことになった）。
 * 不具合の報告に要るものは決まっている。版・機械・設定（トークンは名前だけ）・
 * モデル・doctor・直近の記録・直近の点検の結果。**押したら一つ出る**。
 *
 * 使い方: node src/cli/report.ts   （画面の 診断 → 「ここまでの記録を一つにまとめる」から）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { currentVersion, describeVersion } from '../core/version.ts';
import { aasHome, stateDir, productRoot, modelsDir } from '../core/home.ts';
import { configPath } from '../config.ts';
import { listGguf } from '../runtime/inproc.ts';
import { saveReport, tellWhereItWent, plain } from './report-file.ts';
import { needsStripFlag } from '../core/node-flags.ts';

const say = (line = ''): void => { console.log(line); };

/**
 * トークンの値を出さない。名前が key / token / secret / password を含む項目は伏せる。
 * 設定は envFrom で名前しか書かない作りだが、他所から持ってきた設定に値が
 * 書いてあることはある。報告は外へ出すものなので、機械的に伏せる。
 */
export function redactSecrets(text: string): string {
  return text.replace(/("([^"\\]*(key|token|secret|password|passwd|credential)[^"\\]*)"\s*:\s*)"[^"]*"/gi, '$1"（伏せました）"');
}

async function tailOf(path: string, lines: number): Promise<string> {
  const text = await readFile(path, 'utf8').catch(() => '');
  if (!text) return '（無し）';
  const all = text.replace(/\n$/, '').split('\n');
  const cut = all.slice(-lines);
  return (all.length > lines ? `（先頭 ${all.length - lines} 行は省きました）\n` : '') + cut.join('\n');
}

/**
 * 直近の doctor は、新しければ使い回す。
 *
 * doctor は実機で 1〜2 分かかる。サポート用レポートを押すたびに回すと、
 * その間ずっと待たせる。直近に回した結果が新しければ、それを使う。
 * 古ければ回す（機械の様子が変わっているかもしれないので）。
 */
export const DOCTOR_REUSE_MS = 10 * 60_000;

async function recentDoctor(
  dirs: string[], maxAgeMs: number, now = Date.now(),
): Promise<{ text: string; ageMs: number; file: string } | undefined> {
  let best: { file: string; mtime: number } | undefined;
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const f of names) {
      // doctor-YYYYMMDD-HHMM.txt。自分（report-）や他の点検は見ない。
      if (!/^doctor-\d{8}-\d{4}\.txt$/.test(f)) continue;
      const at = join(dir, f);
      const st = await stat(at).catch(() => undefined);
      if (!st) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file: at, mtime: st.mtimeMs };
    }
  }
  if (!best) return undefined;
  const ageMs = now - best.mtime;
  if (ageMs > maxAgeMs) return undefined;
  const text = await readFile(best.file, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : { text, ageMs, file: best.file };
}

/** 直近の点検の結果。reports/ の中で、名前ごとにいちばん新しいもの。 */
async function latestReports(dir: string): Promise<{ name: string; file: string }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = new Map<string, string>();
  for (const f of names.filter((n) => n.endsWith('.txt')).sort()) {
    const name = f.replace(/-\d{8}-\d{4}\.txt$/, '');
    newest.set(name, f); // 名前順＝時刻順なので、後のものが残る
  }
  return [...newest.entries()].map(([name, file]) => ({ name, file: join(dir, file) }));
}

/** doctor をその場で回す。時間がかかるので、進み具合は流す。 */
function runDoctor(root: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
    const child = spawn(process.execPath, [...flags, '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')], {
      cwd: root, env: { ...env, NO_COLOR: '1' },
    });
    let out = '';
    const take = (b: Buffer) => { out += b.toString('utf8'); process.stdout.write(b); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => { child.kill(); out += `\n（${Math.round(timeoutMs / 1000)} 秒で打ち切りました）\n`; }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(plain(out)); });
    child.on('error', (e) => { clearTimeout(timer); resolve(`${out}\n（doctor を起こせませんでした: ${e.message}）`); });
  });
}

export async function buildReport(opts: {
  root: string; state: string; home: string; models: string;
  doctor?: (root: string) => Promise<string>;
  /** 直近の doctor をどれだけ古くまで使い回すか。既定 `DOCTOR_REUSE_MS`。 */
  doctorMaxAgeMs?: number;
}): Promise<string> {
  const parts: string[] = [];
  const section = (title: string, body: string) => { parts.push(`## ${title}`, '', body.trimEnd(), ''); };

  const v = await currentVersion().catch(() => undefined);
  section('版', [
    `版: ${v ? describeVersion(v) : '（読めませんでした）'}`,
    `Node: ${process.version}`,
    `OS: ${platform()} ${release()} ${arch()}`,
    `CPU: ${cpus().length} 本 / RAM ${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
    `program: ${opts.root}`,
    `home: ${opts.home}`,
  ].join('\n'));

  const machine = await readFile(join(opts.state, 'machine.json'), 'utf8').catch(() => '（無し）');
  section('機械（machine.json）', machine);

  const cfgAt = configPath();
  const cfg = await readFile(cfgAt, 'utf8').catch(() => '（無し。既定のまま）');
  section(`設定（${cfgAt}）`, redactSecrets(cfg));

  const models = await listGguf(opts.models).catch(() => []);
  section(`モデル（${opts.models}）`, models.length
    ? models.map((m) => `${m.ref}  ${((m.sizeBytes ?? 0) / 1024 ** 3).toFixed(2)} GB`).join('\n')
    : '（GGUF はありません）');

  // 直近の doctor が新しければ、使い回す（毎回 1〜2 分待たせない）。
  const reuseMs = opts.doctorMaxAgeMs ?? DOCTOR_REUSE_MS;
  const cached = await recentDoctor([join(opts.state, 'reports'), opts.state], reuseMs);
  let doctorBody: string;
  if (cached) {
    const min = Math.round(cached.ageMs / 60_000);
    say(`… 直近の doctor（${min} 分前）を使い回します（押してすぐ出すため）`);
    doctorBody = `直近の doctor（${min} 分前・${cached.file}）を使い回しました。`
      + '押してすぐ出すため、その場では回していません。'
      + '新しく見たいときは、診断 → 「この環境を見てもらう」を回してから、もう一度作ってください。'
      + `\n\n${cached.text}`;
  } else {
    say('… doctor を回します（この機械では 1〜2 分かかります）');
    const out = await (opts.doctor ?? ((root) => runDoctor(root, { ...process.env, AAS_REPORT_DIR: join(opts.state, 'reports') }, 240_000)))(opts.root);
    doctorBody = `その場で doctor を回しました。\n\n${out}`;
  }
  section('doctor', doctorBody);

  section('直近の記録（logs/ui.log の末尾）', await tailOf(join(opts.state, 'logs', 'ui.log'), 400));
  section('直近の操作（audit.jsonl の末尾）', await tailOf(join(opts.state, 'audit.jsonl'), 50));

  const reports = await latestReports(join(opts.state, 'reports'));
  for (const r of reports) {
    if (r.name === 'report' || r.name === 'doctor') continue; // 自分自身と、いま回した doctor
    const st = await stat(r.file).catch(() => undefined);
    section(`直近の点検: ${r.name}（${r.file}${st ? `、${st.mtime.toISOString()}` : ''}）`, await tailOf(r.file, 400));
  }
  if (reports.length === 0) section('直近の点検', '（まだ回していません）');

  return ['AdaptiveAIStudio — 困ったときの報告', '', ...parts].join('\n');
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && (process.argv[1] === here || process.argv[1].endsWith('report.ts'))) {
  const root = productRoot();
  const state = stateDir();
  say('AdaptiveAIStudio — 困ったときの報告をまとめます');
  say();
  const body = await buildReport({ root: join(root, ...(await stat(join(root, 'app', 'src')).then(() => ['app']).catch(() => []))), state, home: aasHome(), models: modelsDir() });
  say();
  for (const line of tellWhereItWent(await saveReport('report', body, [root, state]))) say(`  ${line}`);
  say();
}
