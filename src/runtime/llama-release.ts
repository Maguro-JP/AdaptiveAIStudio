/**
 * llama.cpp の配布物から、この機械に合うものを選ぶ。
 *
 * **他人の同梱物に相乗りしない。** これまでは `llama-server` が
 * PATH にある前提で、実質 LM Studio などが入れたものを使っていた。
 * それを消されたら動かなくなる作りは、道具として成立しない。
 *
 * 選ぶところだけを切り出してあるのは、**間違えやすいのがここ**だから。
 * 配布物の名前は版によって揺れる（cu12.2 → cu12.4、avx2 の有無など）。
 * 名前を決め打ちにすると、次の版で静かに壊れる。
 * だから「候補の一覧を受け取って、その中から選ぶ」形にして、
 * 名前の揺れは当てはめの強さで吸収する。
 */

/** 選ぶための手がかり。 */
export interface Target {
  platform: NodeJS.Platform;
  /** process.arch。x64 / arm64 */
  arch: string;
  /** NVIDIA の GPU があるか。無ければ CPU 版を選ぶ。 */
  hasNvidia: boolean;
}

export interface Choice {
  /** 選んだ配布物の名前 */
  name: string;
  /** なぜそれを選んだか。黙って選ぶと、外したときに追えない。 */
  why: string;
}

/**
 * 当てはめの規則。上から順に強い。
 *
 * 「必ず含む語」と「含んではいけない語」の組で書く。
 * 版が変わって新しい語が増えても、これなら生き延びる。
 */
interface Rule {
  need: string[];
  avoid?: string[];
  why: string;
}

function rulesFor(t: Target): Rule[] {
  if (t.platform === 'win32') {
    const cpu: Rule[] = [
      { need: ['win', 'avx2', 'x64'], avoid: ['cuda', 'hip', 'sycl', 'vulkan', 'arm64'], why: 'Windows・CPU（AVX2）' },
      { need: ['win', 'x64'], avoid: ['cuda', 'hip', 'sycl', 'vulkan', 'arm64', 'avx512'], why: 'Windows・CPU' },
    ];
    if (t.arch === 'arm64') {
      return [{ need: ['win', 'arm64'], why: 'Windows・ARM' }, ...cpu];
    }
    return t.hasNvidia
      ? [{ need: ['win', 'cuda', 'x64'], avoid: ['arm64'], why: 'Windows・NVIDIA（CUDA）' }, ...cpu]
      : cpu;
  }

  if (t.platform === 'darwin') {
    return t.arch === 'arm64'
      ? [{ need: ['macos', 'arm64'], why: 'macOS・Apple Silicon' }]
      : [{ need: ['macos', 'x64'], why: 'macOS・Intel' }];
  }

  // Linux。配布物は ubuntu 名義で出ている。
  const cpu: Rule[] = [
    { need: ['ubuntu', 'x64'], avoid: ['cuda', 'hip', 'sycl', 'vulkan', 'arm64'], why: 'Linux・CPU' },
    { need: ['linux', 'x64'], avoid: ['cuda', 'hip', 'sycl', 'vulkan', 'arm64'], why: 'Linux・CPU' },
  ];
  if (t.arch === 'arm64') {
    return [{ need: ['ubuntu', 'arm64'], why: 'Linux・ARM' }, { need: ['linux', 'arm64'], why: 'Linux・ARM' }, ...cpu];
  }
  return t.hasNvidia
    ? [{ need: ['ubuntu', 'cuda', 'x64'], avoid: ['arm64'], why: 'Linux・NVIDIA（CUDA）' }, ...cpu]
    : cpu;
}

/**
 * 候補の中から選ぶ。選べなければ undefined。
 *
 * 同じ規則に複数当たったら、名前が新しそうな方（辞書順で後ろ）を採る。
 * cu12.4 と cu12.2 が並んでいたら、新しい方が概ね正しい。
 */
export function pickAsset(assets: string[], target: Target): Choice | undefined {
  const zips = assets.filter((a) => {
    if (!/\.(zip|tar\.gz|tgz)$/i.test(a)) return false;
    const lower = a.toLowerCase();
    // cudart-*.zip は CUDA の実行時ライブラリだけで、llama-server は入っていない。
    // 名前に cuda を含むので、当てはめだけでは弾けない。
    if (lower.startsWith('cudart')) return false;
    return lower.includes('llama');
  });

  for (const rule of rulesFor(target)) {
    const hit = zips
      .filter((a) => {
        const lower = a.toLowerCase();
        if (!rule.need.every((w) => lower.includes(w))) return false;
        return !(rule.avoid ?? []).some((w) => lower.includes(w));
      })
      .sort();
    const chosen = hit.at(-1);
    if (chosen) return { name: chosen, why: rule.why };
  }
  return undefined;
}

/**
 * CUDA 版に付いてくる相棒を探す。
 *
 * Windows の CUDA 版は、**それ単体では起動しない**。CUDA の実行時ライブラリ
 * （cudart64_*.dll, cublas64_*.dll など）が実行ファイルの隣に要る。
 * 無いと Windows は DLL を解決できずに即座に落ちる。**標準エラーには何も出ない**ので、
 * 「置いたのに、何も言わずに終わる」という分かりにくい形になる。
 *
 * 配布側もそれを前提にしていて、cudart は別の zip として置かれている。
 * 本体と同じ cu の版を選ぶ（cu12.4 の本体に cu11 の cudart を混ぜない）。
 */
export function pickCudart(assets: string[], chosen: string): string | undefined {
  const lower = chosen.toLowerCase();
  if (!lower.includes('win') || !lower.includes('cu')) return undefined;
  // 本体の名前から cu の版を取る（cuda-cu12.4 → cu12.4）
  const ver = /cu(\d+(?:\.\d+)?)/.exec(lower)?.[0];
  if (!ver) return undefined;
  const arch = lower.includes('arm64') ? 'arm64' : 'x64';
  return assets
    .filter((a) => {
      const l = a.toLowerCase();
      return l.startsWith('cudart') && l.endsWith('.zip')
        && l.includes(ver) && l.includes(arch);
    })
    .sort()
    .at(-1);
}

/** いま取ってくる版。上げるときは、ここだけを変える。 */
export const PINNED_TAG = 'b4585';

/** 配布元。公式のリリース一覧。 */
export const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';
