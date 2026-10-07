/**
 * 依存の棚卸し。
 *
 * 外の情報を取りに行かせる前に、**手元を数える**。
 * 「何か新しい話は無いか」と漠然と外へ出しても、雑音しか持ち帰らない。
 * 「この 12 個の依存のうち、どれが古いか」なら、答えは一つに定まる。
 *
 * ここでは外に出ない。宣言と、実際に入っている版を突き合わせるだけ。
 * それだけで、外に何を訊けばいいかが決まる。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DependencyFact {
  name: string;
  /** package.json に書かれている範囲 */
  declared: string;
  /** node_modules に実際に入っている版 */
  installed?: string;
  dev: boolean;
}

export interface DependencyReport {
  /** 依存を宣言しているファイル */
  manifest?: string;
  deps: DependencyFact[];
  /** 動かしている実行環境 */
  runtime: string;
  /** package.json の engines */
  engines?: Record<string, string>;
  /** node 以外の宣言ファイル。数だけ見て、あることを伝える。 */
  others: string[];
  /** package.json は在るのに読めなかった理由。「無い」と分けて言う */
  unreadable?: string;
}

const OTHER_MANIFESTS = [
  'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json',
];

/** 依存を数える。読めないものは黙って飛ばす。無いことは異常ではない。 */
export async function inspectDependencies(root: string): Promise<DependencyReport> {
  const report: DependencyReport = {
    deps: [],
    runtime: `node ${process.versions.node}`,
    others: [],
  };

  for (const name of OTHER_MANIFESTS) {
    try {
      await readFile(join(root, name), 'utf8');
      report.others.push(name);
    } catch { /* 無いのが普通 */ }
  }

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  let text: string;
  try {
    text = await readFile(join(root, 'package.json'), 'utf8');
  } catch {
    return report; // 無い
  }
  try {
    // 頭の BOM は落とす（PowerShell 5 などが付ける。付いたままだと解けず、「依存の宣言は見つかりませんでした」と誤った事実を渡していた）
    pkg = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    report.manifest = 'package.json';
    report.unreadable = e instanceof Error ? e.message : String(e);
    return report;
  }

  report.manifest = 'package.json';
  report.engines = pkg.engines;

  const entries: Array<[string, string, boolean]> = [
    ...Object.entries(pkg.dependencies ?? {}).map(([n, v]) => [n, v, false] as [string, string, boolean]),
    ...Object.entries(pkg.devDependencies ?? {}).map(([n, v]) => [n, v, true] as [string, string, boolean]),
  ];

  for (const [name, declared, dev] of entries) {
    const fact: DependencyFact = { name, declared, dev };
    try {
      const installed = JSON.parse(
        await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version?: string };
      if (typeof installed.version === 'string') fact.installed = installed.version;
    } catch { /* 入れていないこともある。それも事実。 */ }
    report.deps.push(fact);
  }

  return report;
}

/**
 * 外へ出る前に渡す下書き。
 *
 * 何を訊きに行くかを、こちらで決めてしまう。
 * 決めずに出すと「最近の話題」を持ち帰ってくる。それは要らない。
 */
export function describeDependencies(report: DependencyReport, max = 12): string {
  const lines: string[] = ['# 手元で数えた事実'];
  lines.push(`実行環境: ${report.runtime}`);
  if (report.engines) {
    lines.push(`要求している環境: ${Object.entries(report.engines).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }

  if (report.unreadable !== undefined) {
    lines.push(`package.json は在りますが、読めませんでした（${report.unreadable}）。依存は数えていません。`);
  } else if (report.deps.length === 0) {
    lines.push('依存の宣言は見つかりませんでした。');
  } else {
    lines.push('', `依存 ${report.deps.length} 件（宣言 / 実際に入っている版）:`);
    for (const d of report.deps.slice(0, max)) {
      lines.push(`  ${d.name}  ${d.declared} / ${d.installed ?? '未導入'}${d.dev ? '  (開発用)' : ''}`);
    }
    if (report.deps.length > max) lines.push(`  …他 ${report.deps.length - max} 件`);
  }

  if (report.others.length > 0) {
    lines.push('', `node 以外の宣言もあります: ${report.others.join(', ')}`);
  }

  lines.push(
    '',
    '# 訊きに行くなら',
    'この一覧のうち、気になるものを**一つだけ**選んで確かめてください。',
    '  最新版        https://registry.npmjs.org/<名前>/latest',
    '  既知の脆弱性  https://api.osv.dev/v1/query （POST は使えないので、分かる範囲で）',
    '  変更点        https://api.github.com/repos/<所有者>/<名前>/releases/latest',
    '全部を調べようとしないこと。一件を確かめて、この場所にどう関係するかまで書く方が役に立ちます。',
  );
  return lines.join('\n');
}
