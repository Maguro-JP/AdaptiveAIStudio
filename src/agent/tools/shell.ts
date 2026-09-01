import { execCommand, tailOf } from '../shell-exec.ts';
import { type Tool, ok, fail, requireString } from './types.ts';

/**
 * 実行を許可するコマンドの先頭語。
 * 「何でも実行できる」にしないための最初の防波堤。設定で追加できる。
 */
export const DEFAULT_ALLOWED_COMMANDS = [
  'npm', 'npx', 'node', 'pnpm', 'yarn',
  'python', 'python3', 'pytest',
  'go', 'cargo', 'dotnet',
  'git', 'ls', 'dir', 'cat', 'type', 'echo',
  'tsc', 'jest', 'vitest',
];

/** 明らかに危険な形。許可リストを通っても弾く。 */
const DANGEROUS = [
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /[;&|`$]\s*(curl|wget|iwr|invoke-webrequest)/i,
  />\s*\/dev\/sd/i,
];

export function createRunCommandTool(opts: {
  allowed?: string[];
  timeoutMs?: number;
}): Tool {
  const allowed = new Set((opts.allowed ?? DEFAULT_ALLOWED_COMMANDS).map((c) => c.toLowerCase()));
  const timeoutMs = opts.timeoutMs ?? 600_000;

  return {
    schema: {
      name: 'run_command',
      description:
        `作業ディレクトリでコマンドを実行し、標準出力と終了コードを返す。` +
        `許可されたコマンドのみ: ${[...allowed].join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '実行するコマンド全体' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const command = requireString(args, 'command');
      if (!command) return fail('command が必要です。');

      // 先頭だけ見ると、`echo x && <何でも>` で防波堤が飾りになる。
      // 繋いだ命令は**一つずつ**先頭を見る。中で別の命令を組み立てる形
      // （$( ) と ` `）は、何が走るか読めないので通さない。
      if (/\$\(|`/.test(command)) {
        return fail(`中で別の命令を組み立てる形は実行しません: ${command}`);
      }
      for (const part of splitChain(command)) {
        const head = part.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!allowed.has(head)) {
          return fail(`許可されていないコマンドです: ${head}（許可: ${[...allowed].join(', ')}）`);
        }
      }
      for (const pattern of DANGEROUS) {
        if (pattern.test(command)) return fail(`危険と判断したため実行しません: ${command}`);
      }

      const approved = await ctx.approve({ kind: 'command', command });
      if (!approved) return fail(`利用者がコマンド実行を拒否しました: ${command}`);

      return runShell(command, ctx.root, timeoutMs, ctx.signal);
    },
  };
}

/**
 * 繋いだ命令を、命令ごとに分ける。
 *
 * `&&` `||` `;` `|` `&` と改行で切る。`2>&1` の `&` は繋ぎではないので
 * 切らない（`>` の直後の `&` は除く）。
 */
export function splitChain(command: string): string[] {
  return command
    .split(/\|\||&&|;|\n|\|(?!&)|(?<![>])&(?!&)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  const r = await execCommand(command, cwd, timeoutMs, signal);
  if (r.aborted) return fail('中断されました。');
  if (r.timedOut) return fail(`タイムアウト (${timeoutMs / 1000}秒): ${command}\n${tailOf(r.output, 8000)}`);
  const body = `終了コード: ${r.code}\n${tailOf(r.output, 8000) || '(出力なし)'}`;
  return r.code === 0 ? ok(body) : { content: body, isError: true };
}
