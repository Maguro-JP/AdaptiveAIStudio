/**
 * 繋ぎ先の見本帳。
 *
 * MCP は繋ぎ方が決まっている。決まっているのに、繋ぐたびに
 * 「命令は何で、引数は何で、合言葉はどの名前で渡すのか」を人に書かせていた。
 * **形が決まっているものは、こちらが持っておく。**
 *
 * ここに在るものは、名前を一つ言えば繋がる（合言葉が要るものは、それだけ訊く）。
 *
 * **推測で並べない。**ここに書いた名前は npm で在ることを確かめてある
 * （確かめた日: 2026-09-04）。廃止されたものは `retired` を立てて、
 * 黙って消さずに理由を言う。消すと「昨日まで在ったものが無い」になる。
 */

export interface Secret {
  /** 環境に置く名前。設定ファイルにも画面にも、値は出さない。 */
  env: string;
  /** 何を入れるものか。人に見せる。 */
  about: string;
  /** どこで取るか。 */
  where?: string;
}

export interface CatalogEntry {
  id: string;
  /** 表に出す名前。**訳さない。** */
  name: string;
  /** 何ができるか。一行。 */
  about: string;
  /** 手元で立ち上げる（stdio） */
  command?: string;
  args?: string[];
  /** 遠くに繋ぐ（Streamable HTTP） */
  url?: string;
  envFrom?: Record<string, string>;
  headersFrom?: Record<string, string>;
  secrets?: Secret[];
  /** 立ち上げに npm（npx）が要るか。要るものは、入れた機械では動かない。 */
  needsNpx?: boolean;
  /** 廃止されたもの。繋げはするが、そう言う。 */
  retired?: string;
  /** 引数に、作業場などを埋める必要があるか。 */
  wantsRoot?: boolean;
}

const npx = (pkg: string, ...rest: string[]) => ({
  command: 'npx', args: ['-y', pkg, ...rest], needsNpx: true,
});

/**
 * 見本帳。
 *
 * 順は、使う頻度の見当。上から出す。
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    about: 'issue と PR を読み書きする。コードも検索できる',
    // 遠くの相手。**これが今の本筋。**npm の方は廃止されている。
    url: 'https://api.githubcopilot.com/mcp/',
    headersFrom: { Authorization: 'GITHUB_TOKEN' },
    secrets: [{
      env: 'GITHUB_TOKEN',
      about: 'GitHub の合言葉（personal access token）',
      where: 'https://github.com/settings/tokens',
    }],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    about: '決めた場所のファイルを読み書きする',
    ...npx('@modelcontextprotocol/server-filesystem'),
    wantsRoot: true,
  },
  {
    id: 'memory',
    name: 'Memory',
    about: '覚えておく（知識のかたまりとして貯める）',
    ...npx('@modelcontextprotocol/server-memory'),
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    about: '考えを段に分けて進める',
    ...npx('@modelcontextprotocol/server-sequential-thinking'),
  },
  {
    id: 'playwright',
    name: 'Playwright',
    about: 'ブラウザを開いて、押して回る',
    ...npx('@playwright/mcp@latest'),
  },
  {
    id: 'context7',
    name: 'Context7',
    about: 'ライブラリの、いまの説明書を引く',
    ...npx('@upstash/context7-mcp'),
  },
  {
    id: 'notion',
    name: 'Notion',
    about: 'Notion の頁を読み書きする',
    ...npx('@notionhq/notion-mcp-server'),
    envFrom: { NOTION_TOKEN: 'NOTION_TOKEN' },
    secrets: [{
      env: 'NOTION_TOKEN',
      about: 'Notion の合言葉（integration token）',
      where: 'https://www.notion.so/my-integrations',
    }],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    about: '起きている不具合を見る',
    ...npx('@sentry/mcp-server'),
    envFrom: { SENTRY_ACCESS_TOKEN: 'SENTRY_TOKEN' },
    secrets: [{ env: 'SENTRY_TOKEN', about: 'Sentry の合言葉' }],
  },
  {
    id: 'exa',
    name: 'Exa',
    about: '網を検索して、中身まで取ってくる',
    ...npx('exa-mcp-server'),
    envFrom: { EXA_API_KEY: 'EXA_API_KEY' },
    secrets: [{ env: 'EXA_API_KEY', about: 'Exa の鍵', where: 'https://dashboard.exa.ai' }],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    about: '頁を取ってきて、読める形にする',
    ...npx('firecrawl-mcp'),
    envFrom: { FIRECRAWL_API_KEY: 'FIRECRAWL_API_KEY' },
    secrets: [{ env: 'FIRECRAWL_API_KEY', about: 'Firecrawl の鍵' }],
  },
  {
    id: 'github-local',
    name: 'GitHub（手元で動かす）',
    about: '外へ出られない機械のときは、こちら。同梱してあれば npm も要らない',
    ...npx('@modelcontextprotocol/server-github'),
    envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_TOKEN' },
    secrets: [{ env: 'GITHUB_TOKEN', about: 'GitHub の合言葉（personal access token）' }],
    retired: '作り手側で止まっています（2025年に archived）。動きますが、直りません。',
  },
];

export function findEntry(id: string): CatalogEntry | undefined {
  const want = id.trim().toLowerCase();
  return CATALOG.find((e) => e.id === want)
    ?? CATALOG.find((e) => e.name.toLowerCase() === want);
}

/** 見本帳から、設定に書く形を作る。 */
export function specFrom(entry: CatalogEntry, opts: { root?: string } = {}): {
  command?: string; args?: string[]; url?: string;
  envFrom?: Record<string, string>; headersFrom?: Record<string, string>;
} {
  if (entry.url) {
    return { url: entry.url, ...(entry.headersFrom ? { headersFrom: entry.headersFrom } : {}) };
  }
  const args = [...(entry.args ?? [])];
  // 場所を渡すものには、いまの作業場を入れる。**書かせない。**
  if (entry.wantsRoot && opts.root) args.push(opts.root);
  return {
    command: entry.command ?? 'npx',
    args,
    ...(entry.envFrom ? { envFrom: entry.envFrom } : {}),
  };
}

/** 足りていない合言葉。名前だけを返す（値は見ない）。 */
export function missingSecrets(
  entry: CatalogEntry, env: NodeJS.ProcessEnv = process.env,
): Secret[] {
  return (entry.secrets ?? []).filter((s) => {
    const value = env[s.env];
    return value === undefined || value.trim() === '';
  });
}
