import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unifiedDiff, diffStat } from '../diff.ts';
import { safeResolve, toDisplayPath } from './paths.ts';
import { type Tool, type ToolContext, ok, fail, requireString } from './types.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);
const MAX_READ_BYTES = 400_000;

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'ファイルの内容を読む。行番号つきで返る。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '作業ディレクトリからの相対パス' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    if (!p) return fail('path が必要です。');
    const abs = safeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    try {
      const info = await stat(abs);
      if (info.size > MAX_READ_BYTES) {
        return fail(`ファイルが大きすぎます (${info.size} bytes)。search_text で絞り込んでください。`);
      }
      const text = await readFile(abs, 'utf8');
      const numbered = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      return ok(numbered);
    } catch (e) {
      return fail(`読めません: ${p} (${describe(e)})`);
    }
  },
};

export const listFilesTool: Tool = {
  schema: {
    name: 'list_files',
    description: 'ディレクトリ配下のファイル一覧を返す。node_modules や .git は除外される。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス。省略時は作業ディレクトリ全体' },
      },
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = typeof args.path === 'string' && args.path ? args.path : '.';
    const abs = safeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    const found: string[] = [];
    try {
      await walk(abs, ctx.root, found, 0);
    } catch (e) {
      return fail(`一覧できません: ${p} (${describe(e)})`);
    }
    if (found.length === 0) return ok('(ファイルなし)');
    const shown = found.slice(0, 300);
    const more = found.length > shown.length ? `\n... 他 ${found.length - shown.length} 件` : '';
    return ok(shown.join('\n') + more);
  },
};

export const searchTextTool: Tool = {
  schema: {
    name: 'search_text',
    description: 'ファイル内容を文字列で検索し、該当箇所をファイル名:行番号つきで返す。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索する文字列' },
        path: { type: 'string', description: '検索範囲の相対パス。省略可' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const query = requireString(args, 'query');
    if (!query) return fail('query が必要です。');
    const base = typeof args.path === 'string' && args.path ? args.path : '.';
    const abs = safeResolve(ctx.root, base);
    if (!abs) return fail(`作業ディレクトリの外です: ${base}`);

    const files: string[] = [];
    await walk(abs, ctx.root, files, 0).catch(() => undefined);
    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= 100) break;
      if (ctx.signal.aborted) break;
      const target = safeResolve(ctx.root, rel);
      if (!target) continue;
      try {
        const info = await stat(target);
        if (info.size > MAX_READ_BYTES) continue;
        const text = await readFile(target, 'utf8');
        if (!text.includes(query)) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length < 100 && line.includes(query)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } catch { /* バイナリ等は読み飛ばす */ }
    }
    return ok(hits.length > 0 ? hits.join('\n') : `該当なし: ${query}`);
  },
};

export const writeFileTool: Tool = {
  schema: {
    name: 'write_file',
    description:
      'ファイルを作成または上書きする。内容は全文を渡すこと。実行前に差分が利用者へ提示され、承認が要る。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス' },
        content: { type: 'string', description: 'ファイルの全内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (!p) return fail('path が必要です。');
    if (content === undefined) return fail('content が必要です。');

    const abs = safeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);

    let before = '';
    let created = false;
    try {
      before = await readFile(abs, 'utf8');
    } catch {
      created = true;
    }

    if (before === content) return ok(`変更なし: ${p}`);

    const display = toDisplayPath(ctx.root, abs);
    const diff = unifiedDiff(display, before, content);
    const approved = await ctx.approve({ kind: 'write', path: display, diff, created });
    if (!approved) return fail(`利用者が書き込みを拒否しました: ${p}`);

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    } catch (e) {
      return fail(`書き込めません: ${p} (${describe(e)})`);
    }

    const { added, removed } = diffStat(diff);
    return ok(created ? `作成: ${display}（${added}行）` : `更新: ${display}（+${added} -${removed}）`);
  },
};

async function walk(dir: string, root: string, out: string[], depth: number): Promise<void> {
  if (depth > 12 || out.length >= 3000) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walk(abs, root, out, depth + 1);
    else if (e.isFile()) out.push(toDisplayPath(root, abs));
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
