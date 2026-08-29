import { spawn } from 'node:child_process';
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

      const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!allowed.has(head)) {
        return fail(`許可されていないコマンドです: ${head}（許可: ${[...allowed].join(', ')}）`);
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

function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  return new Promise<{ content: string; isError?: boolean }>((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = isWindows
      ? spawn(command, { cwd, shell: true })
      : spawn('/bin/sh', ['-c', command], { cwd });

    let out = '';
    let done = false;
    const finish = (result: { content: string; isError?: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(fail(`タイムアウト (${timeoutMs / 1000}秒): ${command}\n${tail(out)}`));
    }, timeoutMs);

    const onAbort = () => { child.kill(); finish(fail('中断されました。')); };
    signal.addEventListener('abort', onAbort, { once: true });

    const append = (buf: Buffer) => {
      out += buf.toString();
      if (out.length > 200_000) out = out.slice(-200_000); // 出力が暴走しても壊れない
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (e) => finish(fail(`実行できません: ${e.message}`)));
    child.on('close', (code) => {
      const body = `終了コード: ${code}\n${tail(out) || '(出力なし)'}`;
      finish(code === 0 ? ok(body) : { content: body, isError: true });
    });
  });
}

function tail(s: string, max = 8000): string {
  return s.length > max ? `...(省略)\n${s.slice(-max)}` : s;
}
